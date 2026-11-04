import { getDb } from "../../db/schema.js";
import { canManageResource, hasPermission, resolveTrashedNotePermission } from "../../middleware/acl.js";
import { listKnowledgeTree, moveKnowledgeNode, restoreKnowledgeNode, KnowledgeTreeError } from "../knowledgeTree.js";
import type { KnowledgeTreeNode } from "../knowledgeTreeCore.js";
import { resolveKnowledgeNodeAccess } from "../knowledgeCapabilities.js";
import { broadcastNoteUpdated } from "../realtime.js";
import { logAudit } from "../audit.js";
import { reclaimSpace } from "../../lib/reclaimSpace.js";
import { permanentlyDeleteNote } from "./noteTrashAdapter.js";
import { permanentlyDeleteMindmap } from "./mindmapTrashAdapter.js";

export type TrashResourceType = "note" | "notebook" | "mindmap" | "sheet";
/** 回收站内容预览：按类型给出前端可直接渲染的结构。 */
export interface TrashPreview {
  kind: "text" | "markdown" | "outline" | "table" | "board";
  /** text / markdown：正文摘录 */
  text?: string;
  /** outline：导图大纲（层级缩进展示） */
  outline?: Array<{ level: number; label: string }>;
  /** table：表格前 5 行 */
  table?: { columns: string[]; rows: string[][] };
  /** board：画板元素统计 */
  board?: { shapes: number; texts: number };
}
export interface TrashItem {
  id: string;
  resourceId: string;
  resourceType: TrashResourceType;
  title: string;
  contentFormat: string | null;
  /** 内容预览：笔记给文本/markdown，导图给大纲，表格给迷你网格，画板给元素统计。 */
  preview: TrashPreview | null;
  deletedAt: string | null;
  originalParentId: string | null;
  originalPath: string[];
  originalPathHidden: boolean;
  canRestore: boolean;
  canDeletePermanently: boolean;
  isLocked: boolean;
  restoreIncludesAncestors: boolean;
  /** 内容字符数（notes.content / sheets.data），排序用；取不到为 null。 */
  size: number | null;
}
type Scope = { userId: string; workspaceId: string | null };

function readNodes(scope: Scope): KnowledgeTreeNode[] {
  return listKnowledgeTree({ ...scope, includeDeleted: true });
}

function ancestors(node: KnowledgeTreeNode, byId: Map<string, KnowledgeTreeNode>): KnowledgeTreeNode[] {
  const result: KnowledgeTreeNode[] = [];
  const seen = new Set([node.id]);
  for (let parent = byId.get(node.parentId || ""); parent && !seen.has(parent.id); parent = byId.get(parent.parentId || "")) {
    seen.add(parent.id);
    result.unshift(parent);
  }
  return result;
}

export function listTrash(scope: Scope): TrashItem[] {
  const nodes = readNodes(scope);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // Listing promotes descendants of hidden ancestors to visible roots. Keep that
  // safe presentation, but use actual ancestry for restore capability checks.
  const rawRows = getDb().prepare("SELECT id, parentId, isDeleted FROM knowledge_tree_nodes WHERE scopeKey = ?")
    .all(scope.workspaceId ? `workspace:${scope.workspaceId}` : `personal:${scope.userId}`) as Array<{ id: string; parentId: string | null; isDeleted: number }>;
  const rawById = new Map(rawRows.map((row) => [row.id, row]));
  return nodes.filter((node) => node.isDeleted && node.resourceType !== "file").map((node) => {
    const path = ancestors(node, byId);
    const actualAncestors: typeof rawRows = [];
    const seen = new Set([node.id]);
    for (let parent = rawById.get(rawById.get(node.id)?.parentId || ""); parent && !seen.has(parent.id); parent = rawById.get(parent.parentId || "")) {
      seen.add(parent.id);
      actualAncestors.push(parent);
    }
    const deletedAncestors = actualAncestors.filter((parent) => parent.isDeleted);
    let canDeletePermanently = node.access.capabilities.canDelete;
    if (node.resourceType === "note") {
      canDeletePermanently &&= !node.isLocked && hasPermission(resolveTrashedNotePermission(node.resourceId, scope.userId).permission, "manage");
    } else if (node.resourceType === "mindmap") {
      canDeletePermanently &&= canManageResource(node.userId, node.workspaceId, scope.userId);
    }
    const preview = buildTrashPreview(node.resourceType, node.contentFormat || null, node.resourceId);
    const size = trashItemSize(node.resourceType, node.contentFormat || null, node.resourceId);
    return {
      id: node.id, resourceId: node.resourceId,
      resourceType: node.noteType === "sheet" ? "sheet" : node.resourceType as TrashResourceType,
      title: node.title, contentFormat: node.contentFormat || null, deletedAt: node.deletedAt,
      preview,
      originalParentId: node.parentId, originalPath: path.map((parent) => parent.title),
      originalPathHidden: actualAncestors.some((parent) => !byId.has(parent.id) && !parent.id.startsWith("notebook:__nowen_root_documents__:")),
      canRestore: node.access.capabilities.canDelete && deletedAncestors.every((parent) => resolveKnowledgeNodeAccess(parent.id, scope.userId, getDb(), { includeDeleted: true }).capabilities.canDelete),
      canDeletePermanently, isLocked: !!node.isLocked,
      restoreIncludesAncestors: deletedAncestors.length > 0,
      size,
    };
  }).sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || "") || a.id.localeCompare(b.id));
}

