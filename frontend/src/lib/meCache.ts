/**
 * 当前登录用户的模块级缓存。
 *
 * 背景：设置弹窗（AppearancePanel 的站点标识卡、DataManager、BackupCenter 等）
 * 各自调用 api.getMe() 判断 isAdmin。异步返回前组件先按"非管理员"渲染，
 * 结果到达后翻转为管理员视图——用户看到的是打开后内容"瞬间变一下"。
 *
 * 这里提供进程级缓存：
 *  - fetchMe()：有缓存直接同步返回（包成 Promise），否则发请求并缓存；
 *    并发调用共享同一个 in-flight 请求。
 *  - getCachedMe()：同步读缓存（可能为 null），用于 useState 惰性初始化，
 *    让首次渲染就拿到正确身份。
 *  - 缓存失效：监听 authSession 的 "baseforge:token-changed"（登录/登出/换号都会
 *    派发），失效后下一次 fetchMe 重新拉取，避免切换账号后残留旧身份。
 */
import { api } from "@/lib/api";

export interface MeInfo {
  id: string;
  role?: string;
  displayName?: string;
  username?: string;
  email?: string;
}

let cached: MeInfo | null = null;
let inflight: Promise<MeInfo> | null = null;

export function getCachedMe(): MeInfo | null {
  return cached;
}

export function fetchMe(): Promise<MeInfo> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = api
      .getMe()
      .then((u) => {
        cached = u as MeInfo;
        inflight = null;
        return cached;
      })
      .catch((err) => {
        inflight = null;
        throw err;
      });
  }
  return inflight;
}

export function invalidateMe(): void {
  cached = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("baseforge:token-changed", () => {
    cached = null;
  });
}
