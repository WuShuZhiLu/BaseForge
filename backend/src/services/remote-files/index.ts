/**
 * 远程文件提供方注册表与源上下文（跨路由共享：routes/remote-files.ts 与 routes/files.ts）。
 */
import { systemSettingsRepository } from "../../repositories";
import { decryptSecret, hasUnreadableSecret, isLegacySecret, upgradeSecret } from "./credentials";
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

const BS = String.fromCharCode(92);

/**
 * SMB 源的「主机 + 共享列表」视图：新数据直读 host/shares；
 * 历史数据（只有 baseUrl=`\\host\share`）拆成 host + 单共享，供 UI 与路径解析共用。
 */
export function resolveSmbTargets(source: RemoteSourceConfig): { host: string; shares: string[] } {
  const declared = (source.shares || []).filter((name) => typeof name === "string" && name.trim());
  if (source.host && declared.length > 0) {
    return { host: source.host.trim(), shares: declared.map((name) => name.trim()) };
  }
  const raw = String(source.baseUrl || "").trim();
  const smbUrl = raw.match(/^smb:\/\/([^/:?#]+)(?::\d+)?\/(.+)$/i);
  if (smbUrl) {
    const shares = smbUrl[2].split(/[\\/]/).filter(Boolean);
    return { host: smbUrl[1], shares: shares.slice(0, 1) };
  }
  const parts = raw.replace(/^\\+/, "").split(/[\\/]/).filter(Boolean);
  return { host: parts[0] || "", shares: parts[1] ? [parts[1]] : [] };
}

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

/** 历史 v1 密文（JWT 派生）就地升级为 v2（独立密钥文件）；返回是否写回。 */
export function upgradeUserRemoteSecrets(userId: string): boolean {
  const sources = readUserRemoteSources(userId);
  let changed = false;
  const next = sources.map((source) => {
    const fields: Array<keyof RemoteSourceConfig> = [
      "passwordEnc",
      "accessTokenEnc",
      "clientSecretEnc",
      "refreshTokenEnc",
    ];
    let record = source;
    for (const field of fields) {
      const stored = String(record[field] || "");
      if (!isLegacySecret(stored)) continue;
      const upgraded = upgradeSecret(stored);
      if (upgraded !== stored) {
        record = { ...record, [field]: upgraded };
        changed = true;
      }
    }
    return record;
  });
  if (changed) {
    systemSettingsRepository.set(SOURCES_KEY_PREFIX + userId, JSON.stringify(next));
  }
  return changed;
}

/** 该源是否存有解不开的凭据（换机 / 换密钥 / 跨机恢复备份）：UI 需要提示重新输入密码。 */
export function sourceCredentialState(source: RemoteSourceConfig): "ok" | "unreadable" {
  const stored = [source.passwordEnc, source.accessTokenEnc, source.clientSecretEnc, source.refreshTokenEnc].filter(Boolean);
  return stored.some((value) => hasUnreadableSecret(String(value))) ? "unreadable" : "ok";
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
  const smb = source.type === "smb" ? resolveSmbTargets(source) : null;
  return {
    source,
    provider,
    ctx: {
      baseUrl: source.baseUrl,
      username: source.username,
      password: decryptSecret(source.passwordEnc),
      rootPath: source.rootPath,
      rootPaths: source.rootPaths,
      // 多共享只在「新数据」下启用（单共享仍走 baseUrl，保持历史链接路径不变）
      shares: smb && smb.shares.length > 0 && source.host ? smb.shares : undefined,
      host: smb ? smb.host : undefined,
      accessToken: decryptSecret(source.accessTokenEnc || ""),
      domain: source.domain || "",
      clientId: source.clientId || "",
      clientSecret: decryptSecret(source.clientSecretEnc || ""),
      refreshToken: decryptSecret(source.refreshTokenEnc || ""),
    },
  };
}

export const REMOTE_SOURCES_KEY_PREFIX = SOURCES_KEY_PREFIX;
export const SMB_PATH_SEPARATOR = BS;
