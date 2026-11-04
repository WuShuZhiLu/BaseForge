/**
 * 插件级外部请求配额（内存实现）。
 *
 * 配额常量集中在此处，后续如需按插件或全局配置，可从 plugin_settings /
 * system_settings 读取后覆盖这里的三项默认值，调用方无需改动。
 * 计数随进程重启清零，不跨实例共享；多实例部署时需换成集中式存储。
 */
export const PLUGIN_EXTERNAL_FETCH_QUOTA = {
  /** 每个插件每分钟最多发起 60 次外部请求。 */
  requestsPerMinute: 60,
  /** 每个插件同一时刻最多 4 个在途外部请求。 */
  maxConcurrent: 4,
  /** 每个插件每小时最多发起 600 次外部请求。 */
  requestsPerHour: 600,
} as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export const PLUGIN_RATE_LIMITED = "PLUGIN_RATE_LIMITED" as const;

interface PluginExternalWindow {
  minute: number[];
  hour: number[];
  concurrent: number;
}

function rateLimited(message: string): Error & { code: typeof PLUGIN_RATE_LIMITED } {
  return Object.assign(new Error(message), { code: PLUGIN_RATE_LIMITED });
}

export class PluginExternalFetchLimiter {
  private readonly windows = new Map<string, PluginExternalWindow>();

  /**
   * 占用一个外部请求配额，返回幂等的释放函数。
   * 超限时抛出 PLUGIN_RATE_LIMITED；调用方必须在 finally 中释放，异常路径同样释放。
   */
  acquire(pluginId: string, now = Date.now()): () => void {
    const window = this.window(pluginId, now);
    if (window.concurrent >= PLUGIN_EXTERNAL_FETCH_QUOTA.maxConcurrent) {
      throw rateLimited("插件外部请求并发数超过限制");
    }
    if (window.minute.length >= PLUGIN_EXTERNAL_FETCH_QUOTA.requestsPerMinute) {
      throw rateLimited("插件外部请求每分钟次数超过限制");
    }
    if (window.hour.length >= PLUGIN_EXTERNAL_FETCH_QUOTA.requestsPerHour) {
      throw rateLimited("插件外部请求每小时次数超过限制");
    }
    window.concurrent += 1;
    window.minute.push(now);
    window.hour.push(now);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      window.concurrent = Math.max(0, window.concurrent - 1);
    };
  }

  /** 仅供测试与运行时重置使用：清空指定插件或全部插件的计数。 */
  reset(pluginId?: string): void {
    if (pluginId === undefined) this.windows.clear();
    else this.windows.delete(pluginId);
  }

  private window(pluginId: string, now: number): PluginExternalWindow {
    const existing = this.windows.get(pluginId);
    const window = existing ?? { minute: [], hour: [], concurrent: 0 };
    const minuteFloor = now - MINUTE_MS;
    const hourFloor = now - HOUR_MS;
    window.minute = window.minute.filter((timestamp) => timestamp > minuteFloor);
    window.hour = window.hour.filter((timestamp) => timestamp > hourFloor);
    if (!existing) this.windows.set(pluginId, window);
    return window;
  }
}

/** 进程级共享配额，保证同一插件的所有调用方共用一份计数。 */
export const pluginExternalFetchLimiter = new PluginExternalFetchLimiter();
