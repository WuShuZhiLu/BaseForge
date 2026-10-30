import { inferBrowserServerBaseUrl, stripServerBasePath } from "./serverUrl";

const FILE_ROUTE_QUERY_KEY = "nowenAppPath";

export const APP_PATH_CHANGED_EVENT = "nowen:app-path-changed";

function normalizeAppPath(rawPath: string): string {
  const value = String(rawPath || "/").trim();
  if (!value || value === "/") return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

function isNativeCapacitorRuntime(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Boolean((window as any).Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

export function buildAppPathUrl(
  appPath: string,
  currentHref: string = window.location.href,
  nativeCapacitor: boolean = isNativeCapacitorRuntime(),
): string {
  const normalizedPath = normalizeAppPath(appPath);
  const currentUrl = new URL(currentHref);

  if (currentUrl.protocol !== "file:" && !nativeCapacitor) {
    const serverBase = inferBrowserServerBaseUrl(currentUrl);
    const prefix = serverBase ? new URL(serverBase).pathname.replace(/\/+$/, "") : "";
    return `${prefix}${normalizedPath}`;
  }

  if (normalizedPath === "/") {
    currentUrl.searchParams.delete(FILE_ROUTE_QUERY_KEY);
  } else {
    currentUrl.searchParams.set(FILE_ROUTE_QUERY_KEY, normalizedPath);
  }
  currentUrl.hash = "";
  return currentUrl.toString();
}

export function navigateToAppPath(appPath: string): void {
  window.location.assign(buildAppPathUrl(appPath));
}

export function resolveCurrentAppPathname(
  currentHref: string = window.location.href,
  nativeCapacitor: boolean = isNativeCapacitorRuntime(),
): string {
  const currentUrl = new URL(currentHref);
  if (currentUrl.protocol !== "file:" && !nativeCapacitor) {
    return stripServerBasePath(currentUrl.pathname, inferBrowserServerBaseUrl(currentUrl));
  }

  const appPath = currentUrl.searchParams.get(FILE_ROUTE_QUERY_KEY);
  if (!appPath) {
    return currentUrl.protocol === "file:" ? "/" : currentUrl.pathname;
  }

  try {
    return new URL(normalizeAppPath(appPath), "https://nowen.local").pathname;
  } catch {
    return "/";
  }
}


export interface AppPathChangedDetail {
  appPath: string;
  replace: boolean;
}

/**
 * SPA 内部导航：不刷新页面，同时兼容 Web、Electron file:// 和 Capacitor。
 * Public route 仍可继续使用 navigateToAppPath() 做完整重载；应用内部模块路由
 * 使用本方法，避免丢失正在运行的本地状态。
 */
function commitAppPathState(appPath: string, replace: boolean): void {
  const normalizedPath = normalizeAppPath(appPath);
  const nextUrl = buildAppPathUrl(normalizedPath);
  const currentPath = resolveCurrentAppPathname();
  // 去重须含 query：?q= 只改查询参数时 pathname 不变，仅比 pathname 会吞掉
  // 「移除/变更 ?q=」的合法 replace（搜索 URL 化依赖此路径）。
  const currentFullPath = `${currentPath}${window.location.search}`;

  if (currentFullPath === normalizedPath) return;

  if (replace) {
    window.history.replaceState(window.history.state, "", nextUrl);
  } else {
    window.history.pushState(window.history.state, "", nextUrl);
  }

  window.dispatchEvent(new CustomEvent<AppPathChangedDetail>(APP_PATH_CHANGED_EVENT, {
    detail: { appPath: normalizedPath, replace },
  }));
}

export function pushAppPathState(appPath: string): void {
  markInAppNavigation();
  commitAppPathState(appPath, false);
}

export function replaceAppPathState(appPath: string): void {
  commitAppPathState(appPath, true);
}

// ===== 应用内导航发生标记（深链规范化判据）=====
//
// 本次页面加载中是否已发生过「应用内前进导航」（push 或 popstate）。replace 不计：
// 登录收敛、URL 规整等 replace 不代表用户已离开入口条目。深链规范化（裸 /notes/:n
// 补 /kb 前缀）只在标记为 false 时执行——树数据晚于路由就绪时，若用户已经导航过，
// 当前 URL 已是用户意图，不得再改写；popstate 回退到的历史条目同样不得改写。
let inAppForwardNavigationObserved = false;

function markInAppNavigation(): void {
  inAppForwardNavigationObserved = true;
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", markInAppNavigation);
}

/** 本次页面加载中是否已发生应用内前进导航（push/popstate）。 */
export function hasInAppForwardNavigationOccurred(): boolean {
  return inAppForwardNavigationObserved;
}
