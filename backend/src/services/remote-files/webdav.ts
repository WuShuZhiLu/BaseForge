/**
 * WebDAV 提供方：PROPFIND 列目录 / GET 读取 / PUT 写回 / MKCOL 建目录 / DELETE 删除 / MOVE 重命名。
 *
 * 兼容性策略：
 * - 多状态 XML 用命名空间无关正则解析（Apache/Nginx/群晖/坚果云等 server 的前缀不同）；
 * - href 可能是完整 URL、URL 编码路径，统一 decode 后去掉 baseUrl/root 前缀；
 * - DELETE 目录带 Depth: infinity（RFC4918，多数实现支持递归）。
 */
import {
  joinRemotePath,
  normalizeRemotePath,
  RemoteProviderError,
  toRelativePath,
  type RemoteFileEntry,
  type RemoteProvider,
  type RemoteProviderContext,
} from "./types";

function requestUrl(ctx: RemoteProviderContext, path: string): string {
  const base = String(ctx.baseUrl || "").replace(/\/+$/, "");
  return `${base}${encodeURI(joinRemotePath(ctx.rootPath, path))}`;
}

function authHeaders(ctx: RemoteProviderContext, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (ctx.username || ctx.password) {
    const token = Buffer.from(`${ctx.username}:${ctx.password}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }
  return headers;
}

async function davRequest(
  ctx: RemoteProviderContext,
  method: string,
  path: string,
  extra: Record<string, string> = {},
  body?: string,
): Promise<Response> {
  const response = await fetch(requestUrl(ctx, path), {
    method,
    headers: authHeaders(ctx, extra),
    body,
  });
  if (!response.ok && response.status !== 207) {
    if (response.status === 401) throw new RemoteProviderError("认证失败：请检查用户名/密码", 400);
    if (response.status === 404) throw new RemoteProviderError("远程文件或目录不存在", 404);
    throw new RemoteProviderError(`远程服务器返回 ${response.status}`, 502);
  }
  return response;
}

/** 命名空间无关地取第一个标签文本。 */
function pickTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function parsePropfind(xml: string, ctx: RemoteProviderContext, dirPath: string): RemoteFileEntry[] {
  const entries: RemoteFileEntry[] = [];
  const responseBlocks = xml.match(/<(?:[A-Za-z0-9_]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?response>/gi) ?? [];
  for (const block of responseBlocks) {
    const href = pickTag(block, "href");
    if (!href) continue;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      /* 保留原值 */
    }
    const pathOnly = decoded.replace(/^[a-z]+:\/\//i, "").replace(/^[^/]+/, "");
    const relative = toRelativePath(ctx.rootPath, pathOnly);
    if (!relative || relative === normalizeRemotePath(dirPath)) continue; // 跳过目录自身
    const isFolder = /<(?:[A-Za-z0-9_]+:)?collection\b/i.test(block) || relative.endsWith("/");
    const size = parseInt(pickTag(block, "getcontentlength") || "0", 10) || 0;
    const modified = pickTag(block, "getlastmodified") || null;
    const name = relative.split("/").pop() || relative;
    entries.push({
      name,
      path: relative,
      isFolder: isFolder || !name.includes("."),
      size,
      modifiedAt: modified ? new Date(modified).toISOString() : null,
    });
  }
  entries.sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1));
  return entries;
}

export const webdavProvider: RemoteProvider = {
  type: "webdav",
  displayName: "WebDAV",

  async list(ctx, path) {
    const dirPath = normalizeRemotePath(path);
    const body = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`;
    const response = await davRequest(ctx, "PROPFIND", dirPath, {
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    }, body);
    const xml = await response.text();
    return parsePropfind(xml, ctx, dirPath);
  },

  async read(ctx, path) {
    const buffer = await webdavProvider.readBinary(ctx, path);
    return { content: buffer.toString("utf8"), size: buffer.length };
  },

  async readBinary(ctx, path) {
    const response = await davRequest(ctx, "GET", path);
    return Buffer.from(await response.arrayBuffer());
  },

  async write(ctx, path, content) {
    await webdavProvider.writeBinary(ctx, path, Buffer.from(content, "utf8"));
  },

  async writeBinary(ctx, path, data) {
    await davRequest(ctx, "PUT", path, { "Content-Type": "application/octet-stream" }, data as unknown as string);
  },

  async mkdir(ctx, path) {
    try {
      await davRequest(ctx, "MKCOL", path);
    } catch (error) {
      if (error instanceof RemoteProviderError && error.message.includes("405")) {
        throw new RemoteProviderError("目录已存在", 400);
      }
      throw error;
    }
  },

  async remove(ctx, path) {
    await davRequest(ctx, "DELETE", path, { Depth: "infinity" });
  },

  async rename(ctx, oldPath, newName) {
    const parent = normalizeRemotePath(oldPath).split("/").slice(0, -1).join("/");
    const target = parent ? `${parent}/${newName}` : newName;
    const destination = requestUrl(ctx, target);
    await davRequest(ctx, "MOVE", oldPath, { Destination: encodeURI(destination), Overwrite: "F" });
  },
};
