/**
 * 远程文件管理插件 —— 服务端入口。
 *
 * 职责：
 * - 源配置 CRUD（按用户隔离，存 system_settings KV `remote_files_sources:<userId>`，
 *   密码/access_token 用 credentials.ts 加密，接口下发时永远掩码）；
 * - 提供方注册表（webdav / baidu / smb stub）与统一错误映射；
 * - 文件操作代理（list/read/write/mkdir/remove/rename/test）。
 *
 * 安全边界：
 * - 全部端点要求登录（挂在全局 JWT 中间件之后），按 X-User-Id 隔离数据；
 * - 远程地址由用户自行配置（自托管 NAS 场景合法指向内网地址），不做内网拦截；
 * - 读取内容限制为文本类扩展名，编辑写回仅覆盖文本。
 */
import { Hono } from "hono";
import { systemSettingsRepository } from "../repositories";
import { getDb } from "../db/schema";
import { readAttachmentObject } from "../services/attachment-storage";
import { decryptSecret, encryptSecret } from "../services/remote-files/credentials";
import { REMOTE_PROVIDERS, readUserRemoteSources } from "../services/remote-files";
import { parseSmbBaseUrl } from "../services/remote-files/smb";
import {
  isProbablyTextFile,
  normalizeRemotePath,
  RemoteProviderError,
  type RemoteProvider,
  type RemoteSourceConfig,
  type RemoteStorageType,
} from "../services/remote-files/types";

const remoteFilesRouter = new Hono();

const PROVIDERS = REMOTE_PROVIDERS;

const SOURCE_TYPES: RemoteStorageType[] = ["webdav", "baidu", "smb"];

function sourcesKey(userId: string): string {
  return `remote_files_sources:${userId}`;
}

const readSources = readUserRemoteSources;

function writeSources(userId: string, sources: RemoteSourceConfig[]): void {
  systemSettingsRepository.set(sourcesKey(userId), JSON.stringify(sources));
}

function publicSource(source: RemoteSourceConfig): Record<string, unknown> {
  return {
    id: source.id,
    type: source.type,
    name: source.name,
    baseUrl: source.baseUrl,
    username: source.username,
    rootPath: source.rootPath,
    domain: source.domain || "",
    clientId: source.clientId || "",
    hasOAuth: Boolean(source.refreshTokenEnc),
    hasPassword: Boolean(source.passwordEnc) || Boolean(source.accessTokenEnc),
    createdAt: source.createdAt,
  };
}

interface RequestUser {
  userId: string;
  source: RemoteSourceConfig;
  provider: RemoteProvider;
  ctx: { baseUrl: string; username: string; password: string; rootPath: string; accessToken?: string };
}

type HonoJsonError = { status: number; body: Record<string, unknown> };

/** 解析请求上下文：用户 + 指定源 + 提供方 + 已解密凭据。 */
function resolveContext(c: any, sourceId: string): RequestUser | { error: HonoJsonError } {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return { error: { status: 401, body: { error: "未登录" } } };
  const sources = readSources(userId);
  const source = sources.find((item) => item.id === sourceId);
  if (!source) return { error: { status: 404, body: { error: "远程源不存在" } } };
  const provider = PROVIDERS[source.type];
  if (!provider) return { error: { status: 400, body: { error: "不支持的存储类型" } } };
  return {
    userId,
    source,
    provider,
    ctx: {
      baseUrl: source.baseUrl,
      username: source.username,
      password: decryptSecret(source.passwordEnc),
      rootPath: source.rootPath,
      accessToken: decryptSecret(source.accessTokenEnc || ""),
    },
  };
}

function isErr(value: unknown): value is { error: HonoJsonError } {
  return typeof value === "object" && value !== null && "error" in value;
}

function mapError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof RemoteProviderError) {
    return { status: error.status, body: { error: error.message, code: "REMOTE_PROVIDER" } };
  }
  console.warn("[remote-files] unexpected error:", error instanceof Error ? error.message : error);
  return { status: 500, body: { error: "远程文件操作失败", code: "REMOTE_FILES_INTERNAL" } };
}

