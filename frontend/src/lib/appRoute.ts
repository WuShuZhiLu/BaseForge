import { resolveCurrentAppPathname } from "./appPathNavigation";
import { parseNoteAppPath } from "./noteDeepLink";
import { parseSheetAppPath } from "./sheetDeepLink";
import { parseMindMapAppPath } from "./mindMapDeepLink";
import { parseIssueAppPath } from "./workspaceIssueNavigation";
import type { ViewMode } from "@/types";

/**
 * 统一路由模型（方案：单一 RouteOwner，见 .cmp/PLAN-ROUTE-OWNER.md）。
 *
 * 此前「状态 ⇄ URL」由三套写侧 effect + 两个读侧监听者互相设防，URL 的
 * 「意图」与「回声」无区分——关光页签后残留的 /notes/:id 会被当深链重新
 * 加载（复活 bug），只能靠 1.5s 墓碑时间窗猜。本模块把所有路径形态归一为
 * 一个 union Route，供唯一读侧（AppRouteSync）解析与唯一写侧 reconcile。
 */

/** 笔记工作区视图：URL 语义是 /notes/:id 或 "/"（由 activeNote 决定）。 */
export const NOTE_WORKSPACE_VIEWS = new Set<ViewMode>([
  "notebook",
  "favorites",
  "trash",
  "all",
  "search",
  "tag",
]);

/** 模块路径 ↔ viewMode（Rail 徽章切模块时 URL 跟随，刷新/前进/后退可恢复）。 */
export const MODULE_APP_PATHS: ReadonlyArray<readonly [string, ViewMode]> = [
  ["/favorites", "favorites"],
  ["/trash", "trash"],
  ["/files", "files"],
  ["/shares", "shares"],
  ["/projects", "projects"],
  ["/tasks", "tasks"],
  ["/diary", "diary"],
  ["/ai", "ai-chat"],
  ["/plugins", "plugins"],
  ["/issues", "issues"],
];

export const VIEW_MODE_APP_PATHS: Partial<Record<ViewMode, string>> = {
  notebook: "/",
  favorites: "/favorites",
  trash: "/trash",
  files: "/files",
  shares: "/shares",
  projects: "/projects",
  tasks: "/tasks",
  diary: "/diary",
  "ai-chat": "/ai",
  plugins: "/plugins",
  issues: "/issues",
};

export type AppRoute =
  | { kind: "home"; url: "/" }
  | { kind: "note"; noteId: string; url: string }
  | { kind: "sheet"; sheetId: string; url: string }
  | { kind: "mindmap"; mindMapId: string | null; url: string }
  | { kind: "issue"; issueId: string | null; url: string }
  | { kind: "module"; viewMode: ViewMode; url: string };

export const HOME_ROUTE: AppRoute = { kind: "home", url: "/" };

/**
 * 把 pathname 解析为唯一 Route。互斥路径按 note → sheet → mindmap → issue
 * → module → home 的优先级命中（各资源路径本就互斥，这里只是把优先级写死）。
 */
export function parseAppRoute(pathname: string): AppRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";

  const note = parseNoteAppPath(normalized);
  if (note.matched && note.noteId) {
    return { kind: "note", noteId: note.noteId, url: `/notes/${encodeURIComponent(note.noteId)}` };
  }

  const sheet = parseSheetAppPath(normalized);
  if (sheet.matched && sheet.sheetId) {
    return { kind: "sheet", sheetId: sheet.sheetId, url: `/sheets/${encodeURIComponent(sheet.sheetId)}` };
  }

  const mindMap = parseMindMapAppPath(normalized);
  if (mindMap.matched) {
    return { kind: "mindmap", mindMapId: mindMap.mindMapId, url: normalized === "/mindmaps" ? "/mindmaps" : `/mindmaps/${encodeURIComponent(mindMap.mindMapId ?? "")}` };
  }

  const issue = parseIssueAppPath(normalized);
  if (issue.matched) {
    return { kind: "issue", issueId: issue.issueId, url: issue.issueId ? `/issues/${encodeURIComponent(issue.issueId)}` : "/issues" };
  }

  const moduleView = MODULE_APP_PATHS.find(([path]) => path === normalized)?.[1];
  if (moduleView) {
    return { kind: "module", viewMode: moduleView, url: normalized };
  }

  return HOME_ROUTE;
}

/** 当前地址对应的 Route（mount 初始化与读侧共用）。 */
export function getCurrentAppRoute(): AppRoute {
  return parseAppRoute(resolveCurrentAppPathname());
}