const TRASH_TEXT_PREVIEW_LIMIT = 400;

/** 富文本（tiptap JSON）→ 按块提取文本，标题/列表项各占一行，保持文档可辨认结构。 */
function tiptapPreview(content: string): string | null {
  try {
    const lines: string[] = [];
    const walk = (value: unknown, depth: number): void => {
      if (!value || typeof value !== "object" || lines.length >= 14) return;
      const node = value as { type?: string; text?: string; content?: unknown[] };
      if (typeof node.text === "string" && node.text.trim() && !node.type) {
        const line = node.text.trim();
        lines.push(depth > 0 ? `${"　".repeat(Math.min(depth - 1, 3))}${line}` : line);
        return;
      }
      if (node.type === "heading" || node.type === "blockquote") lines.push(lines.length ? "" : "");
      if (Array.isArray(node.content)) {
        const nextDepth = node.type === "listItem" ? depth + 1 : depth;
        node.content.forEach((child) => walk(child, nextDepth));
      }
    };
    walk(JSON.parse(content), 0);
    const text = lines.filter((line, index) => line !== "" || index > 0).join("\n").trim();
    return text ? `${text.slice(0, TRASH_TEXT_PREVIEW_LIMIT)}${text.length > TRASH_TEXT_PREVIEW_LIMIT ? "…" : ""}` : null;
  } catch {
    return null;
  }
}

/** 导图 MindMapData → 大纲（层级缩进，最多 40 项）。 */
function mindmapOutline(content: string): TrashPreview["outline"] | null {
  try {
    const data = JSON.parse(content) as { root?: { text?: string; children?: unknown[] } };
    if (!data.root) return null;
    const outline: Array<{ level: number; label: string }> = [];
    const walk = (nodeText: string | undefined, children: unknown, level: number): void => {
      if (outline.length >= 40) return;
      if (typeof nodeText === "string") outline.push({ level, label: nodeText.trim() || "（空）" });
      if (Array.isArray(children)) for (const child of children) {
        const node = child as { text?: string; children?: unknown[] };
        walk(node.text, node.children, level + 1);
      }
    };
    walk(data.root.text, data.root.children, 0);
    return outline.length ? outline : null;
  } catch {
    return null;
  }
}

/** 表格 sheets.data → 前 5 行迷你网格。 */
function sheetTable(resourceId: string): TrashPreview["table"] | null {
  try {
    const row = getDb().prepare("SELECT data FROM sheets WHERE noteId = ?").get(resourceId) as { data?: string } | undefined;
    if (!row?.data) return null;
    const data = JSON.parse(row.data) as { columns?: Array<{ id: string; title?: string }>; rows?: Array<{ id: string }>; cells?: Record<string, string> };
    const columns = (data.columns || []).slice(0, 8);
    if (!columns.length) return null;
    const cellOf = (rowId: string, columnId: string): string =>
      (data.cells?.[`${rowId}:${columnId}`] || "").slice(0, 30);
    return {
      columns: columns.map((column) => column.title || "列"),
      rows: (data.rows || []).slice(0, 5).map((row) => columns.map((column) => cellOf(row.id, column.id))),
    };
  } catch {
    return null;
  }
}

/** 画板 excalidraw → 元素统计。 */
function boardInfo(content: string): TrashPreview["board"] | null {
  try {
    const data = JSON.parse(content) as { elements?: Array<{ type?: string }> };
    const elements = data.elements || [];
    if (!elements.length) return null;
    return {
      shapes: elements.filter((element) => element.type !== "text").length,
      texts: elements.filter((element) => element.type === "text").length,
    };
  } catch {
    return null;
  }
}

/** 回收站条目的"大小"＝内容字符数（notes.content / sheets.data），用于侧栏排序；取不到为 null。 */
function trashItemSize(resourceType: string, contentFormat: string | null, resourceId: string): number | null {
  try {
    if (resourceType === "note" || resourceType === "mindmap") {
      const note = getDb().prepare("SELECT content FROM notes WHERE id = ?").get(resourceId) as { content?: string | null } | undefined;
      return note?.content ? note.content.length : null;
    }
    if (resourceType === "sheet") {
      const row = getDb().prepare("SELECT data FROM sheets WHERE noteId = ?").get(resourceId) as { data?: string } | undefined;
      return row?.data ? row.data.length : null;
    }
    return null;
  } catch {
    return null;
  }
}

