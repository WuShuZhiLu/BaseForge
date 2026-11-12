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

/**
 * 解析「源内路径」→ 共享名 + 共享内子路径。
 * - 多共享模式（ctx.shares 有值）：路径第一段必须是共享名，根目录 "" 代表虚拟根；
 * - 单共享模式（历史数据）：共享名取 baseUrl，整条路径都是共享内子路径。
 */
function resolveTarget(ctx: RemoteProviderContext, relPath: string): { shareName: string; subPath: string; isVirtualRoot: boolean } {
  const path = normalizeRemotePath(relPath);
  const shares = (ctx.shares || []).filter(Boolean);
  if (shares.length > 0) {
    if (!path) return { shareName: "", subPath: "", isVirtualRoot: true };
    const [shareName, ...rest] = path.split("/");
    if (!shares.includes(shareName)) {
      throw new RemoteProviderError(`共享「${shareName}」不在该来源的共享列表中`, 404);
    }
    return { shareName, subPath: rest.join("/"), isVirtualRoot: false };
  }
  return { shareName: parseSmbTarget(ctx.baseUrl).shareName, subPath: path, isVirtualRoot: false };
}

/** 枚举主机上的磁盘共享（过滤 IPC$ / 管理共享 / 打印机），供源配置向导使用。 */
export async function listSmbShares(options: {
  host: string;
  port?: number;
  domain?: string;
  username?: string;
  password?: string;
}): Promise<Array<{ name: string; comment: string }>> {
  const { Client } = await loadSmb3();
  const client = new Client({
    host: options.host,
    port: options.port ?? 445,
    // 空串兜底：历史版本把 undefined 传给 NTLM 会在 socket 回调里抛未捕获异常，导致整个后端进程退出
    domain: options.domain || "",
    username: options.username || "",
    password: options.password || "",
    connectTimeout: 6000,
    requestTimeout: 10000,
    signing: "if-offered",
    encryption: "if-offered",
  });
  try {
    await client.connect();
    const all = await client.listShares();
    return all
      .filter((share) => share.type === "disk" && !share.name.endsWith("$"))
      .map((share) => ({ name: share.name, comment: share.comment || "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    try { await client.close(); } catch { /* 连接未建立时忽略 */ }
  }
}

/** 解析主机与端口：多共享模式读 ctx.host，历史数据回落到 baseUrl 的 UNC。 */
function resolveHost(ctx: RemoteProviderContext): { host: string; port: number } {
  const raw = String(ctx.host || "").trim();
  if (raw) {
    const match = raw.replace(/^smb:\/\//i, "").match(/^([^:/\\]+)(?::(\d+))?$/);
    if (match) return { host: match[1], port: match[2] ? Number(match[2]) : 445 };
  }
  const parsed = parseSmbTarget(ctx.baseUrl);
  return { host: parsed.host, port: parsed.port };
}

async function openClient(ctx: RemoteProviderContext): Promise<SmbClientLike> {
  const { host, port } = resolveHost(ctx);
  try {
    return await createClient({
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
}

async function closeQuietly(client: SmbClientLike): Promise<void> {
  // close 也可能在对端无响应时挂住：3s 兜底
  try {
    await Promise.race([
      client.close(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch { /* ignore */ }
}

/**
 * SMB 连接复用缓存：每次请求都重新 connect + NTLM 握手，慢 NAS 上要 10s+，
 * 是目录加载慢、前端 30s 超时失败的根源。按连接参数缓存客户端，
 * 空闲 2 分钟后关闭；同一客户端上的操作串行执行，避免协议层并发问题。
 */
interface CachedSmbClient {
  client: SmbClientLike;
  queue: Promise<unknown>;
  idleTimer: ReturnType<typeof setTimeout>;
}
const SMB_CLIENT_IDLE_MS = 120_000;
const SMB_OP_TIMEOUT_MS = 45_000;
const smbClientCache = new Map<string, CachedSmbClient>();

function smbCacheKey(ctx: RemoteProviderContext): string {
  const { host, port } = resolveHost(ctx);
  return JSON.stringify([host, port, ctx.domain || "", ctx.username || "", ctx.password || ""]);
}

function touchIdleTimer(key: string, entry: CachedSmbClient): void {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    smbClientCache.delete(key);
    void closeQuietly(entry.client);
  }, SMB_CLIENT_IDLE_MS);
  // 定时器不阻止进程退出
  entry.idleTimer.unref?.();
}

/** 连接类错误（缓存客户端可能已被 NAS 断开）：丢弃缓存，下次重连 */
function isConnectionError(err: unknown): boolean {
  const text = [err instanceof Error ? err.message : String(err ?? ""), (err as { code?: string })?.code || ""].join(" ");
  return /连接 SMB 主机失败|ECONN|EPIPE|ETIMEDOUT|NOT_CONNECTED|CONNECTION|socket|timeout/i.test(text);
}

/** NAS 上共享已被删除/改名（TREE_CONNECT BAD_NETWORK_NAME、共享根不存在），
 *  与主机离线、权限不足区分开——前者可以放心从虚拟根里剔除。 */
function isShareMissingError(err: unknown): boolean {
  const detail = err as { code?: string; statusName?: string; message?: string } | null;
  const text = [
    err instanceof Error ? err.message : String(err ?? ""),
    detail?.code, detail?.statusName, detail?.message,
  ].filter(Boolean).join(" | ");
  return /BAD_NETWORK_NAME|OBJECT_NAME_NOT_FOUND|OBJECT_PATH_NOT_FOUND|ENOENT|NO_SUCH_FILE/i.test(text);
}

async function withSmbClient<T>(ctx: RemoteProviderContext, fn: (client: SmbClientLike) => Promise<T>): Promise<T> {
  const key = smbCacheKey(ctx);
  let entry = smbClientCache.get(key);
  if (!entry) {
    const client = await openClient(ctx);
    entry = { client, queue: Promise.resolve(), idleTimer: null as unknown as ReturnType<typeof setTimeout> };
    smbClientCache.set(key, entry);
    touchIdleTimer(key, entry);
  } else {
    touchIdleTimer(key, entry);
  }
  const run = async (): Promise<T> => {
    const startedAt = Date.now();
    // 超时定时器必须随操作结束清掉：否则每次操作都留一个 45s 的引用（进程/测试退出被拖住）
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 单操作硬超时：smb3 的 requestTimeout 并不覆盖所有阶段（如 NTLM 会话建立），
      // 一旦挂住会堵死该源上的所有后续操作。超时即弃连接，队列自动恢复。
      const result = await Promise.race([
        fn(entry.client),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RemoteProviderError("SMB 操作超时（对端无响应），已重置连接", 504)), SMB_OP_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      console.log(`[smb] op ok host=${(JSON.parse(key) as string[])[0]} ${Date.now() - startedAt}ms`);
      return result;
    } catch (err) {
      console.log(`[smb] op fail host=${(JSON.parse(key) as string[])[0]} ${Date.now() - startedAt}ms err=${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof RemoteProviderError && err.status === 504) {
        smbClientCache.delete(key);
        void closeQuietly(entry.client);
        throw err;
      }
      // 复用的连接可能已失效：丢弃缓存并原样抛错（下次操作自动重连）
      if (entry !== smbClientCache.get(key)) throw err;
      if (isConnectionError(err)) {
        smbClientCache.delete(key);
        void closeQuietly(entry.client);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const result = entry.queue.then(run, run);
  entry.queue = result.catch(() => { /* 队列吞掉错误，保持后续操作可执行 */ });
  return result;
}

/** NT_STATUS / fs code → 业务错误映射 */
function mapSmbError(err: unknown, fallbackMsg: string): RemoteProviderError {
  // 已经是业务错误（openClient / 操作超时抛的）就原样上抛：二次映射会把 403 洗成 502
  if (err instanceof RemoteProviderError) return err;
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

  async list(ctx, path, opts) {
    const dirPath = normalizeRemotePath(path);
    const target = resolveTarget(ctx, dirPath);
    // 多共享的虚拟根：把配置的共享并列成文件夹，顺序按配置顺序
    if (target.isVirtualRoot) {
      const shares = (ctx.shares || []).filter(Boolean);
      const asEntries = (names: string[]): RemoteFileEntry[] => names.map((name) => ({
        name,
        path: name,
        isFolder: true,
        size: 0,
        modifiedAt: null,
      }));
      // 常规浏览不连服务器（虚拟根没有网络语义）；只有显式刷新（revalidate）才逐个探测，
      // 把 NAS 上已删除/改名的共享剔掉——否则配置里残留的共享会一直显示。
      if (!opts?.revalidate) return asEntries(shares);
      try {
        return await withSmbClient(ctx, async (client) => {
          const visible: string[] = [];
          for (const name of shares) {
            try {
              const st = await client.stat(name);
              if (st.isDirectory) visible.push(name);
            } catch (err) {
              // 主机级异常（断连/超时）交给外层回退整份配置列表，避免把临时离线误判成删除
              if (isConnectionError(err)) throw err;
              // 「共享不存在」类错误（TREE_CONNECT BAD_NETWORK_NAME 等）→ 刷新后不再显示
              if (isShareMissingError(err)) continue;
              // 权限不足等其它错误：共享仍在，保留显示
              visible.push(name);
            }
          }
          return asEntries(visible);
        });
      } catch {
        return asEntries(shares);
      }
    }
    // 多共享模式路径带共享名前缀；历史单共享模式保持「共享内相对路径」不变（已存链接不失效）
    const multi = (ctx.shares || []).filter(Boolean).length > 0;
    const withShare = (relative: string) => (multi ? `${target.shareName}/${relative}` : relative);

    // 快速模式：只 readdir 拿名称/类型，跳过逐条 stat——SMB 的大目录里 stat 是绝对大头
    // （实测 200 条约 350ms，readdir 仅 20ms），前端先用它把列表画出来再补详情。
    if (opts?.fast) {
      try {
        return await withSmbClient(ctx, async (client) => {
          const dir = targetPath(target.shareName, ctx, target.subPath);
          const items = await readdirEntries(client, dir);
          const entries: RemoteFileEntry[] = items.slice(0, 200).map((item) => {
            const relative = target.subPath ? `${target.subPath}/${item.name}` : item.name;
            return {
              name: item.name,
              path: withShare(relative),
              isFolder: item.isDirectory(),
              size: 0,
              modifiedAt: null,
              metaPending: true,
            };
          });
          sortEntries(entries);
          return entries;
        });
      } catch (err) {
        throw mapSmbError(err, "读取 SMB 目录失败");
      }
    }

    try {
      return await withSmbClient(ctx, async (client) => {
        const dir = targetPath(target.shareName, ctx, target.subPath);
        const startedAt = Date.now();
        const items = await readdirEntries(client, dir);
        const readdirMs = Date.now() - startedAt;
        // 逐条 stat 获取类型/大小/时间（目录条目上限 200）。
        // 注意必须串行：不少 NAS / Windows 主机对单连接并发请求直接 RST
        // （实测并发 3 即 ECONNRESET），串行虽慢但单个 stat 仅几 ms，200 条 <2s。
        const entries: RemoteFileEntry[] = [];
        for (const item of items.slice(0, 200)) {
          const relative = target.subPath ? `${target.subPath}/${item.name}` : item.name;
          try {
            const st = await client.stat(`${dir}/${item.name}`);
            entries.push({
              name: item.name,
              path: withShare(relative),
              isFolder: st.isDirectory,
              size: st.size || 0,
              modifiedAt: st.mtime ? new Date(st.mtime).toISOString() : null,
            });
          } catch {
            entries.push({ name: item.name, path: withShare(relative), isFolder: item.isDirectory(), size: 0, modifiedAt: null });
          }
        }
        sortEntries(entries);
        // 只在 stat 明显拖慢时打点：readdir 与逐条 stat 的耗时拆分，便于定位后续性能问题
        const statsMs = Date.now() - startedAt - readdirMs;
        if (entries.length > 0 && statsMs >= 50) {
          console.log(
            `[smb] list share=${target.shareName} dir="${target.subPath}" entries=${entries.length} ` +
            `readdir=${readdirMs}ms stats=${statsMs}ms`,
          );
        }
        return entries;
      });
    } catch (err) {
      throw mapSmbError(err, "读取 SMB 目录失败");
    }
  },

  async read(ctx, path) {
    const buffer = await smbProvider.readBinary(ctx, path);
    return { content: buffer.toString("utf8"), size: buffer.length };
  },

  async readBinary(ctx, path) {
    const target = resolveTarget(ctx, path);
    try {
      return await withSmbClient(ctx, (client) => client.readFile(targetPath(target.shareName, ctx, target.subPath)));
    } catch (err) {
      throw mapSmbError(err, "读取 SMB 文件失败");
    }
  },

  async write(ctx, path, content) {
    await smbProvider.writeBinary(ctx, path, Buffer.from(content, "utf8"));
  },

  async writeBinary(ctx, path, data) {
    const target = resolveTarget(ctx, path);
    try {
      await withSmbClient(ctx, (client) => client.writeFile(targetPath(target.shareName, ctx, target.subPath), data));
    } catch (err) {
      throw mapSmbError(err, "写入 SMB 文件失败");
    }
  },

  async mkdir(ctx, path) {
    const target = resolveTarget(ctx, path);
    try {
      await withSmbClient(ctx, (client) => client.mkdir(targetPath(target.shareName, ctx, target.subPath)));
    } catch (err) {
      throw mapSmbError(err, "创建 SMB 目录失败");
    }
  },

  async remove(ctx, path) {
    const target = resolveTarget(ctx, path);
    try {
      await withSmbClient(ctx, async (client) => {
        const full = targetPath(target.shareName, ctx, target.subPath);
        const st = await client.stat(full);
        if (st.isDirectory) await removeTree(client, full);
        else await client.rm(full);
      });
    } catch (err) {
      throw mapSmbError(err, "删除 SMB 文件失败");
    }
  },

  async rename(ctx, path, newName) {
    const target = resolveTarget(ctx, path);
    try {
      await withSmbClient(ctx, async (client) => {
        const from = targetPath(target.shareName, ctx, target.subPath);
        const subParent = target.subPath.split("/").slice(0, -1).join("/");
        const to = `${targetPath(target.shareName, ctx, subParent)}/${newName}`;
        await client.rename(from, to);
      });
    } catch (err) {
      throw mapSmbError(err, "SMB 重命名失败");
    }
  },
};