// ===== 源配置管理 =====

remoteFilesRouter.get("/sources", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未登录" }, 401);
  const sources = readSources(userId).map(publicSource);
  return c.json({ sources, types: SOURCE_TYPES });
});

remoteFilesRouter.post("/sources", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  const type = SOURCE_TYPES.includes(body.type) ? (body.type as RemoteStorageType) : null;
  if (!type) return c.json({ error: "不支持的存储类型" }, 400);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) return c.json({ error: "请填写源名称" }, 400);
  if (type === "webdav") {
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    if (!/^https?:\/\//i.test(baseUrl)) return c.json({ error: "WebDAV 地址需以 http(s):// 开头" }, 400);
  }
  if (type === "baidu" && !(typeof body.accessToken === "string" && body.accessToken.trim())) {
    return c.json({ error: "请填写百度网盘 access_token" }, 400);
  }
  if (type === "smb") {
    try {
      parseSmbBaseUrl(typeof body.baseUrl === "string" ? body.baseUrl : "");
    } catch (err) {
      return c.json({ error: err instanceof RemoteProviderError ? err.message : "SMB 地址不合法" }, 400);
    }
  }

  const sources = readSources(userId);
  const now = new Date().toISOString();
  const existingIndex = body.id ? sources.findIndex((item) => item.id === body.id) : -1;
  const id = existingIndex >= 0 ? sources[existingIndex].id : `rf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record: RemoteSourceConfig = {
    id,
    type,
    name,
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim() : "",
    username: typeof body.username === "string" ? body.username.trim() : "",
    passwordEnc:
      typeof body.password === "string" && body.password.length > 0
        ? encryptSecret(body.password)
        : existingIndex >= 0
          ? sources[existingIndex].passwordEnc
          : "",
    rootPath: typeof body.rootPath === "string" ? normalizeRemotePath(body.rootPath) : existingIndex >= 0 ? sources[existingIndex].rootPath : "",
    accessTokenEnc:
      typeof body.accessToken === "string" && body.accessToken.trim()
        ? encryptSecret(body.accessToken.trim())
        : existingIndex >= 0
          ? sources[existingIndex].accessTokenEnc || ""
          : "",
    domain: typeof body.domain === "string" ? body.domain.trim().slice(0, 120) : existingIndex >= 0 ? sources[existingIndex].domain || "" : "",
    clientId: typeof body.clientId === "string" ? body.clientId.trim().slice(0, 120) : existingIndex >= 0 ? sources[existingIndex].clientId || "" : "",
    clientSecretEnc:
      typeof body.clientSecret === "string" && body.clientSecret.trim()
        ? encryptSecret(body.clientSecret.trim())
        : existingIndex >= 0
          ? sources[existingIndex].clientSecretEnc || ""
          : "",
    refreshTokenEnc:
      typeof body.refreshToken === "string" && body.refreshToken.trim()
        ? encryptSecret(body.refreshToken.trim())
        : existingIndex >= 0
          ? sources[existingIndex].refreshTokenEnc || ""
          : "",
    tokenExpiresAt: typeof body.tokenExpiresAt === "string" && body.tokenExpiresAt
      ? body.tokenExpiresAt
      : existingIndex >= 0
        ? sources[existingIndex].tokenExpiresAt
        : undefined,
    createdAt: existingIndex >= 0 ? sources[existingIndex].createdAt : now,
  };
  if (existingIndex >= 0) sources[existingIndex] = record;
  else sources.push(record);
  writeSources(userId, sources);
  return c.json({ source: publicSource(record) }, existingIndex >= 0 ? 200 : 201);
});

remoteFilesRouter.delete("/sources/:sourceId", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未登录" }, 401);
  const sourceId = c.req.param("sourceId");
  const sources = readSources(userId);
  const next = sources.filter((item) => item.id !== sourceId);
  if (next.length === sources.length) return c.json({ error: "远程源不存在" }, 404);
  writeSources(userId, next);
  return c.json({ success: true });
});

// ===== 文件操作代理 =====

function withSource(handler: (c: any, resolved: RequestUser) => Promise<Response>) {
  return async (c: any) => {
    const resolved = resolveContext(c, c.req.param("sourceId"));
    if (isErr(resolved)) return c.json(resolved.error.body, resolved.error.status as any);
    try {
      const fresh = await refreshBaiduTokenIfNeeded(resolved.userId, resolved.source);
      if (fresh) resolved.ctx.accessToken = fresh;
    } catch (err) {
      console.warn("[remote-files] baidu token refresh skipped:", err instanceof Error ? err.message : err);
    }
    try {
      return await handler(c, resolved);
    } catch (error) {
      const mapped = mapError(error);
      return c.json(mapped.body, mapped.status as any);
    }
  };
}

function readBody(c: any): Promise<Record<string, any>> {
  return c.req.json().catch(() => ({}) as Record<string, any>);
}

remoteFilesRouter.post("/sources/:sourceId/list", withSource(async (c, resolved) => {
  const body = await readBody(c);
  const path = normalizeRemotePath(String(body.path ?? ""));
  const entries = await resolved.provider.list(resolved.ctx, path);
  return c.json({ path, entries });
}));

remoteFilesRouter.post("/sources/:sourceId/read", withSource(async (c, resolved) => {
  const body = await readBody(c);
  const path = normalizeRemotePath(String(body.path ?? ""));
  if (!isProbablyTextFile(path)) {
    return c.json({ error: "仅支持编辑文本类文件（md/txt/json 等）" }, 400);
  }
  const result = await resolved.provider.read(resolved.ctx, path);
  return c.json({ path, ...result });
}));

remoteFilesRouter.post("/sources/:sourceId/write", withSource(async (c, resolved) => {
  const body = await readBody(c);
  const path = normalizeRemotePath(String(body.path ?? ""));
  if (!path) return c.json({ error: "缺少文件路径" }, 400);
  if (!isProbablyTextFile(path)) return c.json({ error: "仅支持写回文本类文件" }, 400);
  const content = typeof body.content === "string" ? body.content : "";
  await resolved.provider.write(resolved.ctx, path, content);
  return c.json({ success: true });
}));

remoteFilesRouter.post("/sources/:sourceId/mkdir", withSource(async (c, resolved) => {
  const body = await readBody(c);
  const path = normalizeRemotePath(String(body.path ?? ""));
  if (!path) return c.json({ error: "缺少目录路径" }, 400);
  await resolved.provider.mkdir(resolved.ctx, path);
  return c.json({ success: true });
}));

remoteFilesRouter.post("/sources/:sourceId/delete", withSource(async (c, resolved) => {
  const body = await readBody(c);
  const path = normalizeRemotePath(String(body.path ?? ""));
  if (!path) return c.json({ error: "缺少路径" }, 400);
  await resolved.provider.remove(resolved.ctx, path);
  return c.json({ success: true });
}));

remoteFilesRouter.post("/sources/:sourceId/rename", withSource(async (c, resolved) => {
  const body = await readBody(c);
  const path = normalizeRemotePath(String(body.path ?? ""));
  const newName = String(body.newName ?? "").trim();
  if (!path || !newName || newName.includes("/")) return c.json({ error: "参数不合法" }, 400);
  await resolved.provider.rename(resolved.ctx, path, newName);
  return c.json({ success: true });
}));

/**
 * 百度令牌自动续期：临近过期（<5min）且有 refresh_token 时刷新并写回源配置。
 * 刷新失败不阻断操作（降级用旧 token 尝试，由百度侧返回业务错误）。
 */
async function refreshBaiduTokenIfNeeded(userId: string, source: RemoteSourceConfig): Promise<string | null> {
  if (source.type !== "baidu") return null;
  if (!source.refreshTokenEnc || !source.clientId || !source.clientSecretEnc) return null;
  const expiresAt = source.tokenExpiresAt ? new Date(source.tokenExpiresAt).getTime() : 0;
  if (expiresAt - Date.now() > 5 * 60 * 1000) return null;
  const refreshToken = decryptSecret(source.refreshTokenEnc);
  const clientSecret = decryptSecret(source.clientSecretEnc);
  const url = `https://openapi.baidu.com/oauth/2.0/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(source.clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => null as any);
  if (!json?.access_token) {
    console.warn("[remote-files] baidu token refresh failed:", json?.error_description ?? json?.error ?? res.status);
    return null;
  }
  const sources = readSources(userId);
  const idx = sources.findIndex((item) => item.id === source.id);
  if (idx >= 0) {
    sources[idx] = {
      ...sources[idx],
      accessTokenEnc: encryptSecret(String(json.access_token)),
      refreshTokenEnc: encryptSecret(String(json.refresh_token ?? refreshToken)),
      tokenExpiresAt: new Date(Date.now() + Number(json.expires_in ?? 2592000) * 1000).toISOString(),
    };
    writeSources(userId, sources);
  }
  return String(json.access_token);
}

