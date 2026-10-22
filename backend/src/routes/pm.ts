/**
 * 项目管理插件路由：/api/pm
 *
 * 项目 CRUD / 工作项 CRUD（含状态流转）/ 项目统计。
 * 鉴权：全局 JWT 中间件后挂载，按 X-User-Id 隔离（与 remote-files 同模式）。
 */
import { Hono } from "hono";
import { pmRepository } from "../repositories/pmRepository";

const pmRouter = new Hono();

const userIdOf = (c: any) => c.req.header("X-User-Id") || "";

// 客户端错误上报通道已移至 routes/client-log.ts（挂载于全局鉴权之前）

// ===== 项目 =====

pmRouter.get("/projects", (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  return c.json({ projects: pmRepository.listProjects(userId) });
});

pmRouter.post("/projects", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  const name = String(body.name ?? "").trim();
  if (!name) return c.json({ error: "请填写项目名称" }, 400);
  const project = pmRepository.createProject(userId, {
    name,
    description: typeof body.description === "string" ? body.description : "",
    color: typeof body.color === "string" ? body.color : undefined,
    workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : null,
  });
  return c.json({ project }, 201);
});

pmRouter.patch("/projects/:id", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  // M3：删除被引用类型 → 仓库层抛错，转 400（错误信息含具体类型与工单数）
  try {
    const project = pmRepository.updateProject(userId, c.req.param("id"), {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      color: typeof body.color === "string" ? body.color : undefined,
      typeConfig: Array.isArray(body.typeConfig) ? body.typeConfig : undefined,
    });
    if (!project) return c.json({ error: "项目不存在" }, 404);
    return c.json({ project });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "保存失败" }, 400);
  }
});

pmRouter.delete("/projects/:id", (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  return c.json(pmRepository.deleteProject(userId, c.req.param("id")));
});

// ===== 工作项 =====

pmRouter.get("/projects/:id/items", (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const projectId = c.req.param("id");
  const type = c.req.query("type") || undefined;
  const status = c.req.query("status") || undefined;
  return c.json({
    items: pmRepository.listWorkItems(userId, projectId, { type, status }),
    stats: pmRepository.projectStats(userId, projectId),
  });
});

pmRouter.post("/projects/:id/items", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  const title = String(body.title ?? "").trim();
  if (!title) return c.json({ error: "请填写标题" }, 400);
  try {
    const item = pmRepository.createWorkItem(userId, c.req.param("id"), {
      type: typeof body.type === "string" ? body.type : undefined,
      title,
      description: typeof body.description === "string" ? body.description : "",
      priority: typeof body.priority === "string" ? body.priority : undefined,
      dueDate: typeof body.dueDate === "string" ? body.dueDate : null,
      tags: Array.isArray(body.tags) ? body.tags : [],
      parentId: typeof body.parentId === "string" ? body.parentId : body.parentId === null ? null : undefined,
    });
    return c.json({ item }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "创建失败" }, 404);
  }
});

pmRouter.patch("/items/:id", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  const item = pmRepository.updateWorkItem(userId, c.req.param("id"), {
    title: typeof body.title === "string" ? body.title : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    status: typeof body.status === "string" ? body.status : undefined,
    priority: typeof body.priority === "string" ? body.priority : undefined,
    dueDate: typeof body.dueDate === "string" ? body.dueDate : body.dueDate === null ? null : undefined,
    noteId: body.noteId === undefined ? undefined : typeof body.noteId === "string" ? body.noteId : null,
    type: typeof body.type === "string" ? body.type : undefined,
    tags: Array.isArray(body.tags) ? body.tags.map((t: unknown) => String(t)) : undefined,
    gitRepo: typeof body.gitRepo === "string" ? body.gitRepo : undefined,
    gitBranch: typeof body.gitBranch === "string" ? body.gitBranch : undefined,
    gitIssue: typeof body.gitIssue === "string" ? body.gitIssue : undefined,
    gitSourceId: typeof body.gitSourceId === "string" ? body.gitSourceId : undefined,
    gitIssueState: typeof body.gitIssueState === "string" ? body.gitIssueState : undefined,
    gitIssueUrl: typeof body.gitIssueUrl === "string" ? body.gitIssueUrl : undefined,
    parentId: body.parentId === undefined ? undefined : typeof body.parentId === "string" ? body.parentId : null,
  });
  if (!item) return c.json({ error: "工作项不存在" }, 404);
  return c.json({ item });
});

pmRouter.delete("/items/:id", (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  return c.json(pmRepository.deleteWorkItem(userId, c.req.param("id")));
});

// ===== M3：活动流 / 多文档关联 =====

pmRouter.get("/items/:id/logs", (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  if (!pmRepository.getWorkItem(userId, id)) return c.json({ error: "工作项不存在" }, 404);
  return c.json({ logs: pmRepository.listWorkItemLogs(userId, id) });
});

pmRouter.get("/items/:id/notes", (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  if (!pmRepository.getWorkItem(userId, id)) return c.json({ error: "工作项不存在" }, 404);
  return c.json({ notes: pmRepository.listItemNotes(userId, id) });
});

pmRouter.post("/items/:id/notes", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  if (!pmRepository.getWorkItem(userId, id)) return c.json({ error: "工作项不存在" }, 404);
  const body = await c.req.json().catch(() => ({}) as any);
  const noteId = typeof body.noteId === "string" ? body.noteId : "";
  if (!noteId) return c.json({ error: "请提供要关联的笔记 ID" }, 400);
  try {
    return c.json(pmRepository.addItemNote(userId, id, noteId));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "关联失败" }, 400);
  }
});

pmRouter.delete("/items/:id/notes/:noteId", (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  if (!pmRepository.getWorkItem(userId, id)) return c.json({ error: "工作项不存在" }, 404);
  return c.json(pmRepository.removeItemNote(userId, id, c.req.param("noteId")));
});

// ===== M3 概览：跨项目统计聚合 =====

pmRouter.get("/overview", (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  return c.json(pmRepository.overview(userId));
});

export default pmRouter;
