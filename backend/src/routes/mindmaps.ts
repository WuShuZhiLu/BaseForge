/**
 * 思维导图路由 —— 归一后的 /api/mindmaps 门面
 * ---------------------------------------------------------------------------
 * 导图已归一为知识库文档：正文存 notes（contentFormat="mindmap"，content 为
 * MindMapData JSON），树/搜索/回收站/同步都走 notes 链路。本路由保留原路径与
 * 响应结构（SDK / 移动端 / 嵌入卡片契约不变），读写全部落到 notes 表。
 *
 * 权限语义与归一前一致：
 *   - 集合接口（list / create）挂 `requireWorkspaceFeature("mindmaps")`；
 *   - 单资源接口不挂，便于工作区关闭功能后善后；
 *   - 写/删：`canManageResource(creatorId, workspaceId, actorId)`。
 * 门面创建（AI 存为导图等无树上下文的调用方）挂靠兜底 notebook；
 * 知识树内新建走 createKnowledgeChild（knowledgeTreeCore）。
 */
import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuidv4 } from "uuid";
import {
  canManageResource,
  getUserWorkspaceRole,
  requireWorkspaceFeature,
} from "../middleware/acl";
import { ensureMindmapSchema } from "../lib/mindmap-schema";
import { defaultMindmapContent, mindmapPlainText } from "../lib/mindmapData";
import {
  noteRowToMindmapPayload,
  resolveMindmapFallbackNotebook,
} from "../services/mindmapDocs";
import { deleteKnowledgeNode, KnowledgeTreeError } from "../services/knowledgeTree.js";
import { permanentlyDeleteMindmap } from "../services/trash/mindmapTrashAdapter.js";
import { MINDMAP_LEGACY_NOTEBOOK_PREFIX } from "../db/knowledgeTreeMindmapFolderMigration.js";

const app = new Hono();

// 初始化表（统一兜底：mindmaps + starred + folderId + mindmap_folders）。
// 归一后 mindmaps 只剩历史遗留用途（迁移前的旧库升级窗口期），保持幂等兜底。
ensureMindmapSchema();

interface MindmapDocNoteRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  content: string | null;
  isFavorite: number | null;
  isUnlisted: number | null;
  createdAt: string;
  updatedAt: string;
}

const MINDMAP_DOC_SCOPE = `n.contentFormat = 'mindmap' AND n.isTrashed = 0 AND n.isUnlisted = 0`;

/**
 * 解析请求的 scope（personal / workspace）。
 *   - 没传 workspaceId（空串/缺省）→ 个人空间
 *   - 传了但用户不是该工作区成员 → error
 */
function resolveMindmapScope(
  workspaceIdRaw: string,
  userId: string,
): { scope: "personal" | "workspace"; workspaceId: string | null; error?: string } {
  const workspaceId = workspaceIdRaw?.trim() || "";
  if (!workspaceId || workspaceId === "personal") return { scope: "personal", workspaceId: null };
  const role = getUserWorkspaceRole(workspaceId, userId);
  if (!role) return { scope: "workspace", workspaceId, error: "无权访问该工作区" };
  return { scope: "workspace", workspaceId };
}

/** 读权限：本人个人空间 OR 工作区成员。 */
function canReadMindmapDoc(row: MindmapDocNoteRow, userId: string): boolean {
  if (!row.workspaceId) return row.userId === userId;
  return getUserWorkspaceRole(row.workspaceId, userId) !== null;
}

/** 匿名导图文档（isUnlisted=1）允许按 id 读取：嵌入卡片是唯一访问入口。 */
function readMindmapDoc(db: ReturnType<typeof getDb>, id: string): MindmapDocNoteRow | undefined {
  return db.prepare(`
    SELECT n.id, n.userId, n.workspaceId, n.title, n.content, n.isFavorite, n.isUnlisted, n.createdAt, n.updatedAt
    FROM notes n WHERE n.id = ? AND n.contentFormat = 'mindmap' AND n.isTrashed = 0
  `).get(id) as MindmapDocNoteRow | undefined;
}