// 百度 OAuth：生成授权页链接（oob 模式，授权码由用户复制粘贴）
remoteFilesRouter.post("/baidu/authorize-url", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await readBody(c);
  const clientId = String(body.clientId ?? "").trim();
  if (!clientId) return c.json({ error: "缺少 API Key（client_id）" }, 400);
  return c.json({
    url: `https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=oob&scope=basic,netdisk&display=page`,
  });
});

// 百度 OAuth：授权码换令牌（无状态，令牌由前端随源表单一并保存）
remoteFilesRouter.post("/baidu/exchange", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await readBody(c);
  const code = String(body.code ?? "").trim();
  const clientId = String(body.clientId ?? "").trim();
  const clientSecret = String(body.clientSecret ?? "").trim();
  if (!code || !clientId || !clientSecret) return c.json({ error: "缺少授权码或应用凭据" }, 400);
  const url = `https://openapi.baidu.com/oauth/2.0/token?grant_type=authorization_code&code=${encodeURIComponent(code)}&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&redirect_uri=oob`;
  const res = await fetch(url);
  const json = await res.json().catch(() => null as any);
  if (!json?.access_token) {
    return c.json({ error: `换取令牌失败: ${json?.error_description ?? json?.error ?? res.status}` }, 502);
  }
  return c.json({
    accessToken: String(json.access_token),
    refreshToken: String(json.refresh_token ?? ""),
    expiresIn: Number(json.expires_in ?? 2592000),
  });
});

