/**
 * SMB 提供方 —— 基于 smb3-client（纯 TS / ESM，SMB2 ~ 3.1.1，支持 signing 与传输加密）。
 *
 * 共享枚举（routes/remote-files.ts 的 /smb/shares）与文件读写统一走这套协议栈：
 * - 不再依赖 @marsaud/smb2（对空根目录发 CREATE 会被部分 NAS 以 STATUS_INVALID_PARAMETER 拒绝，
 *   且不支持 SMB3 传输加密）；
 * - smb3-client 的 exports 只有 import 条件，dev 下 tsx 以 CJS 加载后端，
 *   因此用模块级缓存的原生 dynamic import，避免顶层静态 import 被转成 require。
 */
import type { ClientOptions, Dirent } from "smb3-client";
import {
  joinRemotePath,
  normalizeRemotePath,
  RemoteProviderError,
  type RemoteFileEntry,
  type RemoteProvider,
  type RemoteProviderContext,
} from "./types";

/** 单个反斜杠（动态构造，规避源码转义歧义） */
const BS = String.fromCharCode(92);

export interface SmbClientLike {
  readdir(path: string, opts?: { withFileTypes: true }): Promise<string[] | Dirent[]>;
  stat(path: string): Promise<{ isDirectory: boolean; size: number; mtime?: Date }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  close(): Promise<void>;
}

type SmbClientFactory = (opts: ClientOptions) => Promise<SmbClientLike>;
let clientFactory: SmbClientFactory | null = null;

/** 测试注入用：替换 SMB 客户端工厂。传 null 恢复真实实现。 */
export function setSmbClientFactory(factory: SmbClientFactory | null): void {
  clientFactory = factory;
}

let smb3Module: Promise<typeof import("smb3-client")> | null = null;
function loadSmb3(): Promise<typeof import("smb3-client")> {
  if (!smb3Module) smb3Module = import("smb3-client");
  return smb3Module;
}

async function createClient(opts: ClientOptions): Promise<SmbClientLike> {
  if (clientFactory) return clientFactory(opts);
  const { Client } = await loadSmb3();
  const client = new Client(opts);
  await client.connect();
  return client as unknown as SmbClientLike;
}

/**
 * 解析 baseUrl：UNC 或 smb://host[:445]/share → 完整 UNC 共享路径 + 端口。
 * 保留给源配置校验使用（历史契约，勿改返回结构）。
 */