// ---------- 列表 ----------
app.get("/", requireWorkspaceFeature("mindmaps"), (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const scope = resolveMindmapScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const rows = db.prepare(`
    SELECT n.id, n.userId, n.workspaceId, n.title, n.isFavorite, n.createdAt, n.updatedAt,
           u.username AS creatorName
    FROM notes n LEFT JOIN users u ON u.id = n.userId
    WHERE ${MINDMAP_DOC_SCOPE}
      ${scope.scope === "workspace" ? "AND n.workspaceId = ?" : "AND n.userId = ? AND n.workspaceId IS NULL"}
    ORDER BY n.isFavorite DESC, n.updatedAt DESC
  `).all(scope.scope === "workspace" ? scope.workspaceId : userId) as Array<
    Omit<MindmapDocNoteRow, "content"> & { creatorName: string }
  >;
  return c.json(rows.map((row) => ({
    ...noteRowToMindmapPayload(row),
    creatorName: row.creatorName,
  })));
});

// ---------- 单个读取 ----------
// 不挂 feature 中间件：功能关闭后仍允许按 id 读取（善后用）。
app.get("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const row = readMindmapDoc(db, id);
  if (!row) return c.json({ error: "思维导图不存在" }, 404);
  if (!canReadMindmapDoc(row, userId)) {
    return c.json({ error: "无权访问该导图", code: "FORBIDDEN" }, 403);
  }
  return c.json({
    ...noteRowToMindmapPayload(row),
    canEdit: canManageResource(row.userId, row.workspaceId, userId),
  });
});

// ---------- 创建 ----------
app.post("/", requireWorkspaceFeature("mindmaps"), async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const scope = resolveMindmapScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const id = uuidv4();
  const title = body.title || "无标题导图";
  const data = typeof body.data === "string"
    ? body.data
    : body.data
      ? JSON.stringify(body.data)
      : defaultMindmapContent(title);

  db.prepare(`
    INSERT INTO notes (
      id, userId, workspaceId, notebookId, title, content, contentText,
      contentFormat, note_type, sortOrder
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'mindmap', 'normal', 0)
  `).run(
    id, userId, scope.workspaceId,
    resolveMindmapFallbackNotebook(db, userId, scope.workspaceId),
    title, data, mindmapPlainText(data),
  );

  const row = readMindmapDoc(db, id) as MindmapDocNoteRow;
  return c.json(noteRowToMindmapPayload(row), 201);
});

// ---------- 更新 ----------
app.put("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string;
    data?: string | Record<string, unknown>;
    /**
     * 可选乐观锁。文档内弹层编辑等多入口编辑场景必须携带读取时的 updatedAt，
     * 防止其他入口/另一个浏览器窗口的更新被静默覆盖。
     */
    expectedUpdatedAt?: string;
  }>();

  const existing = readMindmapDoc(db, id);
  if (!existing) return c.json({ error: "思维导图不存在" }, 404);

  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权修改此导图", code: "FORBIDDEN" }, 403);
  }

  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" && body.expectedUpdatedAt.trim()
      ? body.expectedUpdatedAt.trim()
      : null;

  if (expectedUpdatedAt && expectedUpdatedAt !== existing.updatedAt) {
    return c.json({
      error: "思维导图已在其他窗口更新，请重新加载后再保存",
      code: "MINDMAP_CONFLICT",
      currentUpdatedAt: existing.updatedAt,
    }, 409);
  }

  const updates: string[] = [];
  const values: any[] = [];

  if (body.title !== undefined) {
    updates.push("title = ?");
    values.push(body.title);
  }
  if (body.data !== undefined) {
    const data = typeof body.data === "string" ? body.data : JSON.stringify(body.data);
    updates.push("content = ?", "contentText = ?");
    values.push(data, mindmapPlainText(data));
  }
  // 显式忽略 body.workspaceId：不允许跨空间迁移

  if (updates.length > 0) {
    // 使用毫秒精度，确保同一秒内连续保存也能可靠参与下一次乐观锁比较。
    updates.push("updatedAt = strftime('%Y-%m-%d %H:%M:%f', 'now')", "version = version + 1");
    const where = expectedUpdatedAt
      ? "WHERE id = ? AND contentFormat = 'mindmap' AND updatedAt = ?"
      : "WHERE id = ? AND contentFormat = 'mindmap'";
    values.push(id);
    if (expectedUpdatedAt) values.push(expectedUpdatedAt);
    const result = db.prepare(`UPDATE notes SET ${updates.join(", ")} ${where}`).run(...values);
    if (expectedUpdatedAt && result.changes === 0) {
      const latest = db.prepare("SELECT updatedAt FROM notes WHERE id = ?").get(id) as
        | { updatedAt: string }
        | undefined;
      return c.json({
        error: "思维导图已在其他窗口更新，请重新加载后再保存",
        code: "MINDMAP_CONFLICT",
        currentUpdatedAt: latest?.updatedAt || null,
      }, 409);
    }
  }

  const row = readMindmapDoc(db, id) as MindmapDocNoteRow;
  return c.json({
    ...noteRowToMindmapPayload(row),
    canEdit: canManageResource(row.userId, row.workspaceId, userId),
  });
});

