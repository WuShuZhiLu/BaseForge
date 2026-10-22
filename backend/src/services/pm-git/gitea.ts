/** Gitea 平台（REST v1）：Authorization: token 认证，issue 用 index，labels 为 id 数组（P1 不带标签写入）。 */
import {
  PmGitError,
  repoPath,
  type PmGitContext,
  type PmGitPlatformProvider,
  type PmPlatformIssue,
  type PmPlatformRepo,
} from "./types";

function authHeaders(ctx: PmGitContext, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `token ${ctx.token}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function gtJson<T = any>(ctx: PmGitContext, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: authHeaders(ctx, (init?.headers ?? {}) as Record<string, string>) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new PmGitError(`Gitea 返回异常（HTTP ${res.status}）`, 502);
  }
  if (!res.ok) {
    const msg = json?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new PmGitError("Gitea 认证失败：token 无效或过期", 403);
    if (res.status === 404) throw new PmGitError("Gitea 仓库或条目不存在", 404);
    throw new PmGitError(`Gitea 错误：${msg}`, 502);
  }
  return json as T;
}

function mapIssue(raw: any): PmPlatformIssue {
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ""),
    body: String(raw.body ?? ""),
    state: raw.state === "closed" ? "closed" : "open",
    labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => String(l?.name ?? "")).filter(Boolean) : [],
    author: String(raw.user?.login ?? ""),
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    url: String(raw.html_url ?? ""),
    commentsCount: Number(raw.comments ?? 0),
  };
}

export const giteaProvider: PmGitPlatformProvider = {
  type: "gitea",

  async listRepos(ctx) {
    const rows = await gtJson<any[]>(ctx, `${ctx.apiBase}/user/repos?limit=50`);
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      fullName: String(r.full_name ?? ""),
      description: String(r.description ?? ""),
      url: String(r.html_url ?? ""),
      private: Boolean(r.private),
      updatedAt: r.updated_at ?? null,
    }));
  },

  async listIssues(ctx, repo, state) {
    const { owner, name } = repoPath(repo);
    const rows = await gtJson<any[]>(ctx, `${ctx.apiBase}/repos/${owner}/${name}/issues?state=${state}&limit=50&type=issues`);
    return (Array.isArray(rows) ? rows : []).map(mapIssue);
  },

  async getIssue(ctx, repo, number) {
    const { owner, name } = repoPath(repo);
    return mapIssue(await gtJson<any>(ctx, `${ctx.apiBase}/repos/${owner}/${name}/issues/${number}`));
  },

  async createIssue(ctx, repo, input) {
    const { owner, name } = repoPath(repo);
    return mapIssue(
      await gtJson<any>(ctx, `${ctx.apiBase}/repos/${owner}/${name}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: input.title, body: input.body }),
      }),
    );
  },

  async updateIssue(ctx, repo, number, input) {
    const { owner, name } = repoPath(repo);
    return mapIssue(
      await gtJson<any>(ctx, `${ctx.apiBase}/repos/${owner}/${name}/issues/${number}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.state !== undefined ? { state: input.state } : {}),
        }),
      }),
    );
  },

  async addComment(ctx, repo, number, body) {
    const { owner, name } = repoPath(repo);
    await gtJson<any>(ctx, `${ctx.apiBase}/repos/${owner}/${name}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  },
};
