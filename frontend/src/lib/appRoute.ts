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
  ["/plugins", "plugins"],
  ["/issues", "issues"],
];

/** 知识库模块根短形态（写侧会补空间段规整为 /kb/:space）；
 *  / 与 /dashboard（误用已废弃）均为遗留入口，只读不写。 */
export const KB_ROOT_APP_PATH = "/kb";

/** 个人空间的 URL 空间标识（与 getCurrentWorkspace 的字面量一致）。 */
export const PERSONAL_SPACE_ID = "personal";

/**
 * 有空间归属的模块 viewMode：URL 必须带 :space 段（模块 → 空间 → 内容）。
 * 无空间归属模块（files/shares/projects/tasks/plugins）不带——
 * 「没有空间的不需要带，有的才要」（用户拍板）。
 */
export const SPACE_SCOPED_MODULE_VIEW_MODES = new Set<ViewMode>([
  "notebook", "favorites", "trash", "issues",
]);

/** 无空间归属模块的静态路径（保持单段形态）。 */
export const VIEW_MODE_APP_PATHS: Partial<Record<ViewMode, string>> = {
  files: "/files",
  shares: "/shares",
  projects: "/projects",
  tasks: "/tasks",
  plugins: "/plugins",
};

/** 模块路径：带空间域模块按 :space 展开成完整形态；无空间模块走静态表。
 *  space 为 null 时不猜（返回 null，调用方兜底）。 */
export function moduleAppPath(viewMode: ViewMode, space: string | null): string | null {
  if (!SPACE_SCOPED_MODULE_VIEW_MODES.has(viewMode)) return VIEW_MODE_APP_PATHS[viewMode] ?? null;
  if (!space) return null;
  const encoded = encodeURIComponent(space);
  switch (viewMode) {
    case "notebook": return `/kb/${encoded}`;
    case "trash": return `/trash/${encoded}`;
    case "favorites": return `/favorites/${encoded}`;
    case "issues": return `/issues/${encoded}`;
    default: return null;
  }
}

/** 知识库内文档路径：带空间段；聚焦库可选（跨库打开时 kbId 为侧栏进入的库）。 */
export function kbNoteAppPath(space: string, kbId: string | null, noteId: string): string {
  const s = encodeURIComponent(space);
  const n = encodeURIComponent(noteId);
  return kbId
    ? `/kb/${s}/${encodeURIComponent(kbId)}/notes/${n}`
    : `/kb/${s}/notes/${n}`;
}

export type AppRouteKind =
  | { kind: "home"; space?: string | null; url: string }
  | { kind: "note"; noteId: string; space?: string | null; kbId?: string; url: string }
  | { kind: "kb"; space: string; kbId: string; url: string }
  | { kind: "search"; q: string; url: string }
  | { kind: "tag"; tagId: string; url: string }
  | { kind: "tool"; toolKey: ToolRouteKey; url: string }
  | { kind: "login"; url: "/login" }
  | { kind: "settings"; tab: SettingsTabKey | null; url: string }
  | { kind: "sheet"; sheetId: string; url: string }
  | { kind: "mindmap"; mindMapId: string | null; url: string }
  | { kind: "issue"; space: string; issueId: string; url: string }
  | { kind: "module"; viewMode: ViewMode; space?: string | null; url: string };

/** 附加查询参数：?q=（搜索）、?scope=（知识树筛选）与 ?tree=focus（库内树空间）
 *  可叠加在任意路由上。 */
export type AppRoute = AppRouteKind & { q?: string; scope?: string; tree?: string };

/** 工具页签 key（与 store/AppContext 的 ToolTabKey 保持一致；PM projects 不入）。 */
export const TOOL_TAB_KEYS = ["tasks", "shares", "files", "trash"] as const;
export type ToolRouteKey = (typeof TOOL_TAB_KEYS)[number];

/** 设置弹窗 tab key（与 NavRailDesktop 的 TabId 保持一致）。 */
export const SETTINGS_TAB_KEYS = [
  "appearance", "switches", "shortcuts", "ai", "plugins", "voice", "automation",
  "security", "tokens", "data", "backup", "sync", "offlineSync", "folderSync",
  "users", "workspaces", "download", "about",
] as const;
export type SettingsTabKey = (typeof SETTINGS_TAB_KEYS)[number];

export const HOME_ROUTE: AppRoute = { kind: "home", space: null, url: KB_ROOT_APP_PATH };

