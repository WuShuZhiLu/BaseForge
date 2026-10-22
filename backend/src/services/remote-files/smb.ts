/**
 * SMB 提供方 —— 基于 @marsaud/smb2（纯 JS SMB2/3.0.2 客户端）。
 *
 * 三形态通吃（桌面 Electron / NAS Docker / 云服务器 Linux）：纯用户态协议实现，
 * 不依赖 OS 挂载与凭据缓存。
 * 已知边界（docs/plugin-remote-files.md）：
 * - 不支持 SMB3 传输加密：NAS 开启「强制加密」时连接失败（需 NAS 侧关闭或改用 WebDAV）；
 * - dialect 协商上限 3.0.2；
 * - readFile/writeFile 全量内存，附件桥接侧另有大小上限。
 */
import SMB2 from "@marsaud/smb2";

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

export interface Smb2ClientLike {
  readdir(path: string, cb: (err: unknown, files: string[]) => void): void;
  stat(path: string, cb: (err: unknown, stats: { isDirectory(): boolean; size: number; mtime?: Date }) => void): void;
  readFile(path: string, cb: (err: unknown, data: Buffer) => void): void;
  writeFile(path: string, data: Buffer, cb: (err: unknown) => void): void;
  mkdir(path: string, cb: (err: unknown) => void): void;
  rename(from: string, to: string, cb: (err: unknown) => void): void;
  unlink(path: string, cb: (err: unknown) => void): void;
  rmdir(path: string, cb: (err: unknown) => void): void;
  close?(cb?: (err: unknown) => void): void;
}

type Smb2Factory = (cfg: Record<string, unknown>) => Smb2ClientLike;
let smb2Factory: Smb2Factory = (cfg) => new (SMB2 as unknown as new (cfg: Record<string, unknown>) => Smb2ClientLike)(cfg);

/** 测试注入用：替换 SMB2 客户端工厂 */
export function setSmb2Factory(factory: Smb2Factory): void {
  smb2Factory = factory;
}

