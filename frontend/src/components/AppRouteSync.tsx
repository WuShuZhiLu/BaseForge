import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useApp, useAppActions } from "@/store/AppContext";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { useNoteLoader } from "@/hooks/useNoteLoader";
import { api } from "@/lib/api";
import {
  APP_PATH_CHANGED_EVENT,
  pushAppPathState,
  replaceAppPathState,
  resolveCurrentAppPathname,
  type AppPathChangedDetail,
} from "@/lib/appPathNavigation";
import { getCurrentNoteAppRoute } from "@/lib/noteDeepLink";
import {
  NOTE_WORKSPACE_VIEWS,
  parseAppRoute,
  VIEW_MODE_APP_PATHS,
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
  const pendingRouteNoteIdRef = useRef<string | null>(null);
  const routeLoadSequenceRef = useRef(0);
  // 自回声抑制：Owner 自己刚写入的期望 URL。他人命令式 push（pushSheetAppPath
  // 等）与 popstate 不等于该值，正常走意图分发。
  const expectedUrlRef = useRef<string>(resolveCurrentAppPathname());

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
            if (getCurrentNoteAppRoute().noteId !== noteId) return;

            activeNoteRef.current = note;
            actions.setActiveNote(note);
            actions.setSelectedNotebook(note.notebookId);
            actions.setViewMode("notebook");
            actions.setMobileView("editor");
            if (prefs.enableNoteTabs) actions.openNoteTab(tabFromNote(note));
          },
          onError: (error) => {
            if (disposed || sequence !== routeLoadSequenceRef.current) return;
            if (getCurrentNoteAppRoute().noteId !== noteId) return;

            console.error("[app-route] failed to open routed note", { noteId, error });
            // 协调器会保留错误浮层；回列表前先清掉。
            cancelNoteLoad();
            pendingRouteNoteIdRef.current = null;
            activeNoteRef.current = null;
            actions.setActiveNote(null);
            actions.setMobileView("list");
            actions.setViewMode("all");
            replaceAppPathState("/");
            expectedUrlRef.current = "/";
            const status = (error as { status?: number })?.status;
            if (status === 404 || status === 403) {
              // A 404 also hides inaccessible notes and password-protected folders.
              toast.info(t("noteList.routeUnavailableHint"));
            } else {
              toast.error(error instanceof Error ? error.message : t("noteList.loadErrorTitle"));
            }
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
      if (route.kind === "module") {
        actions.setViewMode(route.viewMode);
        return;
      }
      // home：popstate = 用户显式后退 → 清编辑器回列表；其余（回声/他人清理）
      // 不动状态，由写侧 reconcile 决定是否把资源 URL 补回来（原 restore guard 职责）。
      if (event?.type === "popstate") {
        cancelNoteLoad();
        activeNoteRef.current = null;
        actions.setActiveNote(null);
        actions.setMobileView("list");
        actions.setViewMode("all");
      }
    };

    const applyRoute = (event?: Event) => {
      const pathname = resolveCurrentAppPathname();
      const route = parseAppRoute(pathname);
      // route 镜像始终更新（视图层据其渲染），回声只跳过状态回灌。
      actions.setRoute(route);
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

    const pathname = resolveCurrentAppPathname();
    const route = state.route;

    const write = (target: string, mode: "push" | "replace") => {
      if (resolveCurrentAppPathname() === target) return;
      if (mode === "push") pushAppPathState(target);
      else replaceAppPathState(target);
      expectedUrlRef.current = target;
    };

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
      } else {
        return;
      }
    }

    // (A) 笔记工作区规则（原 NoteDeepLinkBridge 写侧，原样移植）：
    //     显式笔记导航 / URL 为根时 push /notes/:id；URL 已对或外来资源路由未
    //     显式导航时不抢。
    if (NOTE_WORKSPACE_VIEWS.has(state.viewMode)) {
      if (activeNoteId) {
        if (route.kind === "note" && route.noteId === activeNoteId) {
          // URL 已正确 → 继续走后续模块规则（徽章切模块时由 (C) 接管 URL）
        } else {
          const explicitNoteNavigation = activeNoteChanged || enteredNoteWorkspace;
          if (pathname === "/" || route.kind === "note" || explicitNoteNavigation) {
            write(`/notes/${encodeURIComponent(activeNoteId)}`, "push");
            return;
          }
          // 其余情况保持外来 URL（/sheets、/mindmaps、/issues、模块路径）
        }
      } else if (route.kind === "note") {
        // 工作区内无 activeNote 且 URL 是笔记残留 → 清回根（墓碑根治点：
        // 关光页签的 URL 清理与状态同流，无需时间窗猜测）
        write("/", "replace");
        return;
      }
    }

    // (B) 资源路由离开规则（原 App.tsx 三个互防 effect）
    if (state.viewMode === "mindmaps" && route.kind !== "mindmap") {
      write("/mindmaps", "replace");
      return;
    }
    if (route.kind === "mindmap" && state.viewMode !== "mindmaps") {
      write("/", "replace");
      return;
    }
    if (route.kind === "sheet" && (state.activeNote || state.viewMode !== "all")) {
      write("/", "replace");
      return;
    }
    if (route.kind === "issue" && state.viewMode !== "issues") {
      write("/", "replace");
      return;
    }

    // (C) 模块路径同步（原 App.tsx W2d）：仅在 viewMode 变化或资源路由进出时运行
    //     （原 effect 依赖即此二者），避免把合法的 /notes/:id 规整掉引发回写乒乓。
    if (
      (viewModeChanged || resourceRouteChanged)
      && route.kind !== "sheet" && route.kind !== "mindmap" && route.kind !== "issue"
    ) {
      const target = VIEW_MODE_APP_PATHS[state.viewMode];
      if (target) {
        write(target, "replace");
        return;
      }
    }
  }, [state.activeNote, state.viewMode, state.route]);

  return null;
}
