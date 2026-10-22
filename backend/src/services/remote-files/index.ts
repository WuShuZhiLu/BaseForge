/**
 * 远程文件提供方注册表与源上下文（跨路由共享：routes/remote-files.ts 与 routes/files.ts）。
 */
import { systemSettingsRepository } from "../../repositories";
import { decryptSecret } from "./credentials";
import { webdavProvider } from "./webdav";
import { baiduProvider } from "./baidu";
import { smbProvider } from "./smb";
import type { RemoteProvider, RemoteProviderContext, RemoteSourceConfig, RemoteStorageType } from "./types";

export const REMOTE_PROVIDERS: Record<RemoteStorageType, RemoteProvider> = {
  webdav: webdavProvider,
  baidu: baiduProvider,
  smb: smbProvider,
};

const SOURCES_KEY_PREFIX = "remote_files_sources:";

export function readUserRemoteSources(userId: string): RemoteSourceConfig[] {
  try {
    const row = systemSettingsRepository.get(SOURCES_KEY_PREFIX + userId);
    if (!row || !row.value) return [];
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed) ? (parsed as RemoteSourceConfig[]) : [];
  } catch (error) {
    console.warn("[remote-files] read sources failed:", error instanceof Error ? error.message : error);
    return [];
  }
}

/** 按用户解析远程源：提供方 + 已解密凭据上下文；源不存在返回 null。 */
export function resolveRemoteSourceContext(
  userId: string,
  sourceId: string,
): { source: RemoteSourceConfig; provider: RemoteProvider; ctx: RemoteProviderContext } | null {
  const source = readUserRemoteSources(userId).find((item) => item.id === sourceId);
  if (!source) return null;
  const provider = REMOTE_PROVIDERS[source.type];
  if (!provider) return null;
  return {
    source,
    provider,
    ctx: {
      baseUrl: source.baseUrl,
      username: source.username,
      password: decryptSecret(source.passwordEnc),
      rootPath: source.rootPath,
      accessToken: decryptSecret(source.accessTokenEnc || ""),
      domain: source.domain || "",
      clientId: source.clientId || "",
      clientSecret: decryptSecret(source.clientSecretEnc || ""),
      refreshToken: decryptSecret(source.refreshTokenEnc || ""),
    },
  };
}