// 源级连接健康检查：用已保存凭据对指定源做一次 list 探测
remoteFilesRouter.post("/sources/:sourceId/test", withSource(async (c, resolved) => {
  const started = Date.now();
  await resolved.provider.list(resolved.ctx, "");
  return c.json({ success: true, latencyMs: Date.now() - started });
}));

// 附件另存到远程：读本地附件对象 → provider.writeBinary
remoteFilesRouter.post("/sources/:sourceId/save-attachment", withSource(async (c, resolved) => {
  const body = await readBody(c);
  const attachmentId = String(body.attachmentId ?? "");
  const destPath = normalizeRemotePath(String(body.path ?? ""));
  if (!attachmentId || !destPath) return c.json({ error: "缺少 attachmentId 或目标路径" }, 400);
  const row = getDb()
    .prepare("SELECT id, filename, path FROM attachments WHERE id = ? AND userId = ?")
    .get(attachmentId, resolved.userId) as { id: string; filename: string; path: string } | undefined;
  if (!row) return c.json({ error: "附件不存在" }, 404);
  const buffer = await readAttachmentObject(row.path);
  if (!buffer) return c.json({ error: "附件实体文件已丢失，无法另存" }, 404);
  await resolved.provider.writeBinary(resolved.ctx, destPath, buffer);
  return c.json({ success: true, path: destPath, size: buffer.length });
}));

