import type { DatabaseSync } from "node:sqlite";

import { getDb } from "../db/schema.js";

/**
 * 知识库 Overview 统计（服务端聚合，替代前端全量拉 notes 本地累加）。
 * 口径见 .cmp/DESIGN-KB-SINGLE-TREE.md §4：
 *  - docCount：子树内 isDeleted=0 且 nodeType != 'folder' 的节点数（Overview 页不是节点，不计入）
 *  - charCount：上述文档对应 notes.contentText 去掉空白（空格/制表/换行/全角空格）后的字符数
 *    之和；无 contentText 的资源（表格/导图/附件）按 0 计，不估算
 *  - updatedAt：子树内节点 updatedAt 最大值（空子树回落根节点自身）
 *  - contributors：子树内文档 userId 去重，按文档数降序取前 3，附 users 的 username/displayName
 */

export interface KnowledgeContributor {
  userId: string;
  username: string;
  displayName: string | null;
  docCount: number;
}

export interface KnowledgeNodeStats {
  docCount: number;
  charCount: number;
  updatedAt: string;
  contributors: KnowledgeContributor[];
}

/** IN (...) 分块大小：SQLite 绑定参数上限保守值。 */
const ID_CHUNK = 400;

/** contentText 去空白（空格、制表、换行、回车、全角空格）后的长度。 */
const CHAR_LENGTH_SQL =
  "length(replace(replace(replace(replace(replace(contentText, ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(12288), ''))";

function chunkIds(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(ids.slice(i, i + ID_CHUNK));
  return out;
}

export function knowledgeNodeStats(nodeId: string, db: DatabaseSync = getDb()): KnowledgeNodeStats {
  const subtree = db.prepare(`
    WITH RECURSIVE subtree(id, nodeType, resourceType, resourceId, isDeleted, updatedAt) AS (
      SELECT id, nodeType, resourceType, resourceId, isDeleted, updatedAt
        FROM knowledge_tree_nodes
       WHERE id = ?
      UNION ALL
      SELECT n.id, n.nodeType, n.resourceType, n.resourceId, n.isDeleted, n.updatedAt
        FROM knowledge_tree_nodes n
        JOIN subtree s ON n.parentId = s.id
       WHERE n.isDeleted = 0
    )
    SELECT id, nodeType, resourceType, resourceId, isDeleted, updatedAt FROM subtree
  `).all(nodeId) as Array<{
    id: string;
    nodeType: string;
    resourceType: string;
    resourceId: string;
    isDeleted: number;
    updatedAt: string;
  }>;

  let updatedAt = "";
  let docCount = 0;
  const noteIds: string[] = [];
  for (const row of subtree) {
    if (row.isDeleted) continue;
    if (row.updatedAt > updatedAt) updatedAt = row.updatedAt;
    if (row.nodeType === "folder") continue;
    docCount += 1;
    // 只有笔记类资源有 contentText；表格/导图/附件节点存在但字数按 0 计
    if (row.resourceType === "note" || row.resourceType === "mindmap") {
      if (row.resourceId) noteIds.push(row.resourceId);
    }
  }

  let charCount = 0;
  const contributors: KnowledgeContributor[] = [];
  if (noteIds.length > 0) {
    for (const chunk of chunkIds(Array.from(new Set(noteIds)))) {
      const placeholders = chunk.map(() => "?").join(",");
      const agg = db.prepare(`
        SELECT COUNT(*) AS c, COALESCE(SUM(${CHAR_LENGTH_SQL}), 0) AS chars
          FROM notes WHERE id IN (${placeholders})
      `).get(...chunk) as { c: number; chars: number };
      charCount += Number(agg?.chars ?? 0);
    }

    // 贡献者：按文档数降序，最多 3 人
    const counts = new Map<string, number>();
    for (const chunk of chunkIds(Array.from(new Set(noteIds)))) {
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db.prepare(`
        SELECT userId, COUNT(*) AS c FROM notes WHERE id IN (${placeholders})
         GROUP BY userId
      `).all(...chunk) as Array<{ userId: string; c: number }>;
      for (const row of rows) {
        if (!row.userId) continue;
        counts.set(row.userId, (counts.get(row.userId) ?? 0) + Number(row.c));
      }
    }
    const top = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    if (top.length > 0) {
      const userIds = top.map(([userId]) => userId);
      const placeholders = userIds.map(() => "?").join(",");
      const users = db.prepare(`
        SELECT id, username, displayName FROM users WHERE id IN (${placeholders})
      `).all(...userIds) as Array<{ id: string; username: string; displayName: string | null }>;
      const byId = new Map(users.map((u) => [u.id, u]));
      for (const [userId, count] of top) {
        const user = byId.get(userId);
        if (!user) continue;
        contributors.push({
          userId,
          username: user.username,
          displayName: user.displayName,
          docCount: count,
        });
      }
    }
  }

  return { docCount, charCount, updatedAt, contributors };
}
