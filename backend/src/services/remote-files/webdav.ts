/**
 * WebDAV 提供方：基于 webdav 客户端库（fast-xml-parser 解析多状态响应，库内统一处理
 * 命名空间、URL 编码与特殊文件名）。
 *
 * 认证：AuthType.Auto —— 先发 Basic，服务端要求 Digest（401 带 Digest 挑战）时库自动重试一次。
 * 多根：ctx.rootPaths 有值时源内路径第一段是根目录别名（对齐 SMB 多共享），"" 是虚拟根。
 * 删除：先整删；遇到 405/409（服务器不支持递归删目录）再逐层删子项后删空目录。
 */
import { AuthType, createClient, type FileStat, type WebDAVClient } from "webdav";
import {
  joinRemotePath,
  normalizeRemotePath,
  RemoteProviderError,
  type RemoteFileEntry,
  type RemoteProvider,
  type RemoteProviderContext,
  type RemoteRoot,
} from "./types";

function rootsOf(ctx: RemoteProviderContext): RemoteRoot[] {
  return (ctx.rootPaths || []).filter((root) => root && root.name && typeof root.path === "string");
}

/** 客户端根 = baseUrl + 根目录绝对路径（多根时用所选根的 path）。 */
function createDavClient(ctx: RemoteProviderContext, root?: RemoteRoot | null): WebDAVClient {
  const base = String(ctx.baseUrl || "").trim().replace(/\/+$/, "");
  const remoteRoot = root ? root.path : joinRemotePath(ctx.rootPath, "");
  return createClient(`${base}${remoteRoot === "/" ? "" : remoteRoot}`, {
    username: ctx.username || undefined,
    password: ctx.password || undefined,
    authType: AuthType.Auto,
  });
}

/** 源内路径 → 根目录 + 根内子路径；多根模式下第一段必须是已挂载的别名。 */
function resolveTarget(
  ctx: RemoteProviderContext,
  relPath: string,
): { root: RemoteRoot | null; subPath: string; isVirtualRoot: boolean } {
  const path = normalizeRemotePath(relPath);
  const roots = rootsOf(ctx);
  if (roots.length === 0) return { root: null, subPath: path, isVirtualRoot: false };
  if (!path) return { root: null, subPath: "", isVirtualRoot: true };
  const [name, ...rest] = path.split("/");
  const root = roots.find((item) => item.name === name);
  if (!root) throw new RemoteProviderError(`「${name}」不在该来源的根目录列表中`, 404);
  return { root, subPath: rest.join("/"), isVirtualRoot: false };
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/** 库抛出的错误带 HTTP status，这里统一翻成前端可直接展示的文案。 */
function toProviderError(error: unknown): RemoteProviderError {
  const status = statusOf(error);
  if (status === 401 || status === 403) return new RemoteProviderError("认证失败：请检查用户名/密码", 400);
  if (status === 404) return new RemoteProviderError("远程文件或目录不存在", 404);
  if (status !== null) return new RemoteProviderError(`远程服务器返回 ${status}`, 502);
  const detail = error instanceof Error ? error.message : String(error ?? "");
  return new RemoteProviderError(`连接失败：${detail}`, 502);
}

async function run<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw toProviderError(error);
  }
}

function normaliseRelative(raw: string): string {
  return String(raw ?? "").replace(/^\/+|\/+$/g, "");
}

function toEntry(stat: FileStat): RemoteFileEntry | null {
  const path = normaliseRelative(stat.filename);
  if (!path) return null;
  const lastmod = stat.lastmod ? new Date(stat.lastmod) : null;
  return {
    name: stat.basename || path.split("/").pop() || path,
    path,
    isFolder: stat.type === "directory",
    size: Number.isFinite(stat.size) ? stat.size : 0,
    modifiedAt: lastmod && !Number.isNaN(lastmod.getTime()) ? lastmod.toISOString() : null,
  };
}

