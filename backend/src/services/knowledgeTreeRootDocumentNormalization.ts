/**
 * 恢复完整系统备份后，把 nowen 的「根路径文档」归并进一个知识库。
 *
 * 背景：
 *   - nowen 支持在知识树根层直接放文档（数据模型里挂在隐藏容器
 *     `__nowen_root_documents__:` 下，树节点 parentId = null）；
 *   - BaseForge 的 Web 端只在根层创建知识库，文档都在知识库内部；
 *   - 「数据包导入」已有兜底（nowenPackageImportV2 → 「待整理」），但
 *     「完整系统备份恢复」是整库替换，不经过那条链路，根文档会原样留在根层。
 *
 * 所以在恢复完成后补这一步：把根层文档移进「待整理」知识库，同时同步
 * notes.notebookId 与树节点 parentId，保证两边的归属一致。
 *
 * 只在恢复流程里调用；正常启动 / 运行期不执行，避免影响主动创建的根文档。
 */
import type { DatabaseSync } from "node:sqlite";
import { v4 as uuid } from "uuid";

import {
  beginManualTransaction,
  commitManualTransaction,
  rollbackManualTransaction,
} from "../db/sqlite-ext.js";

const FALLBACK_NOTEBOOK_NAME = "待整理";
/** 历史导入用过的兜底库名，存在就复用，不再重复建库。 */
const REUSABLE_NOTEBOOK_NAMES = [FALLBACK_NOTEBOOK_NAME, "导入的内容"];
const FALLBACK_NOTEBOOK_ICON = "📥";

interface RootDocumentRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  resourceId: string;
  sortOrder: number;
}

function scopeKeyOf(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

function listRootDocuments(db: DatabaseSync): RootDocumentRow[] {
  return db.prepare(`
    SELECT node.id, node.userId, node.workspaceId, node.scopeKey,
           node.resourceId, node.sortOrder
      FROM knowledge_tree_nodes node
      JOIN notes note ON note.id = node.resourceId
     WHERE node.isDeleted = 0
       AND node.resourceType = 'note'
       AND (
         node.parentId IS NULL
         OR node.parentId GLOB 'notebook:__nowen_root_documents__:*'
       )
     ORDER BY node.userId, node.workspaceId, node.sortOrder, node.id
  `).all() as RootDocumentRow[];
}

function findReusableNotebook(
  db: DatabaseSync,
  userId: string,
  workspaceId: string | null,
): { id: string; name: string } | null {
  for (const name of REUSABLE_NOTEBOOK_NAMES) {
    const row = db.prepare(`
      SELECT id, name FROM notebooks
       WHERE userId = ? AND workspaceId IS ? AND parentId IS NULL
         AND name = ? AND isDeleted = 0
       LIMIT 1
    `).get(userId, workspaceId, name) as { id: string; name: string } | undefined;
    if (row) return row;
  }
  return null;
}

function nextRootSortOrder(db: DatabaseSync, scopeKey: string, selfNodeId?: string): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(sortOrder), -1) + 1 AS value
      FROM knowledge_tree_nodes
     WHERE scopeKey = ? AND parentId IS NULL AND isDeleted = 0
       ${selfNodeId ? "AND id <> ?" : ""}
  `).get(...(selfNodeId ? [scopeKey, selfNodeId] : [scopeKey])) as { value: number } | undefined;
  return Number(row?.value ?? 0);
}

function createNotebook(
  db: DatabaseSync,
  userId: string,
  workspaceId: string | null,
  scopeKey: string,
): { id: string; name: string } {
  const notebookId = uuid();
  const sortOrder = nextRootSortOrder(db, scopeKey);
  // knowledge_tree_notebooks_ai 触发器会自动补建对应的树节点，这里不要再插一遍。
  db.prepare(`
    INSERT INTO notebooks (
      id, userId, workspaceId, parentId, name, icon, sortOrder, isExpanded, isDeleted,
      createdAt, updatedAt
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
  `).run(notebookId, userId, workspaceId, FALLBACK_NOTEBOOK_NAME, FALLBACK_NOTEBOOK_ICON, sortOrder);
  return { id: notebookId, name: FALLBACK_NOTEBOOK_NAME };
}

/** 确保已有知识库在树里有一个可用的根节点（历史库里可能只有 notebooks 行）。 */
function ensureNotebookNode(
  db: DatabaseSync,
  notebookId: string,
  userId: string,
  workspaceId: string | null,
  scopeKey: string,
): string {
  const nodeId = `notebook:${notebookId}`;
  const existing = db.prepare(`
    SELECT parentId, isDeleted FROM knowledge_tree_nodes WHERE id = ?
  `).get(nodeId) as { parentId: string | null; isDeleted: number } | undefined;
  if (existing && existing.isDeleted === 0 && existing.parentId === null) return nodeId;

  if (existing) {
    db.prepare(`
      UPDATE knowledge_tree_nodes
         SET parentId = NULL, scopeKey = ?, isDeleted = 0, deletedAt = NULL,
             updatedAt = datetime('now')
       WHERE id = ?
    `).run(scopeKey, nodeId);
    return nodeId;
  }

  const sortOrder = nextRootSortOrder(db, scopeKey, nodeId);
  db.prepare(`
    INSERT INTO knowledge_tree_nodes (
      id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
      resourceId, sortOrder, isExpanded, isDeleted
    ) VALUES (?, ?, ?, ?, NULL, 'folder', 'notebook', ?, ?, 0, 0)
  `).run(nodeId, userId, workspaceId, scopeKey, notebookId, sortOrder);
  return nodeId;
}

/**
 * 把当前库里的根层文档归并到「待整理」知识库。
 *
 * 返回实际移动的文档数与目标知识库名；没有根文档时不做任何写入。
 * 事务失败会回滚并抛出，由调用方决定是否降级为告警。
 */
export function mergeRootDocumentsIntoNotebook(options?: {
  db: DatabaseSync;
}): { moved: number; notebookName: string | null } {
  const db = options?.db;
  if (!db) throw new Error("mergeRootDocumentsIntoNotebook requires a database connection");

  const rows = listRootDocuments(db);
  if (rows.length === 0) return { moved: 0, notebookName: null };

  const groups = new Map<string, RootDocumentRow[]>();
  for (const row of rows) {
    const key = `${row.userId}\u0000${row.workspaceId ?? ""}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  let moved = 0;
  let notebookName: string | null = null;

  beginManualTransaction(db);
  try {
    for (const bucket of groups.values()) {
      const first = bucket[0];
      const workspaceId = first.workspaceId ?? null;
      const scopeKey = first.scopeKey || scopeKeyOf(first.userId, workspaceId);

      const notebook = findReusableNotebook(db, first.userId, workspaceId)
        || createNotebook(db, first.userId, workspaceId, scopeKey);
      notebookName = notebook.name;
      ensureNotebookNode(db, notebook.id, first.userId, workspaceId, scopeKey);

      let sortOrder = 0;
      for (const row of bucket) {
        // notes.notebookId 变更会触发 knowledge_tree_notes_au，把树节点挂到新知识库；
        // 归属和顺序都以 notes 为准，避免树节点与笔记分叉。
        db.prepare(`
          UPDATE notes SET notebookId = ?, sortOrder = ? WHERE id = ?
        `).run(notebook.id, sortOrder, row.resourceId);
        sortOrder += 1;
        moved += 1;
      }
    }
    commitManualTransaction(db);
  } catch (error) {
    try { rollbackManualTransaction(db); } catch { /* ignore */ }
    throw error;
  }

  return { moved, notebookName };
}
