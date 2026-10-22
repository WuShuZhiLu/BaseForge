/**
 * 项目管理插件 —— git 平台集成类型。
 *
 * 支持平台：GitHub / GitLab / Gitea（PAT 认证，自建实例自定义 apiBase）。
 * 统一 PlatformIssue 模型：number（平台内编号）、state("open"/"closed")、labels(string[])。
 */
export type PmGitSourceType = "github" | "gitlab" | "gitea";

export interface PmGitSourceConfig {
  id: string;
  type: PmGitSourceType;
  name: string;
  apiBase: string;
  tokenEnc: string;
  createdAt: string;
}

export interface PmGitContext {
  apiBase: string;
  token: string;
}

export interface PmPlatformRepo {
  fullName: string;
  description: string;
  url: string;
  private: boolean;
  updatedAt: string | null;
}

export interface PmPlatformIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  commentsCount: number;
}

export interface PmPlatformComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface PmGitPlatformProvider {
  readonly type: PmGitSourceType;
  listRepos(ctx: PmGitContext): Promise<PmPlatformRepo[]>;
  listIssues(ctx: PmGitContext, repo: string, state: "open" | "closed" | "all"): Promise<PmPlatformIssue[]>;
  getIssue(ctx: PmGitContext, repo: string, number: number): Promise<PmPlatformIssue>;
  createIssue(ctx: PmGitContext, repo: string, input: { title: string; body: string; labels?: string[] }): Promise<PmPlatformIssue>;
  updateIssue(ctx: PmGitContext, repo: string, number: number, input: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] }): Promise<PmPlatformIssue>;
  addComment(ctx: PmGitContext, repo: string, number: number, body: string): Promise<void>;
}

/** 业务错误（message 透传前端 toast） */
export class PmGitError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PmGitError";
    this.status = status;
  }
}

export function repoPath(repo: string): { owner: string; name: string; encoded: string } {
  const parts = String(repo || "").split("/").filter(Boolean);
  if (parts.length < 2) throw new PmGitError("仓库标识格式应为 owner/repo", 400);
  return { owner: parts[0], name: parts.slice(1).join("/"), encoded: encodeURIComponent(parts[0] + "/" + parts.slice(1).join("/")) };
}
