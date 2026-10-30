import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useApp, useAppActions } from "@/store/AppContext";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { useNoteLoader } from "@/hooks/useNoteLoader";
import { api, getCurrentWorkspace, setCurrentWorkspace } from "@/lib/api";
import {
  APP_PATH_CHANGED_EVENT,
  pushAppPathState,
  replaceAppPathState,
  resolveCurrentAppPathname,
  type AppPathChangedDetail,
} from "@/lib/appPathNavigation";
import {
  kbNoteAppPath,
  KB_ROOT_APP_PATH,
  moduleAppPath,
  NOTE_WORKSPACE_VIEWS,
  parseAppRoute,
  type AppRoute,
} from "@/lib/appRoute";
import { toast } from "@/lib/toast";
import type { Note, ViewMode } from "@/types";

function tabFromNote(note: Note) {
  return {
    id: note.id,
    title: note.title,
    notebookId: note.notebookId,
    workspaceId: note.workspaceId,
    contentFormat: note.contentFormat,
    isLocked: note.isLocked,
    isTrashed: note.isTrashed,
    updatedAt: note.updatedAt,
  };
}

const RESOURCE_ROUTE_KINDS = new Set<AppRoute["kind"]>(["sheet", "mindmap", "issue"]);

/**
 * 统一路由所有者（单一 RouteOwner，见 .cmp/PLAN-ROUTE-OWNER.md）。
 *
 * 读侧（URL → 状态）：唯一监听 popstate / APP_PATH_CHANGED_EVENT，把 pathname
 *   解析为 AppRoute 后单点分发；「自回声抑制」——事件 URL 与自己刚写入的期望
 *   URL 相同时只镜像 route，不回灌状态。
 * 写侧（状态 → URL）：唯一 reconcile effect，按固定优先级把状态派生的期望 URL
 *   写回地址栏（first-writer-wins，一轮至多写一次）。
 *
 * 由此取代了旧 NoteDeepLinkBridge（含 1.5s 墓碑）与 App.tsx 的 4 个互防 effect：
 * 关光页签后 URL 清理与状态同流，残留的 /notes/:id 不再被当作深链意图复活——
 * 墓碑与时间窗整体删除。
 */
