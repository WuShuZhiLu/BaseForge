/**
 * 百度网盘提供方（基于百度网盘开放平台 REST API）。
 *
 * - 授权：用户在百度开放平台创建应用后，手动粘贴 access_token（长期令牌）；
 * - list：/rest/2.0/xpan/file?method=list
 * - read：filemetas 取 dlink → 下载（带 User-Agent）
 * - write：≤4MB 走 superfile2 单发；>4MB 走 precreate → 分片 superfile2 → create 三段流
 * - remove/rename：/api/filemanager
 * 已知限制：频繁调用有限流；大文件分片逐片顺序上传。
 */
import crypto from "crypto";

import {
  joinRemotePath,
  normalizeRemotePath,
  RemoteProviderError,
  toRelativePath,
  type RemoteFileEntry,
  type RemoteProvider,
  type RemoteProviderContext,
} from "./types";

const PAN_BASE = "https://pan.baidu.com";
const USER_AGENT = "nowen-remote-files/1.0";

/** xpan/file 表单类调用（precreate/create），统一 JSON 与 errno 解析 */
async function panJsonForm(token: string, method: string, fields: Record<string, string>): Promise<any> {
  const url = `${PAN_BASE}/rest/2.0/xpan/file?method=${method}&access_token=${encodeURIComponent(token)}`;
  return panJson(url, { method: "POST", body: new URLSearchParams(fields), headers: { "User-Agent": USER_AGENT } });
}

/** superfile2 单分片上传（uploadid 缺省 = 单发覆盖语义） */
async function uploadSinglePart(token: string, remotePath: string, data: Buffer, partseq: number, uploadid?: string): Promise<void> {
  const uploadidQ = uploadid ? `&uploadid=${encodeURIComponent(uploadid)}&partseq=${partseq}` : "";
  const url = `${PAN_BASE}/rest/2.0/pcs/superfile2?method=upload&access_token=${encodeURIComponent(token)}&type=object&path=${encodeURIComponent(remotePath)}${uploadidQ}`;
  const form = new FormData();
   form.append("file", new Blob([new Uint8Array(data)], { type: "application/octet-stream" }), remotePath.split("/").pop() || "file.bin");
  const response = await fetch(url, { method: "POST", body: form, headers: { "User-Agent": USER_AGENT } });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RemoteProviderError(`百度网盘上传返回异常（HTTP ${response.status}）`, 502);
  }
  if (json && typeof json.errno === "number" && json.errno !== 0) {
    throw new RemoteProviderError(`百度网盘上传失败 errno=${json.errno}`, 502);
  }
  if (!response.ok) throw new RemoteProviderError(`百度网盘上传失败（HTTP ${response.status}）`, 502);
}

function requireToken(ctx: RemoteProviderContext): string {
  const token = String(ctx.accessToken || "").trim();
  if (!token) throw new RemoteProviderError("百度网盘未配置 access_token", 400);
  return token;
}

function fullRemotePath(ctx: RemoteProviderContext, path: string): string {
  return joinRemotePath(ctx.rootPath, path);
}

async function panJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RemoteProviderError(`百度网盘返回异常（HTTP ${response.status}）`, 502);
  }
  if (json && typeof json.errno === "number" && json.errno !== 0) {
    const friendly: Record<number, string> = {
      [-6]: "百度 access_token 无效或已过期",
      31064: "文件不存在",
      [-8]: "远程同名文件/目录已存在",
      12: "百度网盘接口限流，请稍后重试",
    };
    throw new RemoteProviderError(`百度网盘错误 errno=${json.errno}${friendly[json.errno] ? `：${friendly[json.errno]}` : ""}`, 502);
  }
  if (!response.ok) throw new RemoteProviderError(`百度网盘返回 HTTP ${response.status}`, 502);
  return json;
}