// ===== 笔记级同步：远程文件 ↔ 本地笔记 的链接映射（KV，按用户隔离） =====
interface RemoteNoteLink {
  sourceId: string;
  remotePath: string;
  noteId: string;
  title: string;
  baseRemoteHash: string;
  baseNoteHash: string;
  syncedAt: string;
}
const LINKS_KEY_PREFIX = "remote_note_links:";

function readLinks(userId: string): RemoteNoteLink[] {
  try {
    const row = systemSettingsRepository.get(LINKS_KEY_PREFIX + userId);
    const parsed = row?.value ? JSON.parse(row.value) : [];
    return Array.isArray(parsed) ? (parsed as RemoteNoteLink[]) : [];
  } catch {
    return [];
  }
}

function writeLinks(userId: string, links: RemoteNoteLink[]): void {
  systemSettingsRepository.set(LINKS_KEY_PREFIX + userId, JSON.stringify(links));
}

remoteFilesRouter.get("/links", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未登录" }, 401);
  return c.json({ links: readLinks(userId) });
});

remoteFilesRouter.post("/links", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await readBody(c);
  const sourceId = String(body.sourceId ?? "");
  const remotePath = normalizeRemotePath(String(body.remotePath ?? ""));
  const noteId = String(body.noteId ?? "");
  if (!sourceId || !remotePath || !noteId) return c.json({ error: "缺少 sourceId/remotePath/noteId" }, 400);
  const links = readLinks(userId).filter(
    (l) => l.noteId !== noteId && !(l.sourceId === sourceId && l.remotePath === remotePath),
  );
  const link: RemoteNoteLink = {
    sourceId,
    remotePath,
    noteId,
    title: String(body.title ?? "").slice(0, 200),
    baseRemoteHash: String(body.baseRemoteHash ?? ""),
    baseNoteHash: String(body.baseNoteHash ?? ""),
    syncedAt: new Date().toISOString(),
  };
  links.push(link);
  writeLinks(userId, links);
  return c.json({ link });
});

remoteFilesRouter.post("/links/update", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await readBody(c);
  const sourceId = String(body.sourceId ?? "");
  const remotePath = normalizeRemotePath(String(body.remotePath ?? ""));
  const links = readLinks(userId);
  const link = links.find((l) => l.sourceId === sourceId && l.remotePath === remotePath);
  if (!link) return c.json({ error: "链接映射不存在" }, 404);
  if (typeof body.baseRemoteHash === "string") link.baseRemoteHash = body.baseRemoteHash;
  if (typeof body.baseNoteHash === "string") link.baseNoteHash = body.baseNoteHash;
  link.syncedAt = new Date().toISOString();
  writeLinks(userId, links);
  return c.json({ link });
});

remoteFilesRouter.post("/links/delete", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await readBody(c);
  const sourceId = String(body.sourceId ?? "");
  const remotePath = normalizeRemotePath(String(body.remotePath ?? ""));
  const links = readLinks(userId);
  const next = links.filter((l) => !(l.sourceId === sourceId && l.remotePath === remotePath));
  if (next.length === links.length) return c.json({ error: "链接映射不存在" }, 404);
  writeLinks(userId, next);
  return c.json({ success: true });
});

// 连接测试（创建/编辑源时「测试连接」按钮）
remoteFilesRouter.post("/sources/test", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await readBody(c);
  const type = SOURCE_TYPES.includes(body.type) ? (body.type as RemoteStorageType) : null;
  if (!type) return c.json({ error: "不支持的存储类型" }, 400);
  const provider = PROVIDERS[type];
  const ctx = {
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim() : "",
    username: typeof body.username === "string" ? body.username.trim() : "",
    password: typeof body.password === "string" ? body.password : "",
    rootPath: typeof body.rootPath === "string" ? body.rootPath : "",
    accessToken: typeof body.accessToken === "string" ? body.accessToken : "",
  };
  try {
    await provider.list(ctx, "");
    return c.json({ success: true });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status as any);
  }
});

export default remoteFilesRouter;
