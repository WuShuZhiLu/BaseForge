import type { DatabaseSync } from "node:sqlite";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { resolveKnowledgeNodeAccess } from "./knowledgeCapabilities.js";
import { createKnowledgeChild, KnowledgeTreeError } from "./knowledgeTree.js";
import { duplicateNote } from "./noteDuplicates.js";

interface SourceNodeRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  resourceType: string;
  resourceId: string;
}

interface SubtreeRow {
  id: string;
  parentId: string | null;
  resourceType: string;
  resourceId: string;
}

interface NotebookMetaRow {
  name: string;
  icon: string | null;
  description: string | null;
}

export interface DuplicatedNotebookResult {
  nodeId: string;
  title: string;
  notebookCount: number;
  noteCount: number;
  skippedNoteCount: number;
  skippedFileCount: number;
}

function chunked<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) out.push(items.slice(offset, offset + size));
  return out;
}

function readSubtree(db: DatabaseSync, rootId: string): SubtreeRow[] {
  return db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM knowledge_tree_nodes WHERE id = ? AND isDeleted = 0
      UNION
      SELECT child.id
      FROM knowledge_tree_nodes child
      JOIN subtree parent ON child.parentId = parent.id
      WHERE child.isDeleted = 0
    )
    SELECT node.id, node.parentId, node.resourceType, node.resourceId
    FROM knowledge_tree_nodes node
    JOIN subtree ON subtree.id = node.id
    ORDER BY node.sortOrder, node.id
  `).all(rootId) as unknown as SubtreeRow[];
}

/** 父在前、子在后：深拷贝时先建目录，再往里放内容。 */
function orderSubtree(rootId: string, rows: SubtreeRow[]): SubtreeRow[] {
  const byId = new Map<string, SubtreeRow>();
  const byParent = new Map<string, SubtreeRow[]>();
  for (const row of rows) {
    byId.set(row.id, row);
    if (!row.parentId) continue;
    const list = byParent.get(row.parentId) || [];
    list.push(row);
    byParent.set(row.parentId, list);
  }
  const ordered: SubtreeRow[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const row = byId.get(current);
    if (!row) continue;
    ordered.push(row);
    for (const child of byParent.get(current) || []) queue.push(child.id);
  }
  return ordered;
}

function readNotebookMeta(db: DatabaseSync, notebookId: string): NotebookMetaRow {
  const row = db.prepare("SELECT name, icon, description FROM notebooks WHERE id = ?")
    .get(notebookId) as NotebookMetaRow | undefined;
  return { name: row?.name || "未命名文件夹", icon: row?.icon || null, description: row?.description || null };
}

function duplicateTitleBase(title: string): string {
  const normalized = title.trim() || "未命名文件夹";
  return normalized.replace(/（副本(?: \d+)?）$/u, "") || normalized;
}

function nextNotebookTitle(
  db: DatabaseSync,
  scopeKey: string,
  parentId: string | null,
  title: string,
): string {
  const siblingRows = parentId
    ? db.prepare(`
        SELECT notebook.name AS name
        FROM knowledge_tree_nodes node
        JOIN notebooks notebook ON node.resourceType = 'notebook' AND notebook.id = node.resourceId
        WHERE node.scopeKey = ? AND node.parentId = ? AND node.isDeleted = 0
      `).all(scopeKey, parentId) as Array<{ name: string }>
    : db.prepare(`
        SELECT notebook.name AS name
        FROM knowledge_tree_nodes node
        JOIN notebooks notebook ON node.resourceType = 'notebook' AND notebook.id = node.resourceId
        WHERE node.scopeKey = ? AND node.parentId IS NULL AND node.isDeleted = 0
      `).all(scopeKey) as Array<{ name: string }>;
  const used = new Set(siblingRows.map((row) => row.name));
  const base = duplicateTitleBase(title);
  const first = `${base}（副本）`;
  if (!used.has(first)) return first;
  let index = 2;
  while (used.has(`${base}（副本 ${index}）`)) index += 1;
  return `${base}（副本 ${index}）`;
}

/** 副本与源目录同级：要么在父目录里可新建，要么在工作区根层有编辑权限。 */
function canCreateSibling(
  db: DatabaseSync,
  source: SourceNodeRow,
  userId: string,
): boolean {
  if (source.parentId) {
    return resolveKnowledgeNodeAccess(source.parentId, userId, db).capabilities.canCreate;
  }
  if (!source.workspaceId) return true;
  const member = db.prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(source.workspaceId, userId) as { role: string } | undefined;
  const workspace = db.prepare("SELECT ownerId FROM workspaces WHERE id = ?")
    .get(source.workspaceId) as { ownerId: string } | undefined;
  const role = workspace?.ownerId === userId ? "owner" : member?.role;
  return role === "owner" || role === "admin" || role === "editor";
}

/** 只有能完整复制的文档格式才随目录复制（含导图、画板）；锁定、加密、纯文本等跳过并计数。 */
const COPYABLE_CONTENT_FORMATS = new Set(["markdown", "tiptap-json", "mindmap", "board"]);

function readCopyableNoteIds(db: DatabaseSync, noteIds: string[]): Set<string> {
  const copyable = new Set<string>();
  for (const chunk of chunked(noteIds)) {
    const rows = db.prepare(`
      SELECT id, isLocked, contentFormat FROM notes
      WHERE id IN (${chunk.map(() => "?").join(",")})
    `).all(...chunk) as Array<{ id: string; isLocked: number; contentFormat: string | null }>;
    for (const row of rows) {
      if (row.isLocked === 1) continue;
      if (!COPYABLE_CONTENT_FORMATS.has(row.contentFormat || "")) continue;
      copyable.add(row.id);
    }
  }
  return copyable;
}

function hardDeleteRows(db: DatabaseSync, table: "notes" | "notebooks", ids: string[]): void {
  for (const chunk of chunked(ids)) {
    db.prepare(`DELETE FROM ${table} WHERE id IN (${chunk.map(() => "?").join(",")})`).run(...chunk);
  }
}

/** 复制中途失败时清掉本次新建的行，避免留下半棵树。 */
function rollbackCreatedRows(
  db: DatabaseSync,
  createdNoteIds: string[],
  createdNotebookIds: string[],
): void {
  try {
    db.transaction(() => {
      hardDeleteRows(db, "notes", createdNoteIds);
      // 目录按创建顺序记录，删除要反过来，先删子目录再删父目录。
      hardDeleteRows(db, "notebooks", [...createdNotebookIds].reverse());
    })();
  } catch (error) {
    console.error("[knowledge-tree] notebook duplicate rollback failed:", error);
  }
}

/**
 * 目录深拷贝：把源文件夹/知识库整棵子树复制到同级。
 * 目录结构、文档正文、附件、标签由 duplicateNote / createKnowledgeChild 复用，
 * 文件节点（本地或远端文件实体）不复制。
 */
export async function duplicateKnowledgeNotebook(input: {
  actorUserId: string;
  nodeId: string;
  db?: DatabaseSync;
}): Promise<DuplicatedNotebookResult> {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);

  const source = db.prepare(`
    SELECT id, userId, workspaceId, scopeKey, parentId, resourceType, resourceId
    FROM knowledge_tree_nodes
    WHERE id = ? AND isDeleted = 0
  `).get(input.nodeId) as SourceNodeRow | undefined;
  if (!source || source.resourceType !== "notebook") {
    throw new KnowledgeTreeError("KNOWLEDGE_NODE_NOT_FOUND", 404, "文件夹或知识库不存在");
  }
  if (!resolveKnowledgeNodeAccess(source.id, input.actorUserId, db).capabilities.canView) {
    throw new KnowledgeTreeError("KNOWLEDGE_NODE_NOT_FOUND", 404, "文件夹或知识库不存在");
  }
  if (!canCreateSibling(db, source, input.actorUserId)) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "没有复制该文件夹的权限", {
      required: "canCreate",
    });
  }

  const subtree = orderSubtree(source.id, readSubtree(db, source.id));
  const noteIds = subtree.filter((row) => row.resourceType === "note").map((row) => row.resourceId);
  const copyableNoteIds = readCopyableNoteIds(db, noteIds);

  const nodeIdMap = new Map<string, string>();
  const createdNotebookIds: string[] = [];
  const createdNoteIds: string[] = [];
  let rootNodeId = "";
  let rootTitle = "";
  let noteCount = 0;
  let skippedNoteCount = 0;
  let skippedFileCount = 0;

  try {
    for (const row of subtree) {
      const isRoot = row.id === source.id;
      let parentNodeId: string | null;
      if (isRoot) {
        parentNodeId = source.parentId;
      } else {
        const mapped = row.parentId ? nodeIdMap.get(row.parentId) : undefined;
        // 父节点本身没被复制（文件节点等）时，子树里的内容也没有落点。
        if (!mapped) {
          if (row.resourceType === "note") skippedNoteCount += 1;
          continue;
        }
        parentNodeId = mapped;
      }

      if (row.resourceType === "notebook") {
        const meta = readNotebookMeta(db, row.resourceId);
        const title = isRoot
          ? nextNotebookTitle(db, source.scopeKey, source.parentId, meta.name)
          : meta.name;
        const created = createKnowledgeChild({
          actorUserId: input.actorUserId,
          workspaceId: source.workspaceId,
          parentId: parentNodeId,
          nodeType: "folder",
          title,
          db,
        });
        if (meta.icon || meta.description) {
          db.prepare("UPDATE notebooks SET icon = ?, description = ?, updatedAt = datetime('now') WHERE id = ?")
            .run(meta.icon || "📁", meta.description, created.resourceId);
        }
        nodeIdMap.set(row.id, created.id);
        createdNotebookIds.push(created.resourceId);
        if (isRoot) {
          rootNodeId = created.id;
          rootTitle = title;
        }
        continue;
      }

      if (row.resourceType === "note") {
        if (!copyableNoteIds.has(row.resourceId)) {
          skippedNoteCount += 1;
          continue;
        }
        let duplicated: Awaited<ReturnType<typeof duplicateNote>>;
        try {
          duplicated = await duplicateNote({
            userId: input.actorUserId,
            noteId: row.resourceId,
            targetParentId: parentNodeId,
          });
        } catch (error) {
          // 单篇文档异常（空正文、并发编辑等）不应拖垮整棵目录的复制。
          console.warn("[knowledge-tree] duplicate note skipped:", row.resourceId, error);
          skippedNoteCount += 1;
          continue;
        }
        nodeIdMap.set(row.id, duplicated.node.id);
        createdNoteIds.push(duplicated.node.resourceId);
        noteCount += 1;
        continue;
      }

      // file 节点指向磁盘/远端文件实体，不在目录复制范围内。
      skippedFileCount += 1;
    }
  } catch (error) {
    rollbackCreatedRows(db, createdNoteIds, createdNotebookIds);
    throw error;
  }

  if (!rootNodeId) {
    throw new KnowledgeTreeError("KNOWLEDGE_DUPLICATE_FAILED", 409, "复制失败");
  }

  return {
    nodeId: rootNodeId,
    title: rootTitle,
    notebookCount: createdNotebookIds.length,
    noteCount,
    skippedNoteCount,
    skippedFileCount,
  };
}
