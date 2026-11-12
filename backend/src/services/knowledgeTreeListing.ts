import type { DatabaseSync } from "node:sqlite";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { ensureKnowledgeTreePasswordTable } from "../db/knowledgeTreePasswordMigration.js";
import { resolveKnowledgeNodeAccess } from "./knowledgeCapabilities.js";
import type { KnowledgeTreeNode } from "./knowledgeTreeCore.js";

const ROOT_DOCUMENT_NOTEBOOK_PREFIX = "__baseforge_root_documents__:";
const ROOT_DOCUMENT_NODE_PREFIX = `notebook:${ROOT_DOCUMENT_NOTEBOOK_PREFIX}`;

type ListedNodeRow = Omit<KnowledgeTreeNode, "access">;

function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

const TITLE_EXPRESSION = `CASE
  WHEN node.resourceType = 'notebook' THEN COALESCE(nb.name, '未命名文件夹')
  WHEN node.resourceType = 'note' THEN COALESCE(note.title, '无标题笔记')
  WHEN node.resourceType = 'mindmap' THEN COALESCE(mm.title, node.resourceId)
  WHEN node.resourceType = 'file' THEN COALESCE(file.filename, node.resourceId)
  ELSE node.resourceId
END`;

/**
 * Read the mixed navigation tree without relying on an output alias in ORDER BY.
 * SQLite treats `title` as ambiguous once notes and mindmaps are joined, even when the SELECT
 * list also defines `AS title`; repeating the qualified CASE expression is deterministic.
 */
