/**
 * 项目管理插件 —— git 平台集成路由：/api/pm/git
 *
 * - 平台源 CRUD（PAT 加密存储，同 remote-files 模式）
 * - 仓库列表 / issue 双向同步：
 *   - import-issues：批量拉取平台 issue → 创建或更新工作项（匹配 gitSourceId+repo+number）
 *   - pull：以平台为准覆盖工作项（标题/描述/标签/状态映射 open→doing 重新激活、closed→done）
 *   - push：以工作项为准更新平台 issue（标题/描述/状态 done→closed 其余→open/标签）
 *   - create-issue：工作项在平台创建 issue 并回填关联
 */
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { pmRepository } from "../repositories/pmRepository";
import { systemSettingsRepository } from "../repositories";
import {
  PM_GIT_PROVIDERS,
  PM_GIT_SOURCE_TYPES,
  defaultApiBase,
  readPmGitSources,
  resolvePmGitContext,
  writePmGitSources,
} from "../services/pm-git";
import { encryptSecret, decryptSecret } from "../services/remote-files/credentials";
import { PmGitError, type PmGitSourceConfig, type PmGitSourceType, type PmPlatformIssue } from "../services/pm-git/types";

const pmGitRouter = new Hono();

const userIdOf = (c: any) => c.req.header("X-User-Id") || "";

function publicSource(s: PmGitSourceConfig) {
  return { id: s.id, type: s.type, name: s.name, apiBase: s.apiBase, createdAt: s.createdAt };
}

function mapPlatformStatus(state: "open" | "closed"): string {
  return state === "closed" ? "done" : "doing";
}

/** 从平台 issue upsert 工作项（导入与拉取共用） */
function upsertFromPlatform(
  userId: string,
  projectId: string,
  sourceId: string,
  repo: string,
  issue: PmPlatformIssue,
): { item: ReturnType<typeof pmRepository.getWorkItem> & object; created: boolean } {
  const existing = pmRepository
    .listWorkItems(userId, projectId)
    .find((i) => i.gitSourceId === sourceId && i.gitRepo === repo && i.gitIssue === String(issue.number));
  const payload = {
    title: issue.title.slice(0, 300),
    description: issue.body.slice(0, 50000),
    tags: issue.labels.slice(0, 10),
    gitSourceId: sourceId,
    gitRepo: repo,
    gitIssue: String(issue.number),
    gitIssueState: issue.state,
    gitIssueUrl: issue.url,
  };
  if (existing) {
    const item = pmRepository.updateWorkItem(userId, existing.id, payload);
    return { item: item!, created: false };
  }
  const item = pmRepository.createWorkItem(userId, projectId, {
    ...payload,
    type: "task",
  });
  // create 默认 todo；平台 closed → 直接标记完成
  if (issue.state === "closed") {
    return { item: pmRepository.updateWorkItem(userId, item.id, { status: "done" })!, created: true };
  }
  return { item, created: true };
}

// ===== 平台源 =====

pmGitRouter.get("/sources", (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  return c.json({ sources: readPmGitSources(userId).map(publicSource), types: PM_GIT_SOURCE_TYPES });
});

