import { validateSheetData } from "./sheetData.js";
import type { DatabaseSync } from "node:sqlite";
import { v4 as uuid } from "uuid";
import { defaultMindmapContent } from "../lib/mindmapData.js";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { MINDMAP_LEGACY_NOTEBOOK_PREFIX } from "../db/knowledgeTreeMindmapFolderMigration.js";
import {
  hasKnowledgeCapability,
  resolveKnowledgeNodeAccess,
  type EffectiveKnowledgeAccess,
  type KnowledgeCapabilityName,
} from "./knowledgeCapabilities.js";
import { resolveSharedKnowledgeRoot } from "./sharedKnowledgeTreeBoundary.js";

export type KnowledgeNodeType = "folder" | "note" | "markdown" | "word" | "mindmap" | "file";
export type KnowledgeResourceType = "notebook" | "note" | "mindmap" | "file";
export type KnowledgeDeleteMode = "subtree" | "promote";

export interface KnowledgeTreeNode {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  nodeType: KnowledgeNodeType;
  resourceType: KnowledgeResourceType;
  resourceId: string;
  title: string;
  icon?: string | null;
  isPinned?: number;
  isFavorite?: number;
  isLocked?: number;
  isPasswordProtected?: number;
  contentFormat?: string | null;
  colorMark?: string | null;
  noteType?: string | null;
  sortOrder: number;
  isExpanded: number;
  isDeleted: number;
  deletedAt: string | null;
  childCount: number;
  createdAt: string;
  updatedAt: string;
  access: EffectiveKnowledgeAccess;
  /** 该行是指向同一篇笔记的引用（复制 = 连接），不是笔记的物理位置。 */
  isReference?: boolean;
}

type NodeRow = Omit<KnowledgeTreeNode, "title" | "childCount" | "access">;

export class KnowledgeTreeError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

function readNode(db: DatabaseSync, nodeId: string, includeDeleted = false): NodeRow | null {
  return (db.prepare(`
    SELECT id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
           resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    FROM knowledge_tree_nodes
    WHERE id = ? ${includeDeleted ? "" : "AND isDeleted = 0"}
  `).get(nodeId) as NodeRow | undefined) || null;
}

function requireNode(db: DatabaseSync, nodeId: string, includeDeleted = false): NodeRow {
  const node = readNode(db, nodeId, includeDeleted);
  if (!node) throw new KnowledgeTreeError("KNOWLEDGE_NODE_NOT_FOUND", 404, "内容节点不存在");
  return node;
}

function requireCapability(
  db: DatabaseSync,
  nodeId: string,
  userId: string,
  capability: KnowledgeCapabilityName,
): EffectiveKnowledgeAccess {
  const access = resolveKnowledgeNodeAccess(nodeId, userId, db);
  if (!hasKnowledgeCapability(access, capability)) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "权限不足", {
      nodeId,
      required: capability,
      source: access.source,
    });
  }
  return access;
}

function workspaceRootAccess(db: DatabaseSync, userId: string, workspaceId: string | null): EffectiveKnowledgeAccess {
  if (!workspaceId) {
    return {
      nodeId: "",
      rolePreset: "admin",
      source: "owner",
      sourceNodeId: null,
      capabilities: {
        canView: true,
        canComment: true,
        canCreate: true,
        canEdit: true,
        canDelete: true,
        canMove: true,
        canDownload: true,
        canReshare: true,
        canManageMembers: true,
      },
    };
  }
  const row = db.prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(workspaceId, userId) as { role: string } | undefined;
  const owner = db.prepare("SELECT ownerId FROM workspaces WHERE id = ?")
    .get(workspaceId) as { ownerId: string } | undefined;
  const role = owner?.ownerId === userId ? "owner" : row?.role;
  const admin = role === "owner" || role === "admin";
  const editor = admin || role === "editor";
  return {
    nodeId: "",
    rolePreset: admin ? "admin" : editor ? "editor" : role === "commenter" ? "commenter" : role === "viewer" ? "readonly" : "none",
    source: role ? "legacy" : "none",
    sourceNodeId: null,
    capabilities: {
      canView: !!role,
      canComment: editor || role === "commenter",
      canCreate: editor,
      canEdit: editor,
      canDelete: admin,
      canMove: admin,
      canDownload: !!role,
      canReshare: admin,
      canManageMembers: admin,
    },
  };
}

function resolveTargetAccess(
  db: DatabaseSync,
  targetParentId: string | null,
  userId: string,
  workspaceId: string | null,
): EffectiveKnowledgeAccess {
  return targetParentId
    ? resolveKnowledgeNodeAccess(targetParentId, userId, db)
    : workspaceRootAccess(db, userId, workspaceId);
}

function titleExpression(): string {
  return `CASE
    WHEN node.resourceType = 'notebook' THEN COALESCE(nb.name, '未命名文件夹')
    WHEN node.resourceType = 'note' THEN COALESCE(note.title, '无标题笔记')
    WHEN node.resourceType = 'mindmap' THEN COALESCE(mm.title, node.resourceId)
    WHEN node.resourceType = 'file' THEN COALESCE(file.filename, node.resourceId)
    ELSE node.resourceId
  END`;
}

