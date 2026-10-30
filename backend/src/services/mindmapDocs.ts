/**
 * 导图文档（contentFormat = "mindmap"）服务端共享逻辑。
 *
 * 导图已归一为知识库文档：正文存 notes（content 为 MindMapData JSON）。
 * /api/mindmaps 路由保留为门面——SDK / 移动端 / 嵌入卡片的契约不变，
 * 读写全部落到 notes 表。迁移（db/mindmapDocsMigration）与门面共用本模块。
 */
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";

export const MINDMAP_DOC_FORMAT = "mindmap";
export const MINDMAP_FALLBACK_NOTEBOOK_NAME = "思维导图";

/** notes 行 → /api/mindmaps 门面响应（沿用旧 MindMapRow 结构）。 */
export function noteRowToMindmapPayload(row: {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  content?: string | null;
  isFavorite: number | null;
  isUnlisted?: number | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    title: row.title,
    data: row.content ?? "",
    starred: row.isFavorite ? 1 : 0,
    folderId: null,
    isUnlisted: row.isUnlisted ? 1 : 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 门面创建（AI 存为导图等无树上下文的调用方）的兜底 notebook：
 * 优先复用同名兜底笔记本，否则创建一个（树投影触发器会自动建对应文件夹节点）。
 */
export function resolveMindmapFallbackNotebook(
  db: Database.Database,
  userId: string,
  workspaceId: string | null,
): string {
  const scopeSql = workspaceId
    ? "workspaceId = ?"
    : "workspaceId IS NULL AND userId = ?";
  const scopeParams = workspaceId ? [workspaceId] : [userId];
  const existing = db.prepare(
    `SELECT id FROM notebooks WHERE name = ? AND ${scopeSql} ORDER BY createdAt LIMIT 1`,
  ).get(MINDMAP_FALLBACK_NOTEBOOK_NAME, ...scopeParams) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = uuidv4();
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, sortOrder)
    VALUES (?, ?, ?, NULL, ?, '🧠', 0)
  `).run(id, userId, workspaceId, MINDMAP_FALLBACK_NOTEBOOK_NAME);
  return id;
}