export default function AppRouteSync() {
  const { state } = useApp();
  const actions = useAppActions();
  const { prefs } = useUserPreferences();
  const { loadNote, cancelNoteLoad } = useNoteLoader();
  const { t } = useTranslation();

  const activeNoteRef = useRef(state.activeNote);
  const viewModeRef = useRef(state.viewMode);
  const previousActiveNoteIdRef = useRef<string | null>(state.activeNote?.id ?? null);
  const previousViewModeRef = useRef<ViewMode>(state.viewMode);
  const previousRouteKindRef = useRef<AppRoute["kind"]>(state.route.kind);
  const previousActiveToolTabRef = useRef<string | null>(state.activeToolTab);
  const pendingRouteNoteIdRef = useRef<string | null>(null);
  const routeLoadSequenceRef = useRef(0);
  // 自回声抑制：Owner 自己刚写入的期望 URL。他人命令式 push（pushSheetAppPath
  // 等）与 popstate 不等于该值，正常走意图分发。
  const expectedUrlRef = useRef<string>(resolveCurrentAppPathname());
  // 知识库上下文（聚焦库 / 打开文档）的最近位置：切到其它功能再切回来时恢复用。
  const lastNotebookPathRef = useRef<string | null>(null);
  const lastNotebookPathKey = () => `nowen:last-kb-path:${getCurrentWorkspace()}`;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(lastNotebookPathKey());
      if (saved && saved.startsWith("/kb/")) lastNotebookPathRef.current = saved;
    } catch { /* ignore */ }
    // 只在挂载时读一次（后续由路由变化写入）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  activeNoteRef.current = state.activeNote;
  viewModeRef.current = state.viewMode;

  // ============ 读侧：URL → 状态（唯一监听者） ============
  useEffect(() => {
    let disposed = false;

    const dispatchRoute = (route: AppRoute, event?: Event) => {
      if (route.kind === "note") {
        const noteId = route.noteId;
        if (activeNoteRef.current?.id === noteId) {
          pendingRouteNoteIdRef.current = null;
          actions.setMobileView("editor");
          return;
        }

        pendingRouteNoteIdRef.current = noteId;
        const sequence = ++routeLoadSequenceRef.current;
        actions.setMobileView("editor");

        void loadNote({
          noteId,
          summary: { title: "…", notebookId: "" },
          request: () => api.getNote(noteId),
          onSuccess: (note) => {
            if (disposed || sequence !== routeLoadSequenceRef.current) return;
            const landed = parseAppRoute(resolveCurrentAppPathname());
            if (!(landed.kind === "note" && landed.noteId === noteId)) return;

            activeNoteRef.current = note;
            actions.setActiveNote(note);
            actions.setSelectedNotebook(note.notebookId);
            actions.setViewMode("notebook");
            actions.setMobileView("editor");
            // 打开笔记 = 离开工具页（主区让位给编辑器），否则工具页会盖住新笔记
            actions.setActiveToolTab(null);
            if (prefs.enableNoteTabs) actions.openNoteTab(tabFromNote(note));
          },
          onError: (error) => {
            if (disposed || sequence !== routeLoadSequenceRef.current) return;
            const landed = parseAppRoute(resolveCurrentAppPathname());
            if (!(landed.kind === "note" && landed.noteId === noteId)) return;

            console.error("[app-route] failed to open routed note", { noteId, error });
            cancelNoteLoad();
            pendingRouteNoteIdRef.current = null;
            activeNoteRef.current = null;
            actions.setActiveNote(null);
            actions.setMobileView("list");
            // 不再 toast + 跳回库根：保留 URL 与上下文，由主区渲染「打不开」状态页，
            // 让用户看清状态并自己决定返回还是重试（分享链接场景刷新也不会丢位置）。
            const status = (error as { status?: number })?.status;
            actions.setNoteLoadError?.({
              noteId,
              status,
              message: error instanceof Error ? error.message : undefined,
            });
          },
        });
        return;
      }

      if (route.kind === "sheet") {
        // sheet 占满主区（原 App.tsx applyRoute 语义）
        actions.setViewMode("all");
        actions.setActiveNote(null);
        actions.setMobileView("editor");
        return;
      }
      if (route.kind === "mindmap") {
        actions.setViewMode("mindmaps");
        return;
      }
      if (route.kind === "issue") {
        actions.setViewMode("issues");
        return;
      }
      if (route.kind === "kb") {
        // 库 Overview（/kb/:space/:kbId）：主区渲染 KbDetailPage（视图层按 route
        // 直接渲染）。仅确保处于知识库工作区（刷新直达/外链恢复时 viewMode 未就位）。
        if (!NOTE_WORKSPACE_VIEWS.has(viewModeRef.current)) actions.setViewMode("notebook");
        return;
      }
      if (route.kind === "search") {
        // 搜索态：主区不动，query 由搜索框消费者从 state.route 回灌。
        // 同样不可掉入 home 分支（popstate 退出搜索时不能清编辑器）。
        return;
      }
      if (route.kind === "tag") {
        // 标签展开态：主区不动，标签面板从 state.route 回灌展开。
        return;
      }
      if (route.kind === "login") {
        // /login（已登录时访问）：由 App 层的 login 回跳 effect 处理（push /）。
        return;
      }
      if (route.kind === "settings") {
        // 设置弹窗：主区不动，NavRailDesktop 从 state.route 派生开关与 tab。
        return;
      }
      if (route.kind === "tool") {
        // 工具页签：打开并激活对应页签（主区为工具页）。
        actions.openToolTab(route.toolKey);
        return;
      }
      if (route.kind === "module") {
        actions.setViewMode(route.viewMode);
        return;
      }
      // home：popstate = 用户显式后退 → 清编辑器回列表；其余（回声/他人清理）
      // 不动状态，由写侧 reconcile 决定是否把资源 URL 补回来（原 restore guard 职责）。
      if (route.kind === "home" && event?.type === "popstate") {
        cancelNoteLoad();
        activeNoteRef.current = null;
        actions.setActiveNote(null);
        actions.setMobileView("list");
        actions.setViewMode("all");
      }
    };

    const applyRoute = (event?: Event) => {
      const pathname = resolveCurrentAppPathname();
      // ?q= 等查询参数与 pathname 一起构成完整路由（搜索瞬态可叠加在任意路径上）
      const searchParams = new URL(window.location.href).searchParams;
      const route = parseAppRoute(pathname, searchParams);
      // 空间真相归 URL：带空间域的路由把空间上下文切换到位——跨空间深链的
      // 核心机制（/kb/:workspaceA/... 打开即落到 A 空间）。旧版树节点 id 深链
      // （notebook: 前缀）不是合法空间标识，跳过收编，交给写侧 (A2) 规整。
      const routeSpace = "space" in route ? route.space : null;
      if (routeSpace && !routeSpace.startsWith("notebook:") && routeSpace !== getCurrentWorkspace()) {
        setCurrentWorkspace(routeSpace);
        try {
          window.dispatchEvent(new CustomEvent("nowen:workspace-changed", { detail: { workspaceId: routeSpace } }));
        } catch {}
      }
      // route 镜像始终更新（视图层据其渲染），回声只跳过状态回灌。
      actions.setRoute(route);
      // 离开文档路由时清掉「打不开」状态页，避免它粘在主区
      if (route.kind !== "note") actions.setNoteLoadError?.(null);
      // 记住知识库上下文（聚焦的库 / 打开的文档）：切到回收站、插件等功能再切回来时
      // 用它恢复上次位置，而不是一律回到知识库根。按空间分别存。
      // 停在库根时也要记录（否则记忆会停留在更早的库/文档，切回来跳到旧位置）。
      if (route.kind === "kb" || route.kind === "note"
        || (route.kind === "module" && route.viewMode === "notebook")) {
        const remembered = `${pathname}${window.location.search}`;
        lastNotebookPathRef.current = remembered;
        try { localStorage.setItem(lastNotebookPathKey(), remembered); } catch {}
      }
      if (
        event?.type === APP_PATH_CHANGED_EVENT
        && (event as CustomEvent<AppPathChangedDetail>).detail?.appPath === expectedUrlRef.current
      ) {
        return;
      }
      dispatchRoute(route, event);
    };

    applyRoute();
    const onPopState = (event: PopStateEvent) => applyRoute(event);
    const onAppPathChanged = (event: Event) => applyRoute(event);
    window.addEventListener("popstate", onPopState);
    window.addEventListener(APP_PATH_CHANGED_EVENT, onAppPathChanged);

    return () => {
      disposed = true;
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(APP_PATH_CHANGED_EVENT, onAppPathChanged);
    };
  }, [actions, cancelNoteLoad, loadNote, prefs.enableNoteTabs, t]);

  // ============ 写侧：状态 → URL（唯一 reconcile，first-writer-wins） ============
  useEffect(() => {
    const activeNoteId = state.activeNote?.id ?? null;
    const previousActiveNoteId = previousActiveNoteIdRef.current;
    const previousViewMode = previousViewModeRef.current;
    const previousRouteKind = previousRouteKindRef.current;
    const activeNoteChanged = activeNoteId !== previousActiveNoteId;
    const enteredNoteWorkspace = (
      !NOTE_WORKSPACE_VIEWS.has(previousViewMode)
      && NOTE_WORKSPACE_VIEWS.has(state.viewMode)
    );
    const viewModeChanged = state.viewMode !== previousViewMode;
    const wasResource = RESOURCE_ROUTE_KINDS.has(previousRouteKind);
    const isResource = RESOURCE_ROUTE_KINDS.has(state.route.kind);
    const resourceRouteChanged = wasResource !== isResource;

    // 先记录本次 render 观察到的值（原语义：防止陈旧 activeNote 劫持深链）。
    previousActiveNoteIdRef.current = activeNoteId;
    previousViewModeRef.current = state.viewMode;
    previousRouteKindRef.current = state.route.kind;
    previousActiveToolTabRef.current = state.activeToolTab;

    // 尾随斜杠规整：地址栏 /kb/ 与 /kb 视为同一路径，否则 (A2) 的短形态补全
    // 会因字符串不等被跳过，URL 停留在 /kb/ 而视图已是 /kb/:space。
    const pathname = resolveCurrentAppPathname().replace(/\/+$/, "") || "/";
    const route = state.route;
    // 当前空间（localStorage）：写带空间域路径时的空间段来源。
    const currentSpace = getCurrentWorkspace();
    // 知识库进入态（route 派生）：URL 保留库层级
    const enteredKbId = route.kind === "kb"
      ? route.kbId
      : route.kind === "note" ? route.kbId ?? null : null;
    // 知识库模块根（带空间段）。契约测试锁定此标识。
    const kbRootTarget = () => moduleAppPath("notebook", currentSpace) ?? KB_ROOT_APP_PATH;

    // 附加参数（?q= 搜索、?scope= 筛选、?tree=focus 聚焦）：不属于路由本体，
    // reconcile 写路由时必须透传，否则打开笔记等导航会把它们抹掉。
    const EXTRA_QUERY_KEYS = ["q", "scope", "tree"] as const;
    const write = (target: string, mode: "push" | "replace") => {
      const targetUrl = new URL(target, window.location.origin);
      const currentUrl = new URL(window.location.href);
      for (const key of EXTRA_QUERY_KEYS) {
        // ?tree=focus 只属于知识库路径：切到回收站/插件等模块时应当丢弃
        if (key === "tree" && !target.startsWith("/kb/")) continue;
        const value = currentUrl.searchParams.get(key);
        if (value !== null && !targetUrl.searchParams.has(key)) targetUrl.searchParams.set(key, value);
      }
      target = `${targetUrl.pathname}${targetUrl.search}`;
      if (resolveCurrentAppPathname() + window.location.search === target) return;
      if (mode === "push") pushAppPathState(target);
      else replaceAppPathState(target);
      expectedUrlRef.current = target;
    };

        // (A0) 工具页签路由同步：activeToolTab 是工具页签的唯一状态源，URL 跟随。
    // 放在 (A) 之前——工具页激活期间 (A) 会把常规笔记路径写回而抹掉 /tools/:key。
    if (state.activeToolTab && route.kind !== "tool") {
      write(`/tools/${state.activeToolTab}`, "push");
      return;
    }
    if (!state.activeToolTab && route.kind === "tool") {
      // 工具页签被关闭 → 回常规路径（下一轮 (A)/(C) 写资源路径；这里直接落位）
      write(state.activeNote
        ? kbNoteAppPath(currentSpace, enteredKbId, state.activeNote.id)
        : kbRootTarget(), "replace");
      return;
    }

    // (0) note 深链加载中：URL 所有权在加载方，直到状态真正反映出来（原 pending 语义）。
    //     在 onSuccess 里清太早：React 可能尚未提交 setActiveNote，同一轮 effect 会看到
    //     activeNote=null 而把 URL 规整回 "/"。
    if (pendingRouteNoteIdRef.current) {
      if (
        state.activeNote?.id === pendingRouteNoteIdRef.current
        && route.kind === "note"
        && route.noteId === pendingRouteNoteIdRef.current
      ) {
        pendingRouteNoteIdRef.current = null;
      } else if (route.kind === "note" && route.noteId !== pendingRouteNoteIdRef.current) {
        // 导航已被新的笔记替代（快速连点 A→B）：A 的加载不会再完成，锁必须让位，
        // 否则后续所有 URL 写入都被这里 return 掉，界面表现为「切一下就卡住」。
        pendingRouteNoteIdRef.current = null;
      } else {
        return;
      }
    }

    // (A2) 遗留/省略形态规整：/、/dashboard（废弃误用）、/kb（短形态）以及旧版
    //     树节点 id 深链（/kb/notebook:*）都只读不写——replace 成当前空间的
    //     完整形态 /kb/:space（popstate 回退到遗留条目时同样规整，状态清理由
    //     home 分支完成）。
    if (route.kind === "home") {
      const isLegacyRoot = pathname === "/" || pathname === "/dashboard" || pathname === KB_ROOT_APP_PATH;
      const isLegacyNodeLink = !!route.space && route.space.startsWith("notebook:");
      if (isLegacyRoot || isLegacyNodeLink) {
        write(kbRootTarget(), "replace");
        return;
      }
    }

    // (A3) 带空间域模块的短形态（/trash、/favorites、/issues）：补当前空间段，
    //     URL 永远完整，不留省略形态。
    if (route.kind === "module" && route.space == null && state.viewMode === route.viewMode) {
      const target = moduleAppPath(route.viewMode, currentSpace);
      if (target) {
        write(target, "replace");
        return;
      }
    }

    // (A1) 切回知识库：恢复到上次位置（聚焦的库 / 打开的文档）而不是一律回库根。
    //     必须排在 (A) 之前：从回收站等模块切回时 activeNote 仍在，(A) 会先写一条
    //     丢掉库层级与 ?tree=focus 的笔记路径并 return，聚焦态就无法恢复。
    if (
      state.viewMode === "notebook"
      && viewModeChanged
      && route.kind === "module"
      && lastNotebookPathRef.current
      && lastNotebookPathRef.current !== `${pathname}${window.location.search}`
    ) {
      write(lastNotebookPathRef.current, "replace");
      return;
    }

    // (A) 笔记工作区规则（原 NoteDeepLinkBridge 写侧，原样移植）：
    //     显式笔记导航 / URL 为知识库根时 push 笔记路径；URL 已对或外来资源路由未
    //     显式导航时不抢。route.kind === "kb"（库 Overview）不在此列——URL 已表达
    //     「看库概览」，有打开笔记也不能把它抢写成 notes 路径（Overview 让位规则：
    //     点文档/页签才回编辑器）。
    if (NOTE_WORKSPACE_VIEWS.has(state.viewMode)) {
      if (activeNoteId) {
        const urlMatches = route.kind === "note"
          && route.noteId === activeNoteId
          && (route.kbId ?? null) === enteredKbId;
        if (urlMatches) {
          // URL 已正确 → 继续走后续模块规则（徽章切模块时由 (C) 接管 URL）
        } else {
          const explicitNoteNavigation = activeNoteChanged || enteredNoteWorkspace;
          if (
            route.kind === "home"
            || route.kind === "note"
            || explicitNoteNavigation
          ) {
            write(kbNoteAppPath(currentSpace, enteredKbId, activeNoteId), "push");
            return;
          }
          // 其余情况保持外来 URL（/sheets、/mindmaps、/issues、模块路径）
        }
      } else if (route.kind === "note") {
        // 工作区内无 activeNote 且 URL 是笔记残留 → 清回知识库模块根（墓碑根治点：
        // 关光页签的 URL 清理与状态同流，无需时间窗猜测）
        write(kbRootTarget(), "replace");
        return;
      }
    }

    // (B) 资源路由离开规则（原 App.tsx 三个互防 effect）
    if (state.viewMode === "mindmaps" && route.kind !== "mindmap") {
      write("/mindmaps", "replace");
      return;
    }
    if (route.kind === "mindmap" && state.viewMode !== "mindmaps") {
      write(kbRootTarget(), "replace");
      return;
    }
    if (route.kind === "sheet" && (state.activeNote || state.viewMode !== "all")) {
      write(kbRootTarget(), "replace");
      return;
    }
    if (route.kind === "issue" && state.viewMode !== "issues") {
      write(moduleAppPath("issues", route.space ?? currentSpace) ?? "/issues", "replace");
      return;
    }

    // (C) 模块路径同步（原 App.tsx W2d）：仅在 viewMode 变化或资源路由进出时运行
    //     （原 effect 依赖即此二者），避免把合法的 /notes/:id 规整掉引发回写乒乓。
    if (
      (viewModeChanged || resourceRouteChanged)
      && route.kind !== "sheet" && route.kind !== "mindmap" && route.kind !== "issue"
    ) {
      // URL 已带库层级（/kb/:space/:kbId[...]）时仅在笔记家族内不规整——否则会把
      // 刚解析好的完整形态削成模块根，kb 层就此丢失（刷新恢复失败的根因）。
      // 切到其它模块（垃圾箱/分享/文件等）是用户显式意图，必须写模块 URL，
      // 否则从库 Overview/库内文档点 Rail 图标时 URL 不跟随。
      const stayingInNoteFamily = state.viewMode === "notebook" || state.viewMode === "favorites";
      const kbContextUrl = route.kind === "kb" || (route.kind === "note" && !!route.kbId);
      if (!kbContextUrl || !stayingInNoteFamily) {
        const target = moduleAppPath(state.viewMode, currentSpace);
        if (target) {
          write(target, "replace");
          return;
        }
      }
    }
  }, [state.activeNote, state.viewMode, state.route, state.activeToolTab]);

  return null;
}
