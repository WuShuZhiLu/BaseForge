/** GitLab 平台（REST v4）：PRIVATE-TOKEN 认证，labels 逗号串，issue 用 iid，项目路径 URL 编码。 */
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
    "PRIVATE-TOKEN": ctx.token,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function glJson<T = any>(ctx: PmGitContext, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: authHeaders(ctx, (init?.headers ?? {}) as Record<string, string>) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new PmGitError(`GitLab 返回异常（HTTP ${res.status}）`, 502);
  }
  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`;
    if (res.status === 401) throw new PmGitError("GitLab 认证失败：token 无效或过期", 403);
    if (res.status === 404) throw new PmGitError("GitLab 项目或条目不存在（检查路径与权限）", 404);
    throw new PmGitError(`GitLab 错误：${msg}`, 502);
  }
  return json as T;
}

function projectPath(ctx: PmGitContext, repo: string): string {
  const { encoded } = repoPath(repo);
  return `${ctx.apiBase}/projects/${encoded}`;
}

function mapIssue(raw: any): PmPlatformIssue {
  return {
    number: Number(raw.iid),
    title: String(raw.title ?? ""),
    body: String(raw.description ?? ""),
    state: raw.state === "closed" ? "closed" : "open",
    labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => (typeof l === "string" ? l : String(l?.title ?? ""))).filter(Boolean) : [],
    author: String(raw.author?.username ?? ""),
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    url: String(raw.web_url ?? ""),
    commentsCount: Number(raw.user_notes_count ?? 0),
  };
}

export const gitlabProvider: PmGitPlatformProvider = {
  type: "gitlab",

  async listRepos(ctx) {
    const rows = await glJson<any[]>(ctx, `${ctx.apiBase}/projects?membership=true&per_page=100&order_by=last_activity_at`);
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      fullName: String(r.path_with_namespace ?? ""),
      description: String(r.description ?? ""),
      url: String(r.web_url ?? ""),
      private: r.visibility !== "public",
      updatedAt: r.last_activity_at ?? null,
    }));
  },

  async listIssues(ctx, repo, state) {
    const base = projectPath(ctx, repo);
    const rows = await glJson<any[]>(ctx, `${base}/issues?state=${state}&per_page=100`);
    return (Array.isArray(rows) ? rows : []).map(mapIssue);
  },

  async getIssue(ctx, repo, number) {
    return mapIssue(await glJson<any>(ctx, `${projectPath(ctx, repo)}/issues/${number}`));
  },

  async createIssue(ctx, repo, input) {
    return mapIssue(
      await glJson<any>(ctx, `${projectPath(ctx, repo)}/issues`, {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          description: input.body,
          labels: (input.labels ?? []).join(","),
        }),
      }),
    );
  },

  async updateIssue(ctx, repo, number, input) {
    return mapIssue(
      await glJson<any>(ctx, `${projectPath(ctx, repo)}/issues/${number}`, {
        method: "PUT",
        body: JSON.stringify({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { description: input.body } : {}),
          ...(input.state !== undefined ? { state_event: input.state === "closed" ? "close" : "reopen" } : {}),
          ...(input.labels !== undefined ? { labels: (input.labels ?? []).join(",") } : {}),
        }),
      }),
    );
  },

  async addComment(ctx, repo, number, body) {
    await glJson<any>(ctx, `${projectPath(ctx, repo)}/issues/${number}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  },
};
