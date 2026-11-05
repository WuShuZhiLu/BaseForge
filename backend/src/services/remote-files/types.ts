/**
 * 远程文件 —— 提供方抽象与共享类型（内核能力，非插件）。
 *
 * 设计（docs/remote-files.md）：
 * - 每个远程存储类型实现 RemoteProvider（list/read/write/mkdir/remove/rename）；
 * - 路径一律使用「源内相对路径」（不含 baseUrl 与 rootPath 前缀），以 / 分隔，
 *   根目录为 ""；越界（..）由 normalizeRemotePath 统一拒绝；
 * - 凭据在存储侧加密（credentials.ts），下发到前端时永远掩码。
 */

export type RemoteStorageType = "webdav" | "baidu" | "smb";

/** 用户配置的一个远程源（passwordEnc 为服务端加密后的凭据，永不下发明文）。 */
export interface RemoteSourceConfig {
  id: string;
  type: RemoteStorageType;
  name: string;
  baseUrl: string;
  username: string;
  passwordEnc: string;
  rootPath: string;
  /** 百度网盘：access_token（加密存储） */
  accessTokenEnc?: string;
  /** SMB：域/工作组（非机密，明文存储） */
  domain?: string;
  /** 百度 OAuth：API Key（明文非机密） */
  clientId?: string;
  /** 百度 OAuth：Secret Key（加密存储） */
  clientSecretEnc?: string;
  /** 百度 OAuth：refresh_token（加密存储），存在即可自动续期 */
  refreshTokenEnc?: string;
  /** 百度 OAuth：当前 access_token 过期时间（ISO） */
  tokenExpiresAt?: string;
  createdAt: string;
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  isFolder: boolean;
  size: number;
  modifiedAt: string | null;
}

export interface RemoteProviderContext {
  baseUrl: string;
  username: string;
  password: string;
  rootPath: string;
  accessToken?: string;
  domain?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

export interface RemoteProvider {
  readonly type: RemoteStorageType;
  readonly displayName: string;
  list(ctx: RemoteProviderContext, path: string): Promise<RemoteFileEntry[]>;
  read(ctx: RemoteProviderContext, path: string): Promise<{ content: string; size: number }>;
  /** 二进制读取（转本地附件用） */
  readBinary(ctx: RemoteProviderContext, path: string): Promise<Buffer>;
  write(ctx: RemoteProviderContext, path: string, content: string): Promise<void>;
  /** 二进制写回（附件另存到远程用） */
  writeBinary(ctx: RemoteProviderContext, path: string, data: Buffer): Promise<void>;
  mkdir(ctx: RemoteProviderContext, path: string): Promise<void>;
  remove(ctx: RemoteProviderContext, path: string): Promise<void>;
  rename(ctx: RemoteProviderContext, path: string, newName: string): Promise<void>;
}

/** 业务性错误（message 直接透传给前端 toast）。 */
export class RemoteProviderError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "RemoteProviderError";
    this.status = status;
  }
}

/** 规范化源内相对路径：拒绝越界，根目录返回 ""。 */
export function normalizeRemotePath(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  const segments: string[] = [];
  for (const part of trimmed.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new RemoteProviderError("路径不允许包含 ..", 400);
    if (part.includes("\\") || part.includes("\0")) throw new RemoteProviderError("路径包含非法字符", 400);
    segments.push(part);
  }
  return segments.join("/");
}

/** 拼接「源内路径」与 rootPath（rootPath 也做规范化），返回完整远端路径（以 / 开头）。 */
export function joinRemotePath(ctxRoot: string, relPath: string): string {
  const root = String(ctxRoot ?? "").replace(/^\/+|\/+$/g, "");
  const rel = normalizeRemotePath(relPath);
  const full = [root, rel].filter((part) => part.length > 0).join("/");
  return `/${full}`;
}

/** 去掉远端完整路径里的 baseUrl/root 前缀，转回源内相对路径。 */
export function toRelativePath(ctxRoot: string, fullPath: string): string {
  const root = `/${String(ctxRoot ?? "").replace(/^\/+|\/+$/g, "")}`;
  let value = String(fullPath ?? "");
  try {
    value = decodeURIComponent(value);
  } catch {
    /* 保持原值 */
  }
  if (root !== "/" && value.startsWith(root)) value = value.slice(root.length);
  return value.replace(/^\/+|\/+$/g, "");
}

/** 断言文本文件扩展名（编辑器只允许编辑文本类文档）。 */
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "json", "csv", "log", "yml", "yaml", "html", "htm", "css", "js", "ts",
  "py", "sh", "bat", "ini", "toml", "xml", "sql", "conf",
]);

export function isProbablyTextFile(name: string): boolean {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return ext === "" || TEXT_EXTENSIONS.has(ext);
}