export function parseSmbBaseUrl(baseUrl: string): { share: string; port: number } {
  const raw = String(baseUrl || "").trim();
  const smbUrl = raw.match(/^smb:\/\/([^\/:?#]+)(?::(\d+))?(?:\/(.+))?$/i);
  if (smbUrl) {
    const host = smbUrl[1];
    const port = smbUrl[2] ? parseInt(smbUrl[2], 10) : 445;
    const share = (smbUrl[3] || "").replaceAll("/", BS);
    if (!share) throw new RemoteProviderError("SMB 地址需包含共享名，例如 smb://192.168.100.3/share", 400);
    return { share: BS + BS + host + BS + share, port };
  }
  const unc = raw.replace(/^\\/, "");
  const parts = unc.split(new RegExp("[" + BS + BS + "/]")).filter(Boolean);
  if (parts.length < 2) {
    throw new RemoteProviderError("SMB 地址需包含共享名，例如 \\\\192.168.100.3\\share；或在界面点「获取共享」自动选择", 400);
  }
  return { share: BS + BS + parts[0] + BS + parts.slice(1).join(BS), port: 445 };
}

/** 解析成 smb3-client 需要的主机 + 共享名（路径第一段即共享名）。 */
export function parseSmbTarget(baseUrl: string): { host: string; port: number; shareName: string } {
  const raw = String(baseUrl || "").trim();
  const smbUrl = raw.match(/^smb:\/\/([^\/:?#]+)(?::(\d+))?(?:\/(.+))?$/i);
  if (smbUrl) {
    const shareName = (smbUrl[3] || "").split(/[\\/]/).filter(Boolean)[0] || "";
    if (!shareName) throw new RemoteProviderError("SMB 地址需包含共享名，例如 smb://192.168.100.3/share", 400);
    return { host: smbUrl[1], port: smbUrl[2] ? Number(smbUrl[2]) : 445, shareName };
  }
  const parts = raw.replace(/^\\+/, "").split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) {
    throw new RemoteProviderError("SMB 地址需包含共享名，例如 \\\\192.168.100.3\\share；或在界面点「获取共享」自动选择", 400);
  }
  return { host: parts[0], port: 445, shareName: parts[1] };
}

/** 源内相对路径 → smb3-client 路径（share/子路径，正斜杠）。 */
function targetPath(shareName: string, ctx: RemoteProviderContext, relPath: string): string {
  const joined = joinRemotePath(ctx.rootPath || "", normalizeRemotePath(relPath))
    .replaceAll(BS, "/")
    .replace(/^\/+|\/+$/g, "");
  return joined ? `${shareName}/${joined}` : shareName;
}

async function openClient(ctx: RemoteProviderContext): Promise<{ client: SmbClientLike; shareName: string }> {
  const { host, port, shareName } = parseSmbTarget(ctx.baseUrl);
  let client: SmbClientLike;
  try {
    client = await createClient({
      host,
      port,
      domain: ctx.domain || "",
      username: ctx.username || "",
      password: ctx.password || "",
      connectTimeout: 8000,
      requestTimeout: 20000,
      signing: "if-offered",
      encryption: "if-offered",
    });
  } catch (err) {
    // 连接 / 握手 / 认证失败统一转成业务错误，避免路由层兜底成 500。
    throw mapSmbError(err, "连接 SMB 主机失败");
  }
  return { client, shareName };
}

async function closeQuietly(client: SmbClientLike): Promise<void> {
  try { await client.close(); } catch { /* ignore */ }
}

/** NT_STATUS / fs code → 业务错误映射 */
function mapSmbError(err: unknown, fallbackMsg: string): RemoteProviderError {
  const detail = err as { code?: string; statusName?: string; message?: string } | null;
  // 不同层抛出的错误把关键字放在 code / statusName / message 的位置不一致，合并后判断。
  const code = [detail?.code, detail?.statusName, detail?.message, err instanceof Error ? err.message : String(err ?? "")]
    .filter(Boolean)
    .join(" | ");
  if (/ENOENT|OBJECT_NAME_NOT_FOUND|NO_SUCH_FILE/i.test(code)) return new RemoteProviderError("远程文件或目录不存在", 404);
  if (/EACCES|ACCESS_DENIED|LOGON_FAILURE|AUTH/i.test(code)) return new RemoteProviderError("SMB 认证失败或权限不足（检查用户名/密码/共享权限）", 403);
  if (/EEXIST|OBJECT_NAME_COLLISION|FILE_EXISTS/i.test(code)) return new RemoteProviderError("远程同名文件/目录已存在", 400);
  if (/ENOTEMPTY/i.test(code)) return new RemoteProviderError("目录非空，请先清空内容", 400);
  return new RemoteProviderError(`${fallbackMsg}: ${err instanceof Error ? err.message : String(err ?? "")}`, 502);
}

async function readdirEntries(client: SmbClientLike, path: string): Promise<Dirent[]> {
  const result = await client.readdir(path, { withFileTypes: true });
  return (Array.isArray(result) ? result : []) as Dirent[];
}

async function removeTree(client: SmbClientLike, dir: string): Promise<void> {
  const items = await readdirEntries(client, dir);
  for (const item of items) {
    const child = `${dir}/${item.name}`;
    if (item.isDirectory()) await removeTree(client, child);
    else await client.rm(child);
  }
  await client.rmdir(dir);
}

function sortEntries(entries: RemoteFileEntry[]): void {
  entries.sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1));
}

export const smbProvider: RemoteProvider = {
  type: "smb",
  displayName: "SMB",

  async list(ctx, path) {
    const dirPath = normalizeRemotePath(path);
    const { client, shareName } = await openClient(ctx);
    try {
      const dir = targetPath(shareName, ctx, dirPath);
      const items = await readdirEntries(client, dir);
      // 逐条 stat 获取类型/大小/时间（目录条目上限 200，避免大目录请求风暴）
      const entries = await Promise.all(
        items.slice(0, 200).map(async (item): Promise<RemoteFileEntry> => {
          const relative = dirPath ? `${dirPath}/${item.name}` : item.name;
          try {
            const st = await client.stat(`${dir}/${item.name}`);
            return {
              name: item.name,
              path: relative,
              isFolder: st.isDirectory,
              size: st.size || 0,
              modifiedAt: st.mtime ? new Date(st.mtime).toISOString() : null,
            };
          } catch {
            return { name: item.name, path: relative, isFolder: item.isDirectory(), size: 0, modifiedAt: null };
          }
        }),
      );
      sortEntries(entries);
      return entries;
    } catch (err) {
      throw mapSmbError(err, "读取 SMB 目录失败");
    } finally {
      await closeQuietly(client);
    }
  },

  async read(ctx, path) {
    const buffer = await smbProvider.readBinary(ctx, path);
    return { content: buffer.toString("utf8"), size: buffer.length };
  },

  async readBinary(ctx, path) {
    const { client, shareName } = await openClient(ctx);
    try {
      return await client.readFile(targetPath(shareName, ctx, path));
    } catch (err) {
      throw mapSmbError(err, "读取 SMB 文件失败");
    } finally {
      await closeQuietly(client);
    }
  },

  async write(ctx, path, content) {
    await smbProvider.writeBinary(ctx, path, Buffer.from(content, "utf8"));
  },

  async writeBinary(ctx, path, data) {
    const { client, shareName } = await openClient(ctx);
    try {
      await client.writeFile(targetPath(shareName, ctx, path), data);
    } catch (err) {
      throw mapSmbError(err, "写入 SMB 文件失败");
    } finally {
      await closeQuietly(client);
    }
  },

  async mkdir(ctx, path) {
    const { client, shareName } = await openClient(ctx);
    try {
      await client.mkdir(targetPath(shareName, ctx, path));
    } catch (err) {
      throw mapSmbError(err, "创建 SMB 目录失败");
    } finally {
      await closeQuietly(client);
    }
  },

  async remove(ctx, path) {
    const { client, shareName } = await openClient(ctx);
    try {
      const target = targetPath(shareName, ctx, path);
      const st = await client.stat(target);
      if (st.isDirectory) await removeTree(client, target);
      else await client.rm(target);
    } catch (err) {
      throw mapSmbError(err, "删除 SMB 文件失败");
    } finally {
      await closeQuietly(client);
    }
  },

  async rename(ctx, path, newName) {
    const { client, shareName } = await openClient(ctx);
    try {
      const from = targetPath(shareName, ctx, path);
      const parent = normalizeRemotePath(path).split("/").slice(0, -1).join("/");
      const to = `${targetPath(shareName, ctx, parent)}/${newName}`;
      await client.rename(from, to);
    } catch (err) {
      throw mapSmbError(err, "SMB 重命名失败");
    } finally {
      await closeQuietly(client);
    }
  },
};