export function listKnowledgeTree(input: {
  userId: string;
  workspaceId: string | null;
  includeDeleted?: boolean;
  db?: DatabaseSync;
}): KnowledgeTreeNode[] {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const key = scopeKey(input.userId, input.workspaceId);
  // In a workspace the scope key does not contain the requesting user. In personal space it does,
  // so another account cannot enumerate someone else's private tree by guessing an id.
  const rows = db.prepare(`
    SELECT node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
           node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
           node.isExpanded, node.isDeleted, node.deletedAt, node.createdAt, node.updatedAt,
           note.contentFormat AS contentFormat, note.note_type AS noteType,
           ${titleExpression()} AS title,
           (SELECT COUNT(*) FROM knowledge_tree_nodes child
             WHERE child.parentId = node.id AND child.isDeleted = 0) AS childCount
    FROM knowledge_tree_nodes node
    LEFT JOIN notebooks nb ON node.resourceType = 'notebook' AND nb.id = node.resourceId
    LEFT JOIN notes note ON node.resourceType = 'note' AND note.id = node.resourceId
    LEFT JOIN mindmaps mm ON node.resourceType = 'mindmap' AND mm.id = node.resourceId
    LEFT JOIN files file ON node.resourceType = 'file' AND file.id = node.resourceId
    WHERE node.scopeKey = ? ${input.includeDeleted ? "" : "AND node.isDeleted = 0"}
    ORDER BY node.parentId IS NOT NULL, node.parentId, node.sortOrder, lower(title), node.id
  `).all(key) as unknown as Array<NodeRow & { title: string; childCount: number }>;

  return rows
    .map((row) => ({ ...row, access: resolveKnowledgeNodeAccess(row.id, input.userId, db) }))
    .filter((row) => row.access.capabilities.canView);
}

function nearestNotebookContainer(db: DatabaseSync, nodeId: string | null): string | null {
  let cursor = nodeId;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor)) throw new KnowledgeTreeError("KNOWLEDGE_TREE_CYCLE", 409, "目录结构存在循环");
    visited.add(cursor);
    const node = readNode(db, cursor, true);
    if (!node) return null;
    if (node.resourceType === "notebook") return node.resourceId;
    if (node.resourceType === "note") {
      const note = db.prepare("SELECT notebookId FROM notes WHERE id = ?").get(node.resourceId) as { notebookId: string } | undefined;
      if (note?.notebookId) return note.notebookId;
    }
    cursor = node.parentId;
  }
  return null;
}