/** /kb/:space/:kbId（模块 → 空间 → 进入某库，未指定文档）。 */
const KB_ID_PATH_RE = /^\/kb\/([^/]+)\/([^/]+)$/;
/** /kb/:space/notes/:noteId（空间内文档，未聚焦库）。 */
const KB_SPACE_NOTE_PATH_RE = /^\/kb\/([^/]+)\/notes\/([^/]+)$/;
/** /kb/:space/:kbId/notes/:noteId（模块 → 空间 → 库 → 文档，完整层级）。 */
const KB_NOTE_PATH_RE = /^\/kb\/([^/]+)\/([^/]+)\/notes\/([^/]+)$/;
/** 带空间域的模块路径：/trash|favorites|issues/:space。 */
const SPACE_MODULE_PATH_RE = /^\/(favorites|trash|issues)\/([^/]+)$/;
/** 带空间域的 issue 资源：/issues/:space/:issueId。 */
const SPACE_ISSUE_PATH_RE = /^\/issues\/([^/]+)\/([^/]+)$/;

/** 附加查询参数：任意路由都可叠加 ?q=、?scope= 与 ?tree=focus（搜索/筛选/聚焦瞬态）。 */
function attachParams<T extends { url: string }>(route: T, params?: URLSearchParams): T & { q?: string; scope?: string; tree?: string } {
  const q = params?.get("q");
  const scope = params?.get("scope");
  const tree = params?.get("tree");
  let out: T & { q?: string; scope?: string; tree?: string } = route;
  if (q !== null && q !== undefined) out = { ...out, q };
  if (scope !== null && scope !== undefined) out = { ...out, scope };
  if (tree !== null && tree !== undefined) out = { ...out, tree };
  return out;
}

/**
 * 把 pathname 解析为唯一 Route。互斥路径按 kb → issue → search → note →
 * sheet → mindmap → module → home 的优先级命中（各资源路径本就互斥，这里只是把优先级写死）。
 *
 * 空间域（用户拍板）：有空间归属的模块（kb/trash/favorites/issues）URL 必带
 * :space 段——模块 → 空间 → 内容；无空间归属模块（tasks/files/…）不带。
 * 空间标识为 personal 字面量或 workspace uuid，不加外名层（slug 体系已否决）。
 * 短形态 /kb、/trash、/favorites、/issues 与 /、/dashboard 均为遗留/省略入口，
 * 读侧同等解析（space=null），写侧 reconcile 补空间段规整。
 *
 * 知识库层级：kbId 是根层知识库的 notebook id（树根节点 resourceId）——URL 表达
 * 「哪个库」（实体）；侧栏聚焦态经 resourceId→节点 id 反查回灌。kb 段表达侧栏
 * 上下文，与打开文档的归属解耦——跨库打开笔记时 URL 为 /kb/:space/:entered/notes/:other。
 *
 * 第二参数传 location 的 searchParams：?q= 附加在任意路由上（搜索瞬态，
 * 不改变主区语义）；/search 是 AI/外部工具的显式搜索入口路由。
 */