export function listKnowledgeTree(input: {
  userId: string;
  workspaceId: string | null;
  includeDeleted?: boolean;
  db?: DatabaseSync;
}): KnowledgeTreeNode[] {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  ensureKnowledgeTreePasswordTable(db);
  const key = scopeKey(input.userId, input.workspaceId);
  const rows = db.prepare(`
    SELECT node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
           node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
           node.isExpanded, node.isDeleted, node.deletedAt, node.createdAt, node.updatedAt,
           ${TITLE_EXPRESSION} AS title,
           CASE WHEN node.resourceType = 'notebook' THEN nb.icon ELSE NULL END AS icon,
           CASE WHEN node.resourceType = 'note' THEN COALESCE(note.isPinned, 0) ELSE 0 END AS isPinned,
           CASE WHEN node.resourceType = 'note' AND EXISTS(
             SELECT 1 FROM favorites favorite
             WHERE favorite.noteId = note.id AND favorite.userId = ?
           ) THEN 1 ELSE 0 END AS isFavorite,
           CASE WHEN node.resourceType = 'note' THEN COALESCE(note.isLocked, 0) ELSE 0 END AS isLocked,
           CASE WHEN node.resourceType = 'notebook' AND notebook_password.notebookId IS NOT NULL THEN 1 ELSE 0 END AS isPasswordProtected,
           CASE WHEN node.resourceType = 'note' THEN note.contentFormat ELSE NULL END AS contentFormat,
           CASE WHEN node.resourceType = 'note' THEN note.colorMark ELSE NULL END AS colorMark,
           CASE WHEN node.resourceType = 'note' THEN note.note_type ELSE NULL END AS noteType,
           0 AS childCount
    FROM knowledge_tree_nodes node
    LEFT JOIN notebooks nb ON node.resourceType = 'notebook' AND nb.id = node.resourceId
    LEFT JOIN notebook_passwords notebook_password
      ON node.resourceType = 'notebook' AND notebook_password.notebookId = node.resourceId
    LEFT JOIN notes note ON node.resourceType = 'note' AND note.id = node.resourceId
    LEFT JOIN mindmaps mm ON node.resourceType = 'mindmap' AND mm.id = node.resourceId
    LEFT JOIN files file ON node.resourceType = 'file' AND file.id = node.resourceId
    WHERE node.scopeKey = ? ${input.includeDeleted ? "" : "AND node.isDeleted = 0"}
      AND (node.resourceType <> 'note' OR COALESCE(note.isUnlisted, 0) = 0)
    ORDER BY
      node.parentId IS NOT NULL,
      node.parentId,
      node.sortOrder,
      lower(${TITLE_EXPRESSION}),
      node.id
  `).all(input.userId, key) as ListedNodeRow[];

  const visible = rows
    .filter((row) => !(row.resourceType === "notebook" && row.resourceId.startsWith(ROOT_DOCUMENT_NOTEBOOK_PREFIX)))
    .map((row) => ({
      ...row,
      parentId: row.parentId?.startsWith(ROOT_DOCUMENT_NODE_PREFIX) ? null : row.parentId,
      // includeDeleted is an explicit recycle-bin/history view. Evaluate the
      // tombstone with its original ACL instead of making the flag ineffective.
      // Ordinary tree reads keep includeDeleted=false and still hide tombstones.
      access: resolveKnowledgeNodeAccess(
        row.id,
        input.userId,
        db,
        { includeDeleted: input.includeDeleted === true },
      ),
    }))
    .filter((row) => row.access.capabilities.canView);

  const visibleIds = new Set(visible.map((row) => row.id));
  const visibleChildCounts = new Map<string, number>();
  for (const row of visible) {
    if (!row.parentId || !visibleIds.has(row.parentId)) continue;
    visibleChildCounts.set(row.parentId, (visibleChildCounts.get(row.parentId) || 0) + 1);
  }

  // 复制 = 连接：同一篇文档的其它路径从引用表读出，正文仍然只有一份。
  const accessByNodeId = new Map(visible.map((row) => [row.id, row.access]));
  const referenceRows = db.prepare(`
    SELECT ref.id, ref.userId, ref.workspaceId, ref.scopeKey, ref.parentId,
           ref.resourceId, COALESCE(note.title, ref.title) AS title, ref.sortOrder,
           ref.createdAt, ref.updatedAt,
           note.contentFormat AS contentFormat, note.colorMark AS colorMark,
           note.note_type AS noteType,
           CASE WHEN note.note_type = 'word' THEN 'word'
                WHEN note.contentFormat = 'markdown' THEN 'markdown'
                ELSE 'note' END AS nodeType,
           COALESCE(note.isPinned, 0) AS isPinned,
           COALESCE(note.isLocked, 0) AS isLocked,
           CASE WHEN EXISTS(
             SELECT 1 FROM favorites favorite
             WHERE favorite.noteId = note.id AND favorite.userId = ?
           ) THEN 1 ELSE 0 END AS isFavorite
    FROM knowledge_tree_references ref
    JOIN notes note ON note.id = ref.resourceId
      AND COALESCE(note.isTrashed, 0) = 0
      AND COALESCE(note.isUnlisted, 0) = 0
    JOIN knowledge_tree_nodes parent ON parent.id = ref.parentId AND parent.isDeleted = 0
    WHERE ref.scopeKey = ? AND ref.isDeleted = 0
    ORDER BY ref.parentId, ref.sortOrder, lower(COALESCE(note.title, ref.title)), ref.id
  `).all(input.userId, key) as Array<{
    id: string; userId: string; workspaceId: string | null; scopeKey: string;
    parentId: string; resourceId: string; title: string; sortOrder: number;
    createdAt: string; updatedAt: string; contentFormat: string | null;
    colorMark: string | null; noteType: string | null; nodeType: KnowledgeTreeNode["nodeType"];
    isPinned: number; isLocked: number; isFavorite: number;
  }>;

  const references: KnowledgeTreeNode[] = [];
  for (const row of referenceRows) {
    const parentAccess = accessByNodeId.get(row.parentId);
    if (!parentAccess?.capabilities.canView) continue;
    visibleChildCounts.set(row.parentId, (visibleChildCounts.get(row.parentId) || 0) + 1);
    references.push({
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId,
      scopeKey: row.scopeKey,
      parentId: row.parentId,
      nodeType: row.nodeType,
      resourceType: "note",
      resourceId: row.resourceId,
      title: row.title,
      icon: null,
      isPinned: Number(row.isPinned),
      isFavorite: Number(row.isFavorite),
      isLocked: Number(row.isLocked),
      isPasswordProtected: 0,
      contentFormat: row.contentFormat,
      colorMark: row.colorMark,
      noteType: row.noteType,
      sortOrder: Number(row.sortOrder),
      isExpanded: 0,
      isDeleted: 0,
      deletedAt: null,
      childCount: 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      access: parentAccess,
      isReference: true,
    });
  }

  const nodes = visible.map((row) => ({
    ...row,
    // A directly shared descendant must remain reachable even when its restricted
    // ancestor is hidden. Promote it to a visible root instead of leaking the
    // ancestor title or leaving an orphaned parent reference.
    parentId: row.parentId && visibleIds.has(row.parentId) ? row.parentId : null,
    childCount: visibleChildCounts.get(row.id) || 0,
  }));
  return [...nodes, ...references];
}