function buildTrashPreview(resourceType: string, contentFormat: string | null, resourceId: string): TrashPreview | null {
  if (resourceType === "mindmap") {
    const note = getDb().prepare("SELECT content FROM notes WHERE id = ?").get(resourceId) as { content?: string | null } | undefined;
    const outline = note?.content ? mindmapOutline(note.content) : null;
    return outline ? { kind: "outline", outline } : null;
  }
  if (resourceType === "sheet") {
    const table = sheetTable(resourceId);
    return table ? { kind: "table", table } : null;
  }
  if (resourceType !== "note") return null;
  const note = getDb().prepare("SELECT contentText, content FROM notes WHERE id = ?").get(resourceId) as { contentText?: string | null; content?: string | null } | undefined;
  const content = (note?.content || "").trim();
  const contentText = (note?.contentText || "").trim();
  if (contentFormat === "markdown" && content) {
    return { kind: "markdown", text: `${content.slice(0, TRASH_TEXT_PREVIEW_LIMIT)}${content.length > TRASH_TEXT_PREVIEW_LIMIT ? "…" : ""}` };
  }
  if (contentFormat === "plain" && content) {
    return { kind: "text", text: content.slice(0, TRASH_TEXT_PREVIEW_LIMIT) };
  }
  if (content) {
    // 富文本 / Word：tiptap JSON 结构化提取
    const text = tiptapPreview(content) || contentText.slice(0, TRASH_TEXT_PREVIEW_LIMIT) || null;
    return text ? { kind: "text", text } : null;
  }
  if (contentText) return { kind: "text", text: contentText.slice(0, TRASH_TEXT_PREVIEW_LIMIT) };
  if (contentFormat === "board") return { kind: "board", board: { shapes: 0, texts: 0 } };
  return null;
}

function requireTrashedNode(scope: Scope, id: string): KnowledgeTreeNode {
  const node = readNodes(scope).find((entry) => entry.id === id && entry.isDeleted && entry.resourceType !== "file");
  if (!node) throw new KnowledgeTreeError("TRASH_ITEM_NOT_FOUND", 404, "内容不在当前回收站或无访问权限");
  return node;
}

export function restoreTrashItem(scope: Scope, id: string): string[] {
  const node = requireTrashedNode(scope, id);
  const byId = new Map(readNodes(scope).map((entry) => [entry.id, entry]));
  return restoreTrashedNode(scope, node, byId);
}