pmGitRouter.post("/sources", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  const type = (PM_GIT_SOURCE_TYPES as string[]).includes(body.type) ? (body.type as PmGitSourceType) : null;
  const name = String(body.name ?? "").trim();
  if (!type || !name) return c.json({ error: "请选择平台类型并填写名称" }, 400);
  const token = String(body.token ?? "").trim();
  const sources = readPmGitSources(userId);
  const existingIdx = body.id ? sources.findIndex((s) => s.id === body.id) : -1;
  const apiBase = (String(body.apiBase ?? "").trim() || defaultApiBase(type)).replace(/\/+$/, "");
  if (!apiBase) return c.json({ error: "Gitea 需填写 API 地址（如 https://git.example.com/api/v1）" }, 400);
  if (!token && existingIdx < 0) return c.json({ error: "请填写访问令牌（PAT）" }, 400);
  const id = existingIdx >= 0 ? sources[existingIdx].id : `pg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record: PmGitSourceConfig = {
    id,
    type,
    name: name.slice(0, 60),
    apiBase,
    tokenEnc: token ? encryptSecret(token) : existingIdx >= 0 ? sources[existingIdx].tokenEnc : "",
    createdAt: existingIdx >= 0 ? sources[existingIdx].createdAt : new Date().toISOString(),
  };
  if (existingIdx >= 0) sources[existingIdx] = record;
  else sources.push(record);
  writePmGitSources(userId, sources);
  return c.json({ source: publicSource(record) }, existingIdx >= 0 ? 200 : 201);
});

pmGitRouter.delete("/sources/:id", (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const sources = readPmGitSources(userId);
  const next = sources.filter((s) => s.id !== c.req.param("id"));
  if (next.length === sources.length) return c.json({ error: "平台源不存在" }, 404);
  writePmGitSources(userId, next);
  return c.json({ success: true });
});

// ===== 仓库 / issue =====

pmGitRouter.post("/sources/:id/repos", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  try {
    const { provider, ctx } = resolvePmGitContext(userId, c.req.param("id"));
    return c.json({ repos: await provider.listRepos(ctx) });
  } catch (err) {
    if (err instanceof PmGitError) return c.json({ error: err.message }, err.status as any);
    return c.json({ error: "拉取仓库失败" }, 500);
  }
});

pmGitRouter.post("/sources/:id/import-issues", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  const projectId = String(body.projectId ?? "");
  const repo = String(body.repo ?? "");
  const state = body.state === "closed" ? "closed" : body.state === "all" ? "all" : "open";
  if (!projectId || !repo) return c.json({ error: "缺少项目或仓库" }, 400);
  try {
    const { provider, ctx } = resolvePmGitContext(userId, c.req.param("id"));
    const issues = await provider.listIssues(ctx, repo, state);
    let created = 0;
    let updated = 0;
    for (const issue of issues) {
      const r = upsertFromPlatform(userId, projectId, c.req.param("id"), repo, issue);
      if (r.created) created++;
      else updated++;
    }
    return c.json({ imported: created, updated, total: issues.length });
  } catch (err) {
    if (err instanceof PmGitError) return c.json({ error: err.message }, err.status as any);
    return c.json({ error: "导入失败" }, 500);
  }
});

pmGitRouter.post("/pull", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  const itemId = String(body.itemId ?? "");
  const item = pmRepository.getWorkItem(userId, itemId);
  if (!item) return c.json({ error: "工作项不存在" }, 404);
  if (!item.gitSourceId || !item.gitRepo || !item.gitIssue) return c.json({ error: "该工作项未关联平台 issue" }, 400);
  try {
    const { provider, ctx } = resolvePmGitContext(userId, item.gitSourceId);
    const issue = await provider.getIssue(ctx, item.gitRepo, Number(item.gitIssue));
    const r = upsertFromPlatform(userId, item.projectId, item.gitSourceId, item.gitRepo, issue);
    // 拉取保持既有关联笔记
    const final = pmRepository.updateWorkItem(userId, r.item!.id, { noteId: item.noteId ?? undefined });
    return c.json({ item: final, platform: issue });
  } catch (err) {
    if (err instanceof PmGitError) return c.json({ error: err.message }, err.status as any);
    return c.json({ error: "拉取失败" }, 500);
  }
});

pmGitRouter.post("/push", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  const itemId = String(body.itemId ?? "");
  const item = pmRepository.getWorkItem(userId, itemId);
  if (!item) return c.json({ error: "工作项不存在" }, 404);
  if (!item.gitSourceId || !item.gitRepo || !item.gitIssue) return c.json({ error: "该工作项未关联平台 issue" }, 400);
  try {
    const { provider, ctx } = resolvePmGitContext(userId, item.gitSourceId);
    const issue = await provider.updateIssue(ctx, item.gitRepo, Number(item.gitIssue), {
      title: item.title,
      body: item.description,
      state: item.status === "done" || item.status === "canceled" ? "closed" : "open",
      labels: item.tags,
    });
    const updated = pmRepository.updateWorkItem(userId, item.id, {
      gitIssueState: issue.state,
      gitIssueUrl: issue.url,
    });
    return c.json({ item: updated, platform: issue });
  } catch (err) {
    if (err instanceof PmGitError) return c.json({ error: err.message }, err.status as any);
    return c.json({ error: "推送失败" }, 500);
  }
});

pmGitRouter.post("/create-issue", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  const itemId = String(body.itemId ?? "");
  const sourceId = String(body.sourceId ?? "");
  const repo = String(body.repo ?? "");
  const item = pmRepository.getWorkItem(userId, itemId);
  if (!item) return c.json({ error: "工作项不存在" }, 404);
  if (!sourceId || !repo) return c.json({ error: "请选择平台与仓库" }, 400);
  try {
    const { provider, ctx } = resolvePmGitContext(userId, sourceId);
    const issue = await provider.createIssue(ctx, repo, {
      title: item.title,
      body: item.description || item.title,
      labels: item.tags,
    });
    // 顺带评论指向笔记的引用（若有）
    if (item.noteId) await provider.addComment(ctx, repo, issue.number, `关联交付笔记：noteId=${item.noteId}`);
    const updated = pmRepository.updateWorkItem(userId, item.id, {
      gitSourceId: sourceId,
      gitRepo: repo,
      gitIssue: String(issue.number),
      gitIssueState: issue.state,
      gitIssueUrl: issue.url,
    });
    return c.json({ item: updated, platform: issue });
  } catch (err) {
    if (err instanceof PmGitError) return c.json({ error: err.message }, err.status as any);
    return c.json({ error: "创建平台工单失败" }, 500);
  }
});

// 保持引用（预留：源编辑回显场景）
void decryptSecret;
void systemSettingsRepository;

export default pmGitRouter;
