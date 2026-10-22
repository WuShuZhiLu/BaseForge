/**
 * git 平台注册表 + 源存储（KV remote_note_links 同款模式，token 加密）。
 */
import { systemSettingsRepository } from "../../repositories";
import { decryptSecret, encryptSecret } from "../remote-files/credentials";
import { PmGitError, type PmGitContext, type PmGitPlatformProvider, type PmGitSourceConfig, type PmGitSourceType } from "./types";
import { githubProvider } from "./github";
import { gitlabProvider } from "./gitlab";
import { giteaProvider } from "./gitea";

export const PM_GIT_PROVIDERS: Record<PmGitSourceType, PmGitPlatformProvider> = {
  github: githubProvider,
  gitlab: gitlabProvider,
  gitea: giteaProvider,
};

export const PM_GIT_SOURCE_TYPES: PmGitSourceType[] = ["github", "gitlab", "gitea"];

const SOURCES_KEY = "pm_git_sources:";

function sourcesKey(userId: string): string {
  return SOURCES_KEY + userId;
}

export function readPmGitSources(userId: string): PmGitSourceConfig[] {
  try {
    const row = systemSettingsRepository.get(sourcesKey(userId));
    const parsed = row?.value ? JSON.parse(row.value) : [];
    return Array.isArray(parsed) ? (parsed as PmGitSourceConfig[]) : [];
  } catch {
    return [];
  }
}

export function writePmGitSources(userId: string, sources: PmGitSourceConfig[]): void {
  systemSettingsRepository.set(sourcesKey(userId), JSON.stringify(sources));
}

export function resolvePmGitContext(userId: string, sourceId: string): { source: PmGitSourceConfig; provider: PmGitPlatformProvider; ctx: PmGitContext } {
  const source = readPmGitSources(userId).find((s) => s.id === sourceId);
  if (!source) throw new PmGitError("平台源不存在", 404);
  const provider = PM_GIT_PROVIDERS[source.type];
  if (!provider) throw new PmGitError("不支持的平台类型", 400);
  return {
    source,
    provider,
    ctx: { apiBase: source.apiBase, token: decryptSecret(source.tokenEnc) },
  };
}

/** 各平台默认 API 地址（github/gitlab 云端；gitea 必填自建地址） */
export function defaultApiBase(type: PmGitSourceType): string {
  if (type === "github") return "https://api.github.com";
  if (type === "gitlab") return "https://gitlab.com/api/v4";
  return "";
}

export { encryptSecret };
