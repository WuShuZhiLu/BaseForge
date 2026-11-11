/**
 * 插件面板上的计数（市场条目数、可用更新数）。
 *
 * 侧栏需要显示数字，但这两个数据只有调接口才知道，且变化不频繁。这里做一层
 * 轻量缓存：首次请求后缓存 5 分钟，期间复用；刷新完成后广播事件让侧栏重渲染。
 * 失败不抛错（侧栏只是少个数字，不应影响使用）。
 */
import { pluginApi } from "@/lib/pluginApi";

export interface PluginCounts {
  /** 市场目录条目数；null 表示未取到 */
  catalog: number | null;
  /** 可用更新数；null 表示未取到 */
  updates: number | null;
}

const TTL_MS = 5 * 60 * 1000;
const EVENT = "baseforge:plugin-counts";

let cached: PluginCounts | null = null;
let cachedAt = 0;
let inflight: Promise<PluginCounts> | null = null;

export const PLUGIN_COUNTS_EVENT = EVENT;

export function peekPluginCounts(): PluginCounts | null {
  if (!cached || Date.now() - cachedAt > TTL_MS) return null;
  return cached;
}

export async function loadPluginCounts(force = false): Promise<PluginCounts> {
  if (!force) {
    const fresh = peekPluginCounts();
    if (fresh) return fresh;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const [catalogResult, updatesResult] = await Promise.allSettled([
      pluginApi.registryCatalog(),
      pluginApi.checkUpdates(),
    ]);
    const next: PluginCounts = {
      catalog: catalogResult.status === "fulfilled" ? catalogResult.value.length : null,
      updates: updatesResult.status === "fulfilled" ? updatesResult.value.length : null,
    };
    cached = next;
    cachedAt = Date.now();
    try {
      window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
    } catch {
      // 非浏览器环境忽略
    }
    return next;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}