// ---------- 删除 ----------
app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const existing = readMindmapDoc(db, id);
  if (!existing) return c.json({ error: "思维导图不存在" }, 404);

  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权删除此导图", code: "FORBIDDEN" }, 403);
  }

  const node = db.prepare(`
    SELECT id FROM knowledge_tree_nodes
    WHERE resourceType = 'note' AND resourceId = ? AND isDeleted = 0
  `).get(id) as { id: string } | undefined;
  if (!node) return c.json({ error: "导图目录节点不存在，请先修复数据", code: "KNOWLEDGE_NODE_SYNC_FAILED" }, 409);
  try {
    deleteKnowledgeNode({ actorUserId: userId, nodeId: node.id, mode: "subtree", db });
  } catch (error) {
    if (error instanceof KnowledgeTreeError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
  return c.json({ success: true });
});

// Permanent deletion is deliberately separate from the legacy DELETE action, which now
// moves a map to the same recoverable tree trash as documents and folders.
app.delete("/:id/permanent", (c) => {
  try {
    permanentlyDeleteMindmap(c.req.param("id"), c.req.header("X-User-Id") || "");
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof KnowledgeTreeError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});

// ---------- 收藏 / 移动 ----------
app.patch("/:id/star", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const existing = readMindmapDoc(db, id);
  if (!existing) return c.json({ error: "思维导图不存在" }, 404);
  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权修改此导图", code: "FORBIDDEN" }, 403);
  }

  db.prepare("UPDATE notes SET isFavorite = 1 - isFavorite, updatedAt = datetime('now') WHERE id = ? AND contentFormat = 'mindmap'").run(id);
  const row = readMindmapDoc(db, id) as MindmapDocNoteRow;
  return c.json(noteRowToMindmapPayload(row));
});

app.patch("/:id/move", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json<{ folderId: string | null }>();

  const existing = readMindmapDoc(db, id);
  if (!existing) return c.json({ error: "Mindmap not found" }, 404);
  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权修改此导图", code: "FORBIDDEN" }, 403);
  }

  // 旧导图文件夹以伪 notebook 容器存在；folderId 为空时挂回兜底 notebook。
  const folderId = body.folderId || null;
  let notebookId: string;
  if (folderId) {
    const pseudoId = `${MINDMAP_LEGACY_NOTEBOOK_PREFIX}${folderId}`;
    const folder = db.prepare("SELECT id FROM notebooks WHERE id = ?").get(pseudoId) as
      | { id: string }
      | undefined;
    if (!folder) return c.json({ error: "目标文件夹不存在" }, 404);
    notebookId = pseudoId;
  } else {
    notebookId = resolveMindmapFallbackNotebook(db, existing.userId, existing.workspaceId);
  }

  db.prepare("UPDATE notes SET notebookId = ?, updatedAt = datetime('now') WHERE id = ? AND contentFormat = 'mindmap'").run(notebookId, id);
  const row = readMindmapDoc(db, id) as MindmapDocNoteRow;
  return c.json(noteRowToMindmapPayload(row));
});

export default app;