function recordHistory(db: DatabaseSync, input: {
  nodeId: string;
  action: "create" | "move" | "reorder" | "delete_subtree" | "delete_promote" | "restore";
  actorUserId: string;
  fromParentId?: string | null;
  toParentId?: string | null;
  metadata?: unknown;
}): void {
  db.prepare(`
    INSERT INTO knowledge_tree_history (
      id, nodeId, action, actorUserId, fromParentId, toParentId, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), input.nodeId, input.action, input.actorUserId,
    input.fromParentId ?? null, input.toParentId ?? null,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  );
}

function maxSortOrder(db: DatabaseSync, scope: string, parentId: string | null): number {
  const row = parentId
    ? db.prepare("SELECT COALESCE(MAX(sortOrder), -1) AS value FROM knowledge_tree_nodes WHERE scopeKey = ? AND parentId = ? AND isDeleted = 0")
      .get(scope, parentId) as { value: number }
    : db.prepare("SELECT COALESCE(MAX(sortOrder), -1) AS value FROM knowledge_tree_nodes WHERE scopeKey = ? AND parentId IS NULL AND isDeleted = 0")
      .get(scope) as { value: number };
  return Number(row?.value ?? -1) + 1;
}

function nodeForResource(db: DatabaseSync, resourceType: KnowledgeResourceType, resourceId: string): NodeRow {
  const row = db.prepare(`
    SELECT id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
           resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    FROM knowledge_tree_nodes WHERE resourceType = ? AND resourceId = ? LIMIT 1
  `).get(resourceType, resourceId) as NodeRow | undefined;
  if (!row) throw new KnowledgeTreeError("KNOWLEDGE_NODE_SYNC_FAILED", 409, "内容节点同步失败");
  return row;
}

export function createKnowledgeChild(input: {
  actorUserId: string;
  workspaceId: string | null;
  parentId: string | null;
  nodeType: "folder" | "note" | "markdown" | "word" | "mindmap" | "sheet" | "plain" | "board";
  title: string;
  encryptedContent?: string;
  encryptedNoteId?: string;
  sheetData?: unknown;
  db?: DatabaseSync;
}): KnowledgeTreeNode {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const parent = input.parentId ? requireNode(db, input.parentId) : null;
  const requestedWorkspaceId = input.workspaceId || null;
  const normalizedWorkspaceId = parent ? parent.workspaceId : requestedWorkspaceId;
  const resourceOwnerUserId = parent && !parent.workspaceId ? parent.userId : input.actorUserId;
  const expectedScope = parent?.scopeKey || scopeKey(resourceOwnerUserId, normalizedWorkspaceId);
  const targetAccess = resolveTargetAccess(db, input.parentId, input.actorUserId, normalizedWorkspaceId);
  if (!targetAccess.capabilities.canCreate) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "没有在此处新建内容的权限", { required: "canCreate" });
  }

  const sheetData = input.sheetData === undefined ? undefined : validateSheetData(input.sheetData);
  if (input.sheetData !== undefined && (input.nodeType !== "sheet" || input.encryptedContent || !sheetData)) {
    throw new KnowledgeTreeError("INVALID_PAYLOAD", 400, "表格数据格式无效");
  }

  const title = input.title.trim() || (
    input.nodeType === "folder"
      ? "新建文件夹"
      : input.nodeType === "mindmap"
        ? "无标题导图"
        : input.nodeType === "sheet"
          ? "无标题表格"
          : input.nodeType === "board"
            ? "无标题画板"
            : "无标题笔记"
  );
  const key = expectedScope;
  const sortOrder = maxSortOrder(db, key, input.parentId);
  let createdNode: NodeRow | null = null;

  const transaction = db.transaction(() => {
    if (input.nodeType === "folder") {
      const notebookId = uuid();
      const physicalParentId = nearestNotebookContainer(db, input.parentId);
      db.prepare(`
        INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, sortOrder)
        VALUES (?, ?, ?, ?, ?, '📁', ?)
      `).run(notebookId, resourceOwnerUserId, normalizedWorkspaceId, physicalParentId, title, sortOrder);
      createdNode = nodeForResource(db, "notebook", notebookId);
    } else if (input.nodeType === "mindmap") {
      // 导图归一：与 markdown/plain/board 同走 notes 行（contentFormat="mindmap"），
      // 正文存 MindMapData JSON；不再写独立 mindmaps 表。
      const notebookId = nearestNotebookContainer(db, input.parentId);
      if (!notebookId) {
        throw new KnowledgeTreeError("KNOWLEDGE_TREE_NOTE_CONTAINER_REQUIRED", 400, "根级文档需要先创建文件夹");
      }
      const mindmapId = uuid();
      db.prepare(`
        INSERT INTO notes (
          id, userId, workspaceId, notebookId, title, content, contentText,
          contentFormat, note_type, sortOrder
        ) VALUES (?, ?, ?, ?, ?, ?, '', 'mindmap', 'normal', ?)
      `).run(mindmapId, resourceOwnerUserId, normalizedWorkspaceId, notebookId, title,
        defaultMindmapContent(title), sortOrder);
      createdNode = nodeForResource(db, "note", mindmapId);
    } else {
      const notebookId = nearestNotebookContainer(db, input.parentId);
      if (!notebookId) {
        throw new KnowledgeTreeError("KNOWLEDGE_TREE_NOTE_CONTAINER_REQUIRED", 400, "根级文档需要先创建文件夹");
      }
      const noteId = input.encryptedContent && input.encryptedNoteId ? input.encryptedNoteId : uuid();
      const contentFormat = input.encryptedContent ? "encrypted-note-v1" : input.nodeType === "markdown" ? "markdown" : input.nodeType === "plain" ? "plain" : input.nodeType === "board" ? "board" : "tiptap-json";
      const noteType = input.nodeType === "word" ? "word" : input.nodeType === "sheet" ? "sheet" : "normal";
      const content = input.encryptedContent || (contentFormat === "markdown" ? `# ${title}\n\n` : contentFormat === "plain" ? "" : contentFormat === "board" ? '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}' : "{}");
      db.prepare(`
        INSERT INTO notes (
          id, userId, workspaceId, notebookId, title, content, contentText,
          contentFormat, note_type, sortOrder
        ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
      `).run(
        noteId, resourceOwnerUserId, normalizedWorkspaceId, notebookId, title,
        content, contentFormat, noteType, sortOrder,
      );
      if (input.nodeType === "sheet") {
        db.prepare(`
          INSERT INTO sheets (noteId, userId, workspaceId, data)
          VALUES (?, ?, ?, ?)
        `).run(
          noteId,
          resourceOwnerUserId,
          normalizedWorkspaceId,
          JSON.stringify(sheetData || {
            version: 1,
            rows: Array.from({ length: 20 }, (_, index) => ({ id: `r${index + 1}`, height: 32 })),
            columns: Array.from({ length: 8 }, (_, index) => ({
              id: `c${index + 1}`,
              width: 120,
              title: String.fromCharCode(65 + index),
              type: "text",
              align: "left",
            })),
            cells: {},
          }),
        );
      }
      createdNode = nodeForResource(db, "note", noteId);
    }

    if (!createdNode) throw new KnowledgeTreeError("KNOWLEDGE_NODE_SYNC_FAILED", 409, "内容节点同步失败");
    db.prepare(`
      UPDATE knowledge_tree_nodes
      SET parentId = ?, sortOrder = ?, updatedAt = datetime('now')
      WHERE id = ?
    `).run(input.parentId, sortOrder, createdNode.id);
    recordHistory(db, {
      nodeId: createdNode.id,
      action: "create",
      actorUserId: input.actorUserId,
      toParentId: input.parentId,
      metadata: { nodeType: input.nodeType, title },
    });
  });
  transaction();

  const row = requireNode(db, createdNode!.id);
  return {
    ...row,
    title,
    childCount: 0,
    contentFormat: input.encryptedContent ? "encrypted-note-v1" : input.nodeType === "markdown" ? "markdown" : input.nodeType === "plain" ? "plain" : input.nodeType === "board" ? "board" : input.nodeType === "mindmap" ? "mindmap" : input.nodeType === "folder" ? undefined : "tiptap-json",
    noteType: input.nodeType === "sheet" ? "sheet" : input.nodeType === "word" ? "word" : undefined,
    access: resolveKnowledgeNodeAccess(row.id, input.actorUserId, db),
  };
}