export function parseAppRoute(pathname: string, params?: URLSearchParams): AppRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";

  // 知识库根短/遗留形态：space 未知（null），写侧补当前空间规整。
  if (normalized === "/" || normalized === "/dashboard" || normalized === KB_ROOT_APP_PATH) {
    return attachParams(HOME_ROUTE, params);
  }

  if (normalized === "/search") {
    const q = params?.get("q") ?? "";
    return { kind: "search", q, url: q ? `/search?q=${encodeURIComponent(q)}` : "/search" };
  }

  const kbNote = normalized.match(KB_NOTE_PATH_RE);
  if (kbNote) {
    const [, space, kbId, noteId] = kbNote;
    return attachParams({
      kind: "note",
      noteId: decodeURIComponent(noteId),
      space: decodeURIComponent(space),
      kbId: decodeURIComponent(kbId),
      url: `/kb/${encodeURIComponent(space)}/${encodeURIComponent(kbId)}/notes/${encodeURIComponent(noteId)}`,
    }, params);
  }
  const kbSpaceNote = normalized.match(KB_SPACE_NOTE_PATH_RE);
  if (kbSpaceNote) {
    const [, space, noteId] = kbSpaceNote;
    return attachParams({
      kind: "note",
      noteId: decodeURIComponent(noteId),
      space: decodeURIComponent(space),
      url: `/kb/${encodeURIComponent(space)}/notes/${encodeURIComponent(noteId)}`,
    }, params);
  }
  const kbId = normalized.match(KB_ID_PATH_RE);
  if (kbId) {
    return attachParams({
      kind: "kb",
      space: decodeURIComponent(kbId[1]),
      kbId: decodeURIComponent(kbId[2]),
      url: `/kb/${encodeURIComponent(kbId[1])}/${encodeURIComponent(kbId[2])}`,
    }, params);
  }
  // /kb/:x 二段旧形态（昨日树节点 id 深链）退化为 home，space 取该段——
  // 反查/兜底会把它规整到当前空间的完整形态。
  const kbLegacy = normalized.match(/^\/kb\/([^/]+)$/);
  if (kbLegacy) {
    return attachParams({ kind: "home", space: decodeURIComponent(kbLegacy[1]), url: `/kb/${encodeURIComponent(kbLegacy[1])}` }, params);
  }

  if (normalized === "/login") {
    return { kind: "login", url: "/login" };
  }
  if (normalized === "/settings" || normalized.startsWith("/settings/")) {
    const tab = normalized.slice("/settings/".length) || null;
    const valid = tab && (SETTINGS_TAB_KEYS as readonly string[]).includes(tab) ? (tab as SettingsTabKey) : null;
    return { kind: "settings", tab: valid, url: valid ? `/settings/${tab}` : "/settings" };
  }

  const tagId = normalized.match(/^\/tags\/([^/]+)$/)?.[1];
  if (tagId) {
    return attachParams({ kind: "tag", tagId: decodeURIComponent(tagId), url: `/tags/${encodeURIComponent(tagId)}` }, params);
  }

  const toolKey = normalized.match(/^\/tools\/([^/]+)$/)?.[1];
  if (toolKey) {
    const decoded = decodeURIComponent(toolKey);
    if ((TOOL_TAB_KEYS as readonly string[]).includes(decoded)) {
      return attachParams({ kind: "tool", toolKey: decoded as ToolRouteKey, url: `/tools/${encodeURIComponent(toolKey)}` }, params);
    }
  }

  // 带空间域的 issue 资源（三段）优先于模块匹配。
  const spaceIssue = normalized.match(SPACE_ISSUE_PATH_RE);
  if (spaceIssue) {
    return attachParams({
      kind: "issue",
      space: decodeURIComponent(spaceIssue[1]),
      issueId: decodeURIComponent(spaceIssue[2]),
      url: `/issues/${encodeURIComponent(spaceIssue[1])}/${encodeURIComponent(spaceIssue[2])}`,
    }, params);
  }

  // 带空间域的模块路径（/favorites|trash|issues/:space）。
  const spaceModule = normalized.match(SPACE_MODULE_PATH_RE);
  if (spaceModule) {
    const viewMode = spaceModule[1] as ViewMode;
    return attachParams({
      kind: "module",
      viewMode,
      space: decodeURIComponent(spaceModule[2]),
      url: `/${spaceModule[1]}/${encodeURIComponent(spaceModule[2])}`,
    }, params);
  }

  const note = parseNoteAppPath(normalized);
  if (note.matched && note.noteId) {
    return attachParams({ kind: "note", noteId: note.noteId, space: null, url: `/notes/${encodeURIComponent(note.noteId)}` }, params);
  }

  const sheet = parseSheetAppPath(normalized);
  if (sheet.matched && sheet.sheetId) {
    return attachParams({ kind: "sheet", sheetId: sheet.sheetId, url: `/sheets/${encodeURIComponent(sheet.sheetId)}` }, params);
  }

  const mindMap = parseMindMapAppPath(normalized);
  if (mindMap.matched) {
    return attachParams({ kind: "mindmap", mindMapId: mindMap.mindMapId, url: normalized === "/mindmaps" ? "/mindmaps" : `/mindmaps/${encodeURIComponent(mindMap.mindMapId ?? "")}` }, params);
  }

  const issue = parseIssueAppPath(normalized);
  if (issue.matched) {
    return attachParams({ kind: "issue", space: "", issueId: issue.issueId ?? "", url: issue.issueId ? `/issues/${encodeURIComponent(issue.issueId)}` : "/issues" }, params);
  }

  const moduleView = MODULE_APP_PATHS.find(([path]) => path === normalized)?.[1];
  if (moduleView) {
    return attachParams({ kind: "module", viewMode: moduleView, space: null, url: normalized }, params);
  }

  return HOME_ROUTE;
}

/** 当前地址对应的 Route（mount 初始化与读侧共用）。 */
export function getCurrentAppRoute(): AppRoute {
  const params = typeof window !== "undefined" ? new URL(window.location.href).searchParams : undefined;
  return parseAppRoute(resolveCurrentAppPathname(), params);
}