export const baiduProvider: RemoteProvider = {
  type: "baidu",
  displayName: "百度网盘",

  async list(ctx, path) {
    const token = requireToken(ctx);
    const dir = fullRemotePath(ctx, path);
    const url = `${PAN_BASE}/rest/2.0/xpan/file?method=list&access_token=${encodeURIComponent(token)}&dir=${encodeURIComponent(dir || "/")}&limit=1000&web=1`;
    const json = await panJson(url);
    const list = Array.isArray(json.list) ? json.list : [];
    const entries: RemoteFileEntry[] = list.map((item: any) => {
      const fullPath = String(item.path || "/");
      // 百度返回带 root 的完整路径（/docs/xx），剥掉 rootPath 前缀转为源内相对路径
      const relative = normalizeRemotePath(toRelativePath(ctx.rootPath, fullPath));
      return {
        name: String(item.server_filename || relative.split("/").pop() || ""),
        path: relative,
        isFolder: Number(item.isdir) === 1,
        size: Number(item.size) || 0,
        modifiedAt: item.server_mtime ? new Date(Number(item.server_mtime) * 1000).toISOString() : null,
      };
    });
    entries.sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1));
    return entries;
  },

  async read(ctx, path) {
    const buffer = await baiduProvider.readBinary(ctx, path);
    return { content: buffer.toString("utf8"), size: buffer.length };
  },

  async readBinary(ctx, path) {
    const token = requireToken(ctx);
    const remotePath = fullRemotePath(ctx, path);
    const metaUrl = `${PAN_BASE}/rest/2.0/xpan/multimedia?method=filemetas&access_token=${encodeURIComponent(token)}&fsids=[${(await resolveFsId(ctx, remotePath)) ?? 0}]&dlink=1`;
    const meta = await panJson(metaUrl);
    const dlink = String(meta?.list?.[0]?.dlink || "");
    if (!dlink) throw new RemoteProviderError("百度网盘未返回下载链接", 502);
    const response = await fetch(dlink, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) throw new RemoteProviderError(`下载失败（HTTP ${response.status}）`, 502);
    return Buffer.from(await response.arrayBuffer());
  },

  async write(ctx, path, content) {
    await baiduProvider.writeBinary(ctx, path, Buffer.from(content, "utf8"));
  },

  async writeBinary(ctx, path, data) {
    const token = requireToken(ctx);
    const remotePath = fullRemotePath(ctx, path);
    const CHUNK = 4 * 1024 * 1024;
    if (data.length <= CHUNK) {
      await uploadSinglePart(token, remotePath, data, 0, undefined);
      return;
    }
    // >4MB：precreate → 逐片 superfile2 → create 合并
    const parts: Buffer[] = [];
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      parts.push(data.subarray(offset, Math.min(offset + CHUNK, data.length)));
    }
    const blockList = parts.map((p) => crypto.createHash("md5").update(p).digest("hex"));
    const pre = await panJsonForm(token, "precreate", {
      path: remotePath,
      size: String(data.length),
      isdir: "0",
      autoinit: "1",
      block_list: JSON.stringify(blockList),
    });
    const uploadid = String(pre.uploadid ?? "");
    if (!uploadid) throw new RemoteProviderError("百度网盘 precreate 未返回 uploadid", 502);
    for (let seq = 0; seq < parts.length; seq++) {
      await uploadSinglePart(token, remotePath, parts[seq], seq, uploadid);
    }
    await panJsonForm(token, "create", {
      path: remotePath,
      size: String(data.length),
      uploadid,
      isdir: "0",
      block_list: JSON.stringify(blockList),
    });
  },

  async mkdir(ctx, path) {
    const token = requireToken(ctx);
    const dir = fullRemotePath(ctx, path);
    const url = `${PAN_BASE}/rest/2.0/xpan/file?method=create&access_token=${encodeURIComponent(token)}`;
    const body = new URLSearchParams({ path: dir, isdir: "1", block_list: "[]" });
    const response = await fetch(url, { method: "POST", body, headers: { "User-Agent": USER_AGENT } });
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RemoteProviderError(`百度网盘返回异常（HTTP ${response.status}）`, 502);
    }
    if (json && typeof json.errno === "number" && json.errno !== 0 && json.errno !== -8) {
      throw new RemoteProviderError(`创建目录失败 errno=${json.errno}`, 502);
    }
  },

  async remove(ctx, path) {
    const token = requireToken(ctx);
    const remotePath = fullRemotePath(ctx, path);
    const url = `${PAN_BASE}/api/filemanager?access_token=${encodeURIComponent(token)}&filelist=${encodeURIComponent(JSON.stringify([remotePath]))}`;
    const response = await fetch(`${url}&a=delete`, { method: "POST", headers: { "User-Agent": USER_AGENT } });
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RemoteProviderError(`百度网盘返回异常（HTTP ${response.status}）`, 502);
    }
    if (json && typeof json.errno === "number" && json.errno !== 0) {
      throw new RemoteProviderError(`删除失败 errno=${json.errno}`, 502);
    }
  },

  async rename(ctx, oldPath, newName) {
    const token = requireToken(ctx);
    const remotePath = fullRemotePath(ctx, oldPath);
    const parent = remotePath.split("/").slice(0, -1).join("/") || "/";
    const filelist = JSON.stringify([{ path: remotePath, newname: newName, newlocal_ctime: String(Math.floor(Date.now() / 1000)) }]);
    const url = `${PAN_BASE}/api/filemanager?access_token=${encodeURIComponent(token)}&a=rename&filelist=${encodeURIComponent(filelist)}`;
    void parent;
    const response = await fetch(url, { method: "POST", headers: { "User-Agent": USER_AGENT } });
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RemoteProviderError(`百度网盘返回异常（HTTP ${response.status}）`, 502);
    }
    if (json && typeof json.errno === "number" && json.errno !== 0) {
      throw new RemoteProviderError(`重命名失败 errno=${json.errno}`, 502);
    }
  },
};

async function resolveFsId(ctx: RemoteProviderContext, remotePath: string): Promise<number | null> {
  const token = requireToken(ctx);
  const parent = remotePath.split("/").slice(0, -1).join("/") || "/";
  const name = remotePath.split("/").pop() || "";
  const url = `${PAN_BASE}/rest/2.0/xpan/file?method=list&access_token=${encodeURIComponent(token)}&dir=${encodeURIComponent(parent)}&limit=1000`;
  const json = await panJson(url);
  const hit = (Array.isArray(json.list) ? json.list : []).find((item: any) => String(item.path) === remotePath || String(item.server_filename) === name);
  return hit ? Number(hit.fs_id) : null;
}
