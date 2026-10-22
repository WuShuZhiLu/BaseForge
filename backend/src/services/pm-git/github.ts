/** GitHub 平台（REST v3）：Bearer 认证，labels 为对象数组（取 name）。 */
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
    Authorization: `Bearer ${ctx.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    ...extra,
  };
}

async function ghJson<T = any>(ctx: PmGitContext, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: authHeaders(ctx, (init?.headers ?? {}) as Record<string, string>) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new PmGitError(`GitHub 返回异常（HTTP ${res.status}）`, 502);
  }
  if (!res.ok) {
    const msg = json?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new PmGitError("GitHub 认证失败：token 无效或过期", 403);
    if (res.status === 404) throw new PmGitError("GitHub 仓库或条目不存在（检查 owner/repo 与权限）", 404);
    throw new PmGitError(`GitHub 错误：${msg}`, 502);
  }
  return json as T;
}

function mapIssue(raw: any): PmPlatformIssue {
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ""),
    body: String(raw.body ?? ""),
    state: raw.state === "closed" ? "closed" : "open",
    labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => (typeof l === "string" ? l : String(l?.name ?? ""))).filter(Boolean) : [],
    author: String(raw.user?.login ?? ""),
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    url: String(raw.html_url ?? ""),
    commentsCount: Number(raw.comments ?? 0),
  };
}

export const githubProvider: PmGitPlatformProvider = {
  type: "github",

  async listRepos(ctx) {
    const rows = await ghJson<any[]>(ctx, `${ctx.apiBase}/user/repos?per_page=100&sort=updated`);
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
    const rows = await ghJson<any[]>(ctx, `${ctx.apiBase}/repos/${owner}/${name}/issues?state=${state}&per_page=100`);
    return (Array.isArray(rows) ? rows : []).filter((r) => !r.pull_request).map(mapIssue);
  },

  async getIssue(ctx, repo, number) {
    const { owner, name } = repoPath(repo);
    return mapIssue(await ghJson<any>(ctx, `${ctx.apiBase}/repos/${owner}/${name}/issues/${number}`));
  },

  async createIssue(ctx, repo, input) {
    const { owner, name } = repoPath(repo);
    return mapIssue(
      await ghJson<any>(ctx, `${ctx.apiBase}/repos/${owner}/${name}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels ?? [] }),
      }),
    );
  },

  async updateIssue(ctx, repo, number, input) {
    const { owner, name } = repoPath(repo);
    return mapIssue(
      await ghJson<any>(ctx, `${ctx.apiBase}/repos/${owner}/${name}/issues/${number}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.state !== undefined ? { state: input.state } : {}),
          ...(input.labels !== undefined ? { labels: input.labels } : {}),
        }),
      }),
    );
  },

  async addComment(ctx, repo, number, body) {
    const { owner, name } = repoPath(repo);
    await ghJson<any>(ctx, `${ctx.apiBase}/repos/${owner}/${name}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  },
};

export { repoPath };