function restoreTrashedNode(scope: Scope, node: KnowledgeTreeNode, byId: Map<string, KnowledgeTreeNode>): string[] {
  const db = getDb();
  const deletedAncestors = ancestors(node, byId).filter((parent) => parent.isDeleted);
  if (!node.access.capabilities.canDelete || deletedAncestors.some((parent) => !parent.access.capabilities.canDelete)) {
    throw new KnowledgeTreeError("TRASH_RESTORE_FORBIDDEN", 403, "没有恢复内容或所在目录的权限");
  }
  // Restoring ancestors and the selected item is one transaction. The tree service
  // retains delete-cohort semantics, so previously trashed siblings stay trashed.
  const restored = db.transaction(() => {
    const ids = new Set<string>();
    for (const target of [...deletedAncestors, node]) {
      // A previous item in this batch may already have restored the ancestor.
      if (!(db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE id = ?").get(target.id) as { isDeleted: number } | undefined)?.isDeleted) continue;
      if (ids.has(target.id)) continue;
      restoreKnowledgeNode({ actorUserId: scope.userId, nodeId: target.id, db }).restoredNodeIds.forEach((value) => ids.add(value));
    }
    return [...ids];
  })();
  for (const nodeId of restored) {
    const restoredNode = byId.get(nodeId);
    if (restoredNode?.resourceType === "note") {
      const note = db.prepare("SELECT version, updatedAt FROM notes WHERE id = ?").get(restoredNode.resourceId) as { version: number; updatedAt: string };
      try { broadcastNoteUpdated(restoredNode.resourceId, { ...note, actorUserId: scope.userId }); } catch { /* committed */ }
    }
  }
  return restored;
}

export function permanentlyDeleteTrashItem(scope: Scope, id: string): void {
  const node = requireTrashedNode(scope, id);
  const item = listTrash(scope).find((entry) => entry.id === id)!;
  deleteTrashedNode(scope, node, item);
}

function deleteTrashedNode(scope: Scope, node: KnowledgeTreeNode, item: TrashItem, deferReclaim = false): number {
  if (!item.canDeletePermanently) throw new KnowledgeTreeError("TRASH_DELETE_FORBIDDEN", 403, "内容已锁定或没有永久删除权限");
  const db = getDb();
  // Never let legacy notebook FK cascades bypass a descendant's ACL or lock.
  // Children must pass their own lifecycle operation before a container is removed.
  if (db.prepare("SELECT 1 FROM knowledge_tree_nodes WHERE parentId = ? LIMIT 1").get(node.id)) {
    throw new KnowledgeTreeError("TRASH_CONTAINER_NOT_EMPTY", 409, "请先永久删除其中的内容；受保护内容将保留所在目录");
  }
  if (node.resourceType === "note") return permanentlyDeleteNote(node.resourceId, scope.userId, deferReclaim);
  else if (node.resourceType === "mindmap") permanentlyDeleteMindmap(node.resourceId, scope.userId);
  else {
    if (db.prepare("SELECT 1 FROM notebooks WHERE parentId = ? UNION ALL SELECT 1 FROM notes WHERE notebookId = ? LIMIT 1")
      .get(node.resourceId, node.resourceId)) {
      throw new KnowledgeTreeError("TRASH_CONTAINER_NOT_EMPTY", 409, "文件夹仍包含内容，不能永久删除");
    }
    db.prepare("DELETE FROM notebooks WHERE id = ? AND isDeleted = 1").run(node.resourceId);
    logAudit(scope.userId, "notebook", "delete_permanent", { notebookId: node.resourceId });
  }
  return 0;
}

export interface TrashBatchResult {
  succeededIds: string[];
  noteIds: string[];
  failures: Array<{ id: string; code: string; error: string }>;
}

export function mutateTrash(scope: Scope, action: "restore" | "permanent", requestedIds: string[], options?: { targetParentId?: string | null }): TrashBatchResult {
  const nodes = readNodes(scope);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const itemsById = new Map(listTrash(scope).map((item) => [item.id, item]));
  const selected = new Set(requestedIds);
  if (action === "permanent") {
    // Include visible trashed descendants of selected containers. Hidden or active
    // children still block container deletion at the service boundary.
    for (const node of nodes) {
      if (node.isDeleted && node.resourceType !== "file" && ancestors(node, byId).some((parent) => selected.has(parent.id))) selected.add(node.id);
    }
  }
  const depth = (id: string) => byId.has(id) ? ancestors(byId.get(id)!, byId).length : 0;
  const ids = [...selected].sort((a, b) => action === "permanent" ? depth(b) - depth(a) : depth(a) - depth(b));
  const result: TrashBatchResult = { succeededIds: [], noteIds: [], failures: [] };
  const restored = new Set<string>();
  let freedBytesEstimate = 0;
  for (const id of ids) {
    try {
      const node = byId.get(id);
      const item = itemsById.get(id);
      if (!node || !item) throw new KnowledgeTreeError("TRASH_ITEM_NOT_FOUND", 404, "内容不在当前回收站或无访问权限");
      if (action === "restore") {
        if (!restored.has(id)) restoreTrashedNode(scope, node, byId).forEach((value) => restored.add(value));
      } else freedBytesEstimate += deleteTrashedNode(scope, node, item, true);
      result.succeededIds.push(id);
      if (action === "permanent" && byId.get(id)?.resourceType === "note") result.noteIds.push(byId.get(id)!.resourceId);
    } catch (error) {
      result.failures.push({ id, code: error instanceof KnowledgeTreeError ? error.code : "TRASH_OPERATION_FAILED",
        error: error instanceof KnowledgeTreeError ? error.message : "回收站操作失败" });
    }
  }
  if (action === "permanent" && result.succeededIds.length) reclaimSpace(getDb(), { freedBytesEstimate, tag: "trash.batch" });
  // 「恢复到…」：恢复成功后把该条目移动到用户指定的目录（仅单条恢复时支持）。
  if (action === "restore" && options?.targetParentId && result.failures.length === 0 && requestedIds.length === 1) {
    try {
      moveKnowledgeNode({ actorUserId: scope.userId, nodeId: requestedIds[0], parentId: options.targetParentId });
    } catch (cause) {
      // 已恢复到原位置、仅移动失败：如实告知，不回滚恢复。
      result.failures.push({ id: requestedIds[0], code: "TRASH_RESTORE_MOVE_FAILED",
        error: `已恢复到原位置，但移动失败：${cause instanceof KnowledgeTreeError ? cause.message : "回收站操作失败"}` });
    }
  }
  return result;
}

export function emptyTrash(scope: Scope): TrashBatchResult {
  return mutateTrash(scope, "permanent", listTrash(scope).map((item) => item.id));
}