function isDescendant(db: DatabaseSync, ancestorId: string, candidateId: string): boolean {
  const row = db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM knowledge_tree_nodes WHERE parentId = ? AND isDeleted = 0
      UNION ALL
      SELECT child.id
      FROM knowledge_tree_nodes child
      JOIN descendants parent ON child.parentId = parent.id
      WHERE child.isDeleted = 0
    )
    SELECT 1 AS found FROM descendants WHERE id = ? LIMIT 1
  `).get(ancestorId, candidateId) as { found: number } | undefined;
  return !!row;
}

function syncBusinessParent(db: DatabaseSync, node: NodeRow, treeParentId: string | null): void {
  const notebookContainer = nearestNotebookContainer(db, treeParentId);
  if (node.resourceType === "note") {
    if (!notebookContainer) {
      throw new KnowledgeTreeError("KNOWLEDGE_TREE_NOTE_CONTAINER_REQUIRED", 400, "文档必须位于可承载文档的目录中");
    }
    db.prepare("UPDATE notes SET notebookId = ?, workspaceId = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(notebookContainer, node.workspaceId, node.resourceId);
  } else if (node.resourceType === "notebook") {
    db.prepare("UPDATE notebooks SET parentId = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(notebookContainer, node.resourceId);
    if (node.resourceId.startsWith(MINDMAP_LEGACY_NOTEBOOK_PREFIX)) {
      db.prepare("UPDATE mindmap_folders SET parentId = ?, updatedAt = datetime('now') WHERE id = ?")
        .run(
          notebookContainer?.startsWith(MINDMAP_LEGACY_NOTEBOOK_PREFIX)
            ? notebookContainer.slice(MINDMAP_LEGACY_NOTEBOOK_PREFIX.length)
            : null,
          node.resourceId.slice(MINDMAP_LEGACY_NOTEBOOK_PREFIX.length),
        );
    }
  } else if (node.resourceType === "mindmap") {
    db.prepare("UPDATE mindmaps SET folderId = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(
        notebookContainer?.startsWith(MINDMAP_LEGACY_NOTEBOOK_PREFIX)
          ? notebookContainer.slice(MINDMAP_LEGACY_NOTEBOOK_PREFIX.length)
          : null,
        node.resourceId,
      );
  }
}

export function moveKnowledgeNode(input: {
  actorUserId: string;
  nodeId: string;
  parentId: string | null;
  sortOrder?: number;
  /** 插到该兄弟节点之前（与 parentId 同级，二选一）。 */
  beforeId?: string;
  /** 插到该兄弟节点之后（与 parentId 同级，二选一）。 */
  afterId?: string;
  db?: DatabaseSync;
}): KnowledgeTreeNode {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const node = requireNode(db, input.nodeId);
  requireCapability(db, node.id, input.actorUserId, "canMove");
  const sharedRootId = resolveSharedKnowledgeRoot(node.id, input.actorUserId, db);

  const parent = input.parentId ? requireNode(db, input.parentId) : null;
  if (sharedRootId) {
    if (node.id == sharedRootId) {
      throw new KnowledgeTreeError(
        "KNOWLEDGE_SHARED_ROOT_MOVE_FORBIDDEN",
        403,
        "共享根节点不能由接收者移动",
      );
    }
    const targetSharedRootId = parent
      ? resolveSharedKnowledgeRoot(parent.id, input.actorUserId, db)
      : null;
    if (!parent || targetSharedRootId !== sharedRootId) {
      throw new KnowledgeTreeError(
        "KNOWLEDGE_SHARED_ROOT_SCOPE_MISMATCH",
        403,
        "共享内容只能在同一个共享根内移动",
        { sharedRootId, targetSharedRootId },
      );
    }
  }
  if (parent && parent.scopeKey !== node.scopeKey) {
    throw new KnowledgeTreeError("KNOWLEDGE_TREE_SCOPE_MISMATCH", 400, "不能跨空间移动内容");
  }
  if (input.parentId === node.id || (input.parentId && isDescendant(db, node.id, input.parentId))) {
    throw new KnowledgeTreeError("KNOWLEDGE_TREE_CYCLE", 400, "不能移动到自身或自己的后代节点");
  }
  // 知识库是根级节点：只允许在根层重排，不能被拖进其它知识库/文件夹（否则会从根列表消失）
  if (node.resourceType === "notebook" && node.parentId === null && input.parentId !== null) {
    throw new KnowledgeTreeError(
      "KNOWLEDGE_ROOT_NOTEBOOK_MOVE_FORBIDDEN",
      400,
      "知识库是根级节点，不能移动到其它知识库或文件夹内",
    );
  }
  const anchorId = input.beforeId ?? input.afterId ?? null;
  if (input.beforeId && input.afterId) {
    throw new KnowledgeTreeError("KNOWLEDGE_MOVE_ANCHOR_CONFLICT", 400, "beforeId 与 afterId 只能二选一");
  }
  const anchorNode = anchorId ? requireNode(db, anchorId) : null;
  if (anchorNode) {
    if ((anchorNode.parentId ?? null) !== input.parentId) {
      throw new KnowledgeTreeError("KNOWLEDGE_MOVE_ANCHOR_SCOPE_MISMATCH", 400, "目标节点不在同一父级下");
    }
    if (anchorNode.scopeKey !== node.scopeKey) {
      throw new KnowledgeTreeError("KNOWLEDGE_TREE_SCOPE_MISMATCH", 400, "不能跨空间移动内容");
    }
  }
  const targetAccess = resolveTargetAccess(db, input.parentId, input.actorUserId, node.workspaceId);
  if (!targetAccess.capabilities.canCreate && !targetAccess.capabilities.canMove) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "没有移动到目标位置的权限", { required: "canCreate" });
  }

  const nextSort = Number.isFinite(input.sortOrder)
    ? Math.max(0, Math.trunc(input.sortOrder!))
    : maxSortOrder(db, node.scopeKey, input.parentId);
  const fromParentId = node.parentId;

  const transaction = db.transaction(() => {
    syncBusinessParent(db, node, input.parentId);
    // Business table triggers intentionally normalize to the nearest physical notebook. Restore
    // the richer document-parent relationship after that compatibility update.
    db.prepare(`
      UPDATE knowledge_tree_nodes
      SET parentId = ?, sortOrder = ?, updatedAt = datetime('now')
      WHERE id = ?
    `).run(input.parentId, nextSort, node.id);
    // 指定插到某兄弟之前/之后：把该父级下的兄弟按 sortOrder 重新编号（0..n-1），
    // 让"拖到目标上半/下半"真的落在指定位置，而不是追加到父级末尾。
    if (anchorId) {
      const siblings = db.prepare(`
        SELECT id FROM knowledge_tree_nodes
         WHERE scopeKey = ? AND isDeleted = 0 AND id <> ?
           AND ((parentId IS NULL AND ? IS NULL) OR parentId = ?)
         ORDER BY sortOrder, id
      `).all(node.scopeKey, node.id, input.parentId, input.parentId) as Array<{ id: string }>;
      const ordered = siblings.map((row) => row.id);
      const anchorIndex = ordered.indexOf(anchorId);
      if (anchorIndex >= 0) {
        ordered.splice(input.beforeId ? anchorIndex : anchorIndex + 1, 0, node.id);
        const updateSort = db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = ? WHERE id = ?");
        ordered.forEach((id, index) => updateSort.run(index, id));
      }
    }
    recordHistory(db, {
      nodeId: node.id,
      action: "move",
      actorUserId: input.actorUserId,
      fromParentId,
      toParentId: input.parentId,
      metadata: { sortOrder: nextSort, anchorId, position: input.beforeId ? "before" : input.afterId ? "after" : null },
    });
  });
  transaction();

  const moved = requireNode(db, node.id);
  return {
    ...moved,
    title: readNodeTitle(db, moved),
    childCount: countChildren(db, moved.id),
    access: resolveKnowledgeNodeAccess(moved.id, input.actorUserId, db),
  };
}

function readNodeTitle(db: DatabaseSync, node: NodeRow): string {
  if (node.resourceType === "notebook") {
    return (db.prepare("SELECT name FROM notebooks WHERE id = ?").get(node.resourceId) as { name: string } | undefined)?.name || "未命名文件夹";
  }
  if (node.resourceType === "note") {
    return (db.prepare("SELECT title FROM notes WHERE id = ?").get(node.resourceId) as { title: string } | undefined)?.title || "无标题笔记";
  }
  if (node.resourceType === "mindmap") {
    return (db.prepare("SELECT title FROM mindmaps WHERE id = ?").get(node.resourceId) as { title: string } | undefined)?.title || node.resourceId;
  }
  return node.resourceId;
}

function countChildren(db: DatabaseSync, nodeId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS count FROM knowledge_tree_nodes WHERE parentId = ? AND isDeleted = 0")
    .get(nodeId) as { count: number }).count || 0);
}

function descendantNodes(db: DatabaseSync, nodeId: string): NodeRow[] {
  return db.prepare(`
    WITH RECURSIVE subtree(id, depth) AS (
      SELECT id, 0 FROM knowledge_tree_nodes WHERE id = ?
      UNION ALL
      SELECT child.id, subtree.depth + 1
      FROM knowledge_tree_nodes child
      JOIN subtree ON child.parentId = subtree.id
      WHERE child.isDeleted = 0
    )
    SELECT node.id, node.userId, node.workspaceId, node.scopeKey, node.parentId,
           node.nodeType, node.resourceType, node.resourceId, node.sortOrder,
           node.isExpanded, node.isDeleted, node.deletedAt, node.createdAt, node.updatedAt
    FROM subtree JOIN knowledge_tree_nodes node ON node.id = subtree.id
    ORDER BY subtree.depth DESC
  `).all(nodeId) as unknown as NodeRow[];
}

/** 引用节点的 id 前缀：引用不属于 knowledge_tree_nodes，操作前先按它分流。 */
export const KNOWLEDGE_REFERENCE_ID_PREFIX = "ref:";

export function isKnowledgeReferenceId(nodeId: string): boolean {
  return nodeId.startsWith(KNOWLEDGE_REFERENCE_ID_PREFIX);
}

/** 笔记行对应的树节点类型（与 notes 插入触发器的 CASE 保持一致）。 */
function noteNodeType(contentFormat: string | null, noteType: string | null): KnowledgeNodeType {
  if (noteType === "word") return "word";
  if (contentFormat === "markdown") return "markdown";
  return "note";
}

/** 删掉挂在这些目录下的引用（目录被删时引用跟着消失，但正文不动）。 */
function deleteReferencesUnder(db: DatabaseSync, parentIds: Set<string>): void {
  if (parentIds.size === 0) return;
  const ids = [...parentIds];
  for (let index = 0; index < ids.length; index += 200) {
    const chunk = ids.slice(index, index + 200);
    db.prepare(`
      UPDATE knowledge_tree_references
      SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
      WHERE isDeleted = 0 AND parentId IN (${chunk.map(() => "?").join(",")})
    `).run(...chunk);
  }
}

/**
 * 删除时结算引用：子树外还有引用指向这篇笔记 → 不回收正文，
 * 而是把主节点搬到最早那条引用的目录，并消掉那条引用（避免同一位置出现两项）。
 */
function adoptReferenceLocation(
  db: DatabaseSync,
  node: NodeRow,
  subtreeIds: Set<string>,
): boolean {
  if (node.resourceType !== "note") return false;
  const ids = [...subtreeIds];
  const placeholders = ids.map(() => "?").join(",");
  const reference = db.prepare(`
    SELECT id, parentId FROM knowledge_tree_references
    WHERE resourceId = ? AND scopeKey = ? AND isDeleted = 0
      AND parentId NOT IN (${placeholders})
    ORDER BY createdAt, id LIMIT 1
  `).get(node.resourceId, node.scopeKey, ...ids) as { id: string; parentId: string } | undefined;
  if (!reference) return false;
  syncBusinessParent(db, node, reference.parentId);
  db.prepare(`
    UPDATE knowledge_tree_nodes
    SET parentId = ?, sortOrder = ?, updatedAt = datetime('now')
    WHERE id = ?
  `).run(reference.parentId, maxSortOrder(db, node.scopeKey, reference.parentId), node.id);
  db.prepare(`
    UPDATE knowledge_tree_references
    SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
    WHERE id = ?
  `).run(reference.id);
  return true;
}

type KnowledgeReferenceRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string;
  resourceId: string;
  title: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

function readReference(db: DatabaseSync, referenceId: string): KnowledgeReferenceRow | null {
  return (db.prepare(`
    SELECT id, userId, workspaceId, scopeKey, parentId, resourceId, title, sortOrder, createdAt, updatedAt
    FROM knowledge_tree_references WHERE id = ? AND isDeleted = 0
  `).get(referenceId) as KnowledgeReferenceRow | undefined) || null;
}

function requireReference(db: DatabaseSync, referenceId: string): KnowledgeReferenceRow {
  const reference = readReference(db, referenceId);
  if (!reference) throw new KnowledgeTreeError("KNOWLEDGE_NODE_NOT_FOUND", 404, "内容节点不存在");
  return reference;
}

/** 同一目录下，树节点与引用共用一条排序序列。 */
function nextChildSortOrder(db: DatabaseSync, scope: string, parentId: string): number {
  const nodeMax = db.prepare(`
    SELECT COALESCE(MAX(sortOrder), -1) AS value FROM knowledge_tree_nodes
    WHERE scopeKey = ? AND parentId = ? AND isDeleted = 0
  `).get(scope, parentId) as { value: number };
  const referenceMax = db.prepare(`
    SELECT COALESCE(MAX(sortOrder), -1) AS value FROM knowledge_tree_references
    WHERE scopeKey = ? AND parentId = ? AND isDeleted = 0
  `).get(scope, parentId) as { value: number };
  return Math.max(Number(nodeMax?.value ?? -1), Number(referenceMax?.value ?? -1)) + 1;
}

function referenceToNode(
  db: DatabaseSync,
  reference: KnowledgeReferenceRow,
  actorUserId: string,
): KnowledgeTreeNode {
  const note = db.prepare(`
    SELECT title, contentFormat, colorMark, note_type AS noteType, isPinned, isLocked
    FROM notes WHERE id = ?
  `).get(reference.resourceId) as {
    title: string | null; contentFormat: string | null; colorMark: string | null;
    noteType: string | null; isPinned: number | null; isLocked: number | null;
  } | undefined;
  return {
    id: reference.id,
    userId: reference.userId,
    workspaceId: reference.workspaceId,
    scopeKey: reference.scopeKey,
    parentId: reference.parentId,
    nodeType: noteNodeType(note?.contentFormat ?? null, note?.noteType ?? null),
    resourceType: "note",
    resourceId: reference.resourceId,
    title: note?.title || reference.title,
    isPinned: Number(note?.isPinned || 0),
    isLocked: Number(note?.isLocked || 0),
    contentFormat: note?.contentFormat ?? null,
    colorMark: note?.colorMark ?? null,
    noteType: note?.noteType ?? null,
    sortOrder: Number(reference.sortOrder),
    isExpanded: 0,
    isDeleted: 0,
    deletedAt: null,
    childCount: 0,
    createdAt: reference.createdAt,
    updatedAt: reference.updatedAt,
    access: resolveKnowledgeNodeAccess(reference.parentId, actorUserId, db),
    isReference: true,
  };
}

/**
 * 复制 = 连接：不动正文，只在目标目录多加一条路径。
 * 正文、附件、标签、评论仍然只有一份，改任何一条路径都是改同一篇文档。
 */
export function createKnowledgeReference(input: {
  actorUserId: string;
  nodeId: string;
  parentId?: string | null;
  db?: DatabaseSync;
}): KnowledgeTreeNode {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const source = requireNode(db, input.nodeId);
  if (source.resourceType !== "note") {
    throw new KnowledgeTreeError("KNOWLEDGE_REFERENCE_UNSUPPORTED", 400, "只有文档可以复制为链接");
  }
  const parentId = input.parentId || source.parentId;
  if (!parentId) {
    // 根目录文档的隐藏容器在创建后就被摘掉了，没有地方可以挂副本。
    throw new KnowledgeTreeError(
      "KNOWLEDGE_REFERENCE_PARENT_REQUIRED",
      400,
      "根目录文档不能复制为链接，请先移动到文件夹",
    );
  }
  const parent = requireNode(db, parentId);
  if (parent.resourceType !== "notebook") {
    throw new KnowledgeTreeError("KNOWLEDGE_REFERENCE_PARENT_INVALID", 400, "复制目标必须是文件夹");
  }
  if (parent.scopeKey !== source.scopeKey) {
    throw new KnowledgeTreeError("KNOWLEDGE_TREE_SCOPE_MISMATCH", 400, "不能跨空间复制内容");
  }
  const targetAccess = resolveTargetAccess(db, parent.id, input.actorUserId, source.workspaceId);
  if (!targetAccess.capabilities.canCreate) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "没有在此处创建内容的权限", { required: "canCreate" });
  }

  const title = readNodeTitle(db, source);
  const sortOrder = nextChildSortOrder(db, source.scopeKey, parent.id);
  // UNIQUE(parentId, resourceId) 会保留已删除的路径，所以重新复制要复活旧行而不是插新行。
  const existing = db.prepare(`
    SELECT id FROM knowledge_tree_references WHERE parentId = ? AND resourceId = ? LIMIT 1
  `).get(parent.id, source.resourceId) as { id: string } | undefined;
  const referenceId = existing?.id || `${KNOWLEDGE_REFERENCE_ID_PREFIX}${uuid()}`;
  const transaction = db.transaction(() => {
    if (existing) {
      db.prepare(`
        UPDATE knowledge_tree_references
        SET isDeleted = 0, deletedAt = NULL, title = ?, sortOrder = ?, updatedAt = datetime('now')
        WHERE id = ?
      `).run(title, sortOrder, existing.id);
      return;
    }
    db.prepare(`
      INSERT INTO knowledge_tree_references (
        id, userId, workspaceId, scopeKey, parentId, resourceType, resourceId, title, sortOrder
      ) VALUES (?, ?, ?, ?, ?, 'note', ?, ?, ?)
    `).run(
      referenceId, source.userId, source.workspaceId, source.scopeKey, parent.id, source.resourceId, title, sortOrder,
    );
  });
  transaction();
  return referenceToNode(db, requireReference(db, referenceId), input.actorUserId);
}

/** 移动一条路径：只改引用行，不影响正文，也不影响其它路径。 */
export function moveKnowledgeReference(input: {
  actorUserId: string;
  referenceId: string;
  parentId: string | null;
  sortOrder?: number;
  db?: DatabaseSync;
}): KnowledgeTreeNode {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const reference = requireReference(db, input.referenceId);
  requireCapability(db, reference.parentId, input.actorUserId, "canMove");
  if (!input.parentId) {
    throw new KnowledgeTreeError("KNOWLEDGE_REFERENCE_PARENT_REQUIRED", 400, "复制出来的文档必须放在文件夹中");
  }
  const parent = requireNode(db, input.parentId);
  if (parent.resourceType !== "notebook") {
    throw new KnowledgeTreeError("KNOWLEDGE_REFERENCE_PARENT_INVALID", 400, "复制出来的文档必须放在文件夹中");
  }
  if (parent.scopeKey !== reference.scopeKey) {
    throw new KnowledgeTreeError("KNOWLEDGE_TREE_SCOPE_MISMATCH", 400, "不能跨空间移动内容");
  }
  const targetAccess = resolveTargetAccess(db, parent.id, input.actorUserId, reference.workspaceId);
  if (!targetAccess.capabilities.canCreate) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "没有移动到目标位置的权限", { required: "canCreate" });
  }
  const duplicate = db.prepare(`
    SELECT id FROM knowledge_tree_references
    WHERE parentId = ? AND resourceId = ? AND isDeleted = 0 AND id <> ?
  `).get(parent.id, reference.resourceId, reference.id) as { id: string } | undefined;
  if (duplicate) {
    throw new KnowledgeTreeError("KNOWLEDGE_REFERENCE_DUPLICATE", 409, "该目录里已有这份文档");
  }
  const sortOrder = Number.isFinite(input.sortOrder)
    ? Math.max(0, Math.trunc(input.sortOrder!))
    : nextChildSortOrder(db, reference.scopeKey, parent.id);
  db.prepare(`
    UPDATE knowledge_tree_references SET parentId = ?, sortOrder = ?, updatedAt = datetime('now') WHERE id = ?
  `).run(parent.id, sortOrder, reference.id);
  return referenceToNode(db, requireReference(db, reference.id), input.actorUserId);
}

/** 引用没有独立标题：改名改的是同一份正文，所有路径一起变。 */
export function renameKnowledgeReference(input: {
  actorUserId: string;
  referenceId: string;
  title: string;
  db?: DatabaseSync;
}): KnowledgeTreeNode {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const reference = requireReference(db, input.referenceId);
  requireCapability(db, reference.parentId, input.actorUserId, "canEdit");
  const title = input.title.trim();
  if (!title) throw new KnowledgeTreeError("KNOWLEDGE_TITLE_REQUIRED", 400, "名称不能为空");
  const transaction = db.transaction(() => {
    db.prepare("UPDATE notes SET title = ?, version = version + 1, updatedAt = datetime('now') WHERE id = ?")
      .run(title, reference.resourceId);
    db.prepare(`
      UPDATE knowledge_tree_references SET title = ?, updatedAt = datetime('now')
      WHERE resourceId = ? AND isDeleted = 0
    `).run(title, reference.resourceId);
  });
  transaction();
  return referenceToNode(db, requireReference(db, reference.id), input.actorUserId);
}

/** 删一条路径不动正文：正文只在最后一条路径消失时才被回收（见 adoptReferenceLocation）。 */
function deleteKnowledgeReferenceNode(input: {
  db: DatabaseSync;
  actorUserId: string;
  referenceId: string;
}): { success: true; mode: KnowledgeDeleteMode; affectedNodeIds: string[]; promotedNodeIds: string[] } {
  const reference = requireReference(input.db, input.referenceId);
  requireCapability(input.db, reference.parentId, input.actorUserId, "canDelete");
  input.db.prepare(`
    UPDATE knowledge_tree_references
    SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
    WHERE id = ?
  `).run(reference.id);
  return { success: true, mode: "subtree", affectedNodeIds: [reference.id], promotedNodeIds: [] };
}

function softDeleteBusinessNode(db: DatabaseSync, node: NodeRow): void {
  if (node.resourceType === "note") {
    db.prepare(`
      UPDATE notes SET isTrashed = 1, trashedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id = ? AND isTrashed = 0
    `).run(node.resourceId);
  } else if (node.resourceType === "notebook") {
    db.prepare(`
      UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id = ? AND isDeleted = 0
    `).run(node.resourceId);
  }
  db.prepare(`
    UPDATE knowledge_tree_nodes
    SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
    WHERE id = ?
  `).run(node.id);
}

export function deleteKnowledgeNode(input: {
  actorUserId: string;
  nodeId: string;
  mode: KnowledgeDeleteMode;
  db?: DatabaseSync;
}): { success: true; mode: KnowledgeDeleteMode; affectedNodeIds: string[]; promotedNodeIds: string[] } {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  if (isKnowledgeReferenceId(input.nodeId)) {
    return deleteKnowledgeReferenceNode({ db, actorUserId: input.actorUserId, referenceId: input.nodeId });
  }
  const node = requireNode(db, input.nodeId);
  requireCapability(db, node.id, input.actorUserId, "canDelete");

  const affected: string[] = [];
  const promoted: string[] = [];
  const transaction = db.transaction(() => {
    if (input.mode === "promote") {
      // 目录只是个容器：它自己被删时，挂在它下面的路径（引用）一起消失，正文留在别处。
      deleteReferencesUnder(db, new Set([node.id]));
      const children = db.prepare(`
        SELECT id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
               resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
        FROM knowledge_tree_nodes WHERE parentId = ? AND isDeleted = 0 ORDER BY sortOrder, id
      `).all(node.id) as unknown as NodeRow[];
      let order = maxSortOrder(db, node.scopeKey, node.parentId);
      for (const child of children) {
        syncBusinessParent(db, child, node.parentId);
        db.prepare("UPDATE knowledge_tree_nodes SET parentId = ?, sortOrder = ?, updatedAt = datetime('now') WHERE id = ?")
          .run(node.parentId, order++, child.id);
        promoted.push(child.id);
      }
      softDeleteBusinessNode(db, node);
      affected.push(node.id);
      recordHistory(db, {
        nodeId: node.id,
        action: "delete_promote",
        actorUserId: input.actorUserId,
        fromParentId: node.parentId,
        metadata: { promotedNodeIds: promoted },
      });
    } else {
      const nodes = descendantNodes(db, node.id);
      const subtreeIds = new Set(nodes.map((current) => current.id));
      // 先删被删子树内部的路径，再结算子树外还留着的路径。
      deleteReferencesUnder(db, subtreeIds);
      for (const current of nodes) {
        // 子树之外还有副本指向这篇文档：正文不回收，主节点搬到那条副本所在目录。
        if (adoptReferenceLocation(db, current, subtreeIds)) continue;
        softDeleteBusinessNode(db, current);
        affected.push(current.id);
      }
      recordHistory(db, {
        nodeId: node.id,
        action: "delete_subtree",
        actorUserId: input.actorUserId,
        fromParentId: node.parentId,
        metadata: { affectedNodeIds: affected },
      });
    }
  });
  transaction();
  return { success: true, mode: input.mode, affectedNodeIds: affected, promotedNodeIds: promoted };
}

export function restoreKnowledgeNode(input: {
  actorUserId: string;
  nodeId: string;
  includeSubtree?: boolean;
  db?: DatabaseSync;
}): { success: true; restoredNodeIds: string[] } {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  const node = requireNode(db, input.nodeId, true);
  const access = resolveKnowledgeNodeAccess(node.parentId || node.id, input.actorUserId, db);
  if (!access.capabilities.canDelete && node.userId !== input.actorUserId) {
    throw new KnowledgeTreeError("KNOWLEDGE_CAPABILITY_FORBIDDEN", 403, "没有恢复权限", { required: "canDelete" });
  }
  const nodes = input.includeSubtree === false ? [node] : descendantNodes(db, node.id);
  const restored: string[] = [];
  const transaction = db.transaction(() => {
    for (const current of nodes.reverse()) {
      if (current.resourceType === "note") {
        db.prepare("UPDATE notes SET isTrashed = 0, trashedAt = NULL, updatedAt = datetime('now') WHERE id = ?")
          .run(current.resourceId);
      } else if (current.resourceType === "notebook") {
        db.prepare("UPDATE notebooks SET isDeleted = 0, deletedAt = NULL, updatedAt = datetime('now') WHERE id = ?")
          .run(current.resourceId);
      }
      db.prepare("UPDATE knowledge_tree_nodes SET isDeleted = 0, deletedAt = NULL, updatedAt = datetime('now') WHERE id = ?")
        .run(current.id);
      restored.push(current.id);
    }
    recordHistory(db, {
      nodeId: node.id,
      action: "restore",
      actorUserId: input.actorUserId,
      toParentId: node.parentId,
      metadata: { restoredNodeIds: restored },
    });
  });
  transaction();
  return { success: true, restoredNodeIds: restored };
}

export function reorderKnowledgeNodes(input: {
  actorUserId: string;
  items: Array<{ id: string; sortOrder: number }>;
  db?: DatabaseSync;
}): { success: true; updated: number } {
  const db = input.db || getDb();
  ensureKnowledgeTreeTables(db);
  if (input.items.length > 500) throw new KnowledgeTreeError("KNOWLEDGE_REORDER_TOO_LARGE", 400, "单次最多排序 500 个节点");
  let updated = 0;
  const transaction = db.transaction(() => {
    for (const item of input.items) {
      // 引用行与树节点共用一条排序序列，拖拽排序时也要能落库。
      if (isKnowledgeReferenceId(item.id)) {
        const reference = requireReference(db, item.id);
        requireCapability(db, reference.parentId, input.actorUserId, "canMove");
        const referenceSortOrder = Math.max(0, Math.trunc(Number(item.sortOrder) || 0));
        db.prepare("UPDATE knowledge_tree_references SET sortOrder = ?, updatedAt = datetime('now') WHERE id = ?")
          .run(referenceSortOrder, reference.id);
        updated++;
        continue;
      }
      const node = requireNode(db, item.id);
      requireCapability(db, node.id, input.actorUserId, "canMove");
      const sortOrder = Math.max(0, Math.trunc(Number(item.sortOrder) || 0));
      db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = ?, updatedAt = datetime('now') WHERE id = ?")
        .run(sortOrder, node.id);
      if (node.resourceType === "note") {
        db.prepare("UPDATE notes SET sortOrder = ? WHERE id = ?").run(sortOrder, node.resourceId);
      } else if (node.resourceType === "notebook") {
        db.prepare("UPDATE notebooks SET sortOrder = ? WHERE id = ?").run(sortOrder, node.resourceId);
        if (node.resourceId.startsWith(MINDMAP_LEGACY_NOTEBOOK_PREFIX)) {
          db.prepare("UPDATE mindmap_folders SET sortOrder = ? WHERE id = ?")
            .run(sortOrder, node.resourceId.slice(MINDMAP_LEGACY_NOTEBOOK_PREFIX.length));
        }
      }
      recordHistory(db, {
        nodeId: node.id,
        action: "reorder",
        actorUserId: input.actorUserId,
        fromParentId: node.parentId,
        toParentId: node.parentId,
        metadata: { sortOrder },
      });
      updated++;
    }
  });
  transaction();
  return { success: true, updated };
}

export function listKnowledgeTreeHistory(nodeId: string, userId: string, db: DatabaseSync = getDb()) {
  ensureKnowledgeTreeTables(db);
  requireCapability(db, nodeId, userId, "canView");
  return db.prepare(`
    SELECT history.*, actor.username AS actorUsername, target.username AS targetUsername
    FROM knowledge_tree_history history
    LEFT JOIN users actor ON actor.id = history.actorUserId
    LEFT JOIN users target ON target.id = history.targetUserId
    WHERE history.nodeId = ?
    ORDER BY history.createdAt DESC, history.id DESC
    LIMIT 200
  `).all(nodeId);
}