/** 先整删；405/409 说明目录非空或服务器不支持递归删，改为逐层删除。 */
async function deleteRemotePath(client: WebDAVClient, relPath: string): Promise<void> {
  try {
    await client.deleteFile(relPath);
    return;
  } catch (error) {
    const status = statusOf(error);
    if (status !== 405 && status !== 409) throw toProviderError(error);
  }
  const children = await run(() => client.getDirectoryContents(relPath, { deep: false }));
  const childPaths = children.map((stat) => normaliseRelative(stat.filename)).filter((child) => child && child !== relPath);
  for (const child of childPaths) {
    await deleteRemotePath(client, child);
  }
  await run(() => client.deleteFile(relPath));
}

export const webdavProvider: RemoteProvider = {
  type: "webdav",
  displayName: "WebDAV",

  async list(ctx, path, opts) {
    const target = resolveTarget(ctx, path);
    if (target.isVirtualRoot) {
      const roots = rootsOf(ctx);
      const asEntries = (list: RemoteRoot[]) => list.map((root) => ({
        name: root.name,
        path: root.name,
        isFolder: true,
        size: 0,
        modifiedAt: null,
      }));
      // 常规浏览不访问远端；显式刷新（revalidate）时才逐个确认根目录还在，
      // 把远端已删除/改名的挂载根剔掉（404 = 不存在；其它错误保留显示）。
      if (!opts?.revalidate) return asEntries(roots);
      const visible: RemoteRoot[] = [];
      for (const root of roots) {
        try {
          await run(() => createDavClient(ctx, root).getDirectoryContents("", { deep: false }));
          visible.push(root);
        } catch (error) {
          if (statusOf(error) === 404) continue;
          visible.push(root);
        }
      }
      return asEntries(visible);
    }
    const client = createDavClient(ctx, target.root);
    const items = await run(() => client.getDirectoryContents(target.subPath, { deep: false }));
    const prefix = target.root ? `${target.root.name}/` : "";
    const entries: RemoteFileEntry[] = [];
    for (const stat of items) {
      const entry = toEntry(stat);
      if (!entry || entry.path === target.subPath) continue;
      entries.push({ ...entry, path: `${prefix}${entry.path}` });
    }
    entries.sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1));
    return entries;
  },

  async read(ctx, path) {
    const buffer = await webdavProvider.readBinary(ctx, path);
    return { content: buffer.toString("utf8"), size: buffer.length };
  },

  async readBinary(ctx, path) {
    const target = resolveTarget(ctx, path);
    if (target.isVirtualRoot) throw new RemoteProviderError("请先选择要读取的根目录", 400);
    const client = createDavClient(ctx, target.root);
    const data = await run(() => client.getFileContents(target.subPath, { format: "binary" }));
    return Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
  },

  async write(ctx, path, content) {
    await webdavProvider.writeBinary(ctx, path, Buffer.from(content, "utf8"));
  },

  async writeBinary(ctx, path, data) {
    const target = resolveTarget(ctx, path);
    if (target.isVirtualRoot) throw new RemoteProviderError("请先选择要写入的根目录", 400);
    const client = createDavClient(ctx, target.root);
    await run(() => client.putFileContents(target.subPath, data, { overwrite: true }));
  },

  async mkdir(ctx, path) {
    const target = resolveTarget(ctx, path);
    if (target.isVirtualRoot) throw new RemoteProviderError("请先选择要建目录的根目录", 400);
    const client = createDavClient(ctx, target.root);
    try {
      await client.createDirectory(target.subPath);
    } catch (error) {
      const status = statusOf(error);
      if (status === 405 || status === 409) throw new RemoteProviderError("目录已存在", 400);
      throw toProviderError(error);
    }
  },

  async remove(ctx, path) {
    const target = resolveTarget(ctx, path);
    if (target.isVirtualRoot) throw new RemoteProviderError("不能删除根目录", 400);
    await deleteRemotePath(createDavClient(ctx, target.root), target.subPath);
  },

  async rename(ctx, oldPath, newName) {
    const target = resolveTarget(ctx, oldPath);
    if (target.isVirtualRoot) throw new RemoteProviderError("不能重命名根目录", 400);
    const client = createDavClient(ctx, target.root);
    const parent = target.subPath.split("/").slice(0, -1).join("/");
    const next = parent ? `${parent}/${normalizeRemotePath(newName)}` : normalizeRemotePath(newName);
    await run(() => client.moveFile(target.subPath, next, { overwrite: false }));
  },
};