/** 解析 baseUrl：UNC 或 smb://host[:445]/share → { share, port } */
export function parseSmbBaseUrl(baseUrl: string): { share: string; port: number } {
  const raw = String(baseUrl || "").trim();
  const smbUrl = raw.match(/^smb:\/\/([^\/:?#]+)(?::(\d+))?(?:\/(.+))?$/i);
  if (smbUrl) {
    const host = smbUrl[1];
    const port = smbUrl[2] ? parseInt(smbUrl[2], 10) : 445;
    const share = (smbUrl[3] || "").replaceAll("/", BS);
    if (!share) throw new RemoteProviderError("SMB 地址需包含共享名（smb://主机/共享名）", 400);
    return { share: BS + BS + host + BS + share, port };
  }
  const unc = raw.replace(/^\\/, "");
  const parts = unc.split(new RegExp("[" + BS + BS + "/]")).filter(Boolean);
  if (parts.length < 2) {
    throw new RemoteProviderError("SMB 地址格式不正确：UNC（双反斜杠开头）或 smb://主机/共享名", 400);
  }
  return { share: BS + BS + parts[0] + BS + parts.slice(1).join(BS), port: 445 };
}

/** 源内相对路径（/ 分隔）→ SMB 路径（share 内相对，BS 分隔，带 rootPath 前缀） */
function toSmbPath(ctx: RemoteProviderContext, relPath: string): string {
  return joinRemotePath(ctx.rootPath, relPath).split("/").join(BS);
}

function clientFor(ctx: RemoteProviderContext): Smb2ClientLike {
  const { share, port } = parseSmbBaseUrl(ctx.baseUrl);
  const client = smb2Factory({
    share,
    port,
    domain: ctx.domain || undefined,
    username: ctx.username || undefined,
    password: ctx.password || "",
    autoCloseTimeout: 10000,
  });
  return client;
}

function p<T>(run: (cb: (err: unknown, res: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => run((err, res) => (err ? reject(err) : resolve(res))));
}

function closeQuietly(client: Smb2ClientLike): void {
  try {
    client.close?.();
  } catch {
    /* ignore */
  }
}

/** NT_STATUS → 业务错误映射 */
function mapSmbError(err: unknown, fallbackMsg: string): RemoteProviderError {
  const code = String((err as { code?: string })?.code || (err instanceof Error ? err.message : String(err ?? "")));
  if (/OBJECT_NAME_NOT_FOUND|NO_SUCH_FILE/i.test(code)) return new RemoteProviderError("远程文件或目录不存在", 404);
  if (/ACCESS_DENIED|LOGON_FAILURE/i.test(code)) return new RemoteProviderError("SMB 认证失败或权限不足（检查用户名/密码/共享权限）", 403);
  if (/OBJECT_NAME_COLLISION|FILE_EXISTS/i.test(code)) return new RemoteProviderError("远程同名文件/目录已存在", 400);
  if (/ENOTEMPTY/i.test(code)) return new RemoteProviderError("目录非空，请先清空内容", 400);
  return new RemoteProviderError(`${fallbackMsg}: ${err instanceof Error ? err.message : String(err ?? "")}`, 502);
}

async function statEntry(client: Smb2ClientLike, smbPath: string): Promise<{ isDirectory(): boolean; size: number; mtime?: Date }> {
  return p<{ isDirectory(): boolean; size: number; mtime?: Date }>((cb) => client.stat(smbPath, cb));
}

async function removeTree(client: Smb2ClientLike, smbDir: string): Promise<void> {
  const names = await p<string[]>((cb) => client.readdir(smbDir, cb));
  for (const name of names) {
    const child = smbDir + BS + name;
    const st = await statEntry(client, child);
    if (st.isDirectory()) await removeTree(client, child);
    else await p<void>((cb) => client.unlink(child, cb));
  }
  await p<void>((cb) => client.rmdir(smbDir, cb));
}

export const smbProvider: RemoteProvider = {
  type: "smb",
  displayName: "SMB",

  async list(ctx, path) {
    const dirPath = normalizeRemotePath(path);
    const client = clientFor(ctx);
    try {
      const smbDir = toSmbPath(ctx, dirPath);
      const names = await p<string[]>((cb) => client.readdir(smbDir, cb));
      // 逐条 stat 获取类型/大小/时间（目录条目上限 200，避免大目录请求风暴）
      const entries = await Promise.all(
        names.slice(0, 200).map(async (name) => {
          const relative = dirPath ? `${dirPath}/${name}` : name;
          try {
            const st = await statEntry(client, smbDir + BS + name);
            return {
              name,
              path: relative,
              isFolder: st.isDirectory(),
              size: st.size || 0,
              modifiedAt: st.mtime ? new Date(st.mtime).toISOString() : null,
            } as RemoteFileEntry;
          } catch {
            return { name, path: relative, isFolder: false, size: 0, modifiedAt: null } as RemoteFileEntry;
          }
        }),
      );
      entries.sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1));
      return entries;
    } catch (err) {
      throw mapSmbError(err, "读取 SMB 目录失败");
    } finally {
      closeQuietly(client);
    }
  },

  async read(ctx, path) {
    const buffer = await smbProvider.readBinary(ctx, path);
    return { content: buffer.toString("utf8"), size: buffer.length };
  },

  async readBinary(ctx, path) {
    const client = clientFor(ctx);
    try {
      return await p<Buffer>((cb) => client.readFile(toSmbPath(ctx, path), cb));
    } catch (err) {
      throw mapSmbError(err, "读取 SMB 文件失败");
    } finally {
      closeQuietly(client);
    }
  },

  async write(ctx, path, content) {
    await smbProvider.writeBinary(ctx, path, Buffer.from(content, "utf8"));
  },

  async writeBinary(ctx, path, data) {
    const client = clientFor(ctx);
    try {
      await p<void>((cb) => client.writeFile(toSmbPath(ctx, path), data, cb));
    } catch (err) {
      throw mapSmbError(err, "写入 SMB 文件失败");
    } finally {
      closeQuietly(client);
    }
  },

  async mkdir(ctx, path) {
    const client = clientFor(ctx);
    try {
      await p<void>((cb) => client.mkdir(toSmbPath(ctx, path), cb));
    } catch (err) {
      throw mapSmbError(err, "创建 SMB 目录失败");
    } finally {
      closeQuietly(client);
    }
  },

  async remove(ctx, path) {
    const client = clientFor(ctx);
    try {
      const smbPath = toSmbPath(ctx, path);
      const st = await statEntry(client, smbPath);
      if (st.isDirectory()) await removeTree(client, smbPath);
      else await p<void>((cb) => client.unlink(smbPath, cb));
    } catch (err) {
      throw mapSmbError(err, "删除 SMB 文件失败");
    } finally {
      closeQuietly(client);
    }
  },

  async rename(ctx, path, newName) {
    const client = clientFor(ctx);
    try {
      const from = toSmbPath(ctx, path);
      const parent = normalizeRemotePath(path).split("/").slice(0, -1).join("/");
      const to = toSmbPath(ctx, parent) + BS + newName;
      await p<void>((cb) => client.rename(from, to, cb));
    } catch (err) {
      throw mapSmbError(err, "SMB 重命名失败");
    } finally {
      closeQuietly(client);
    }
  },
};
