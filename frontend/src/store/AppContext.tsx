import React, { createContext, useCallback, useContext, useEffect, useReducer, useMemo, useRef } from "react";
import { isConversionMetadataSafe, isConversionNoteSafe, subscribeConversionInvalidation } from "@/lib/encryptedNotes/conversionBarrier";
import { Notebook, NoteListItem, Note, Tag, ViewMode } from "@/types";
import { api } from "@/lib/api";
import { NOTEBOOKS_INVALIDATED_EVENT } from "@/lib/notebookInvalidation";
import { PhaseAPerfProfiler } from "@/components/PhaseAPerfProfiler";
import { recordPhaseAPerfEvent } from "@/lib/phaseAPerfDiagnostics";
import type { NoteLoadBeginPayload, NoteLoadSummary } from "@/lib/noteLoadCoordinator";
import { primaryNoteLoadCoordinator } from "@/lib/noteLoadCoordinator";
import { NoteActivationGuard } from "@/lib/noteActivationGuard";
import {
  mergeAuthoritativeNotebooks,
  replaceOptimisticNotebook,
} from "@/lib/notebookCreateState";
import { prepareEditorSplitClose } from "@/lib/editorSplitMirror";
import type { EditorSplitReferenceSide } from "@/lib/editorWorkspaceLayout";
import type { SidebarPanelId } from "@/lib/sidebarPanels";
import { getCurrentAppRoute, type AppRoute } from "@/lib/appRoute";

export type SyncStatus = "idle" | "pending" | "saving" | "saved" | "error" | "offline" | "queued";
export type MobileView = "list" | "editor";

export interface NoteLoadingState {
  requestId: number;
  pendingNoteId: string | null;
  pendingSummary: NoteLoadSummary | null;
  startedAt: number | null;
  visible: boolean;
  slow: boolean;
  error: string | null;
}

export interface OpenNoteTab {
  id: string;
  title: string;
  notebookId: string;
  workspaceId?: string | null;
  contentFormat?: string;
  isLocked?: number;
  isTrashed?: number;
  updatedAt?: string;
  pinned?: boolean;
}

export type EditorSplitDirection = "right" | "down";

export interface EditorSplitState {
  /** 参考栏（副栏）文档 id。 */
  noteId: string;
  /**
   * 主栏文档 id；null 表示主栏空态（先分屏、后选文档）。
   * 旧状态/旧调用方缺省时由 reducer 迁移为派发当时的 activeNote.id。
   * 两栏与文档固定绑定：聚焦切换只把 activeNote 指向被聚焦的栏，
   * 不交换两栏文档（渲染侧见 EditorSplitView）。
   */
  primaryNoteId?: string | null;
  direction: EditorSplitDirection;
  /**
   * 参考栏沿分屏轴的位置（可选，历史状态缺省为 "end"）。
   * ⇄ 交换两栏时翻转它：文档与栏的绑定不动，只交换两栏的视觉位置。
   */
  referenceSide?: EditorSplitReferenceSide;
}

/** 左侧栏面板 id（方案 B）：唯一定义在 lib/sidebarPanels.ts（面板框架），此处 re-export 兼容旧引用。 */
export type { SidebarPanelId };

/** 工具页签（方案 B · B2）：待办 / 分享 / 附件管理 / 回收站。
 *  工具页签占用主区编辑器列；笔记「打开的」列表在侧栏面板（OpenEditorsPanel / SidebarDesktop）。 */
export type ToolTabKey = "tasks" | "shares" | "files" | "trash";
export const TOOL_TAB_KEYS: ToolTabKey[] = ["tasks", "shares", "files", "trash"];

interface AppState {
  notebooks: Notebook[];
  notes: NoteListItem[];
  activeNote: Note | null;
  tags: Tag[];
  selectedNotebookId: string | null;
  /** 三栏知识树当前层：undefined 表示沿用旧 notebook 选择，null 表示知识树根目录。 */
  selectedKnowledgeTreeParentId: string | null | undefined;
  selectedTagId: string | null;          // 已废弃，保留兼容；优先使用 selectedTagIds
  selectedTagIds: string[];              // TAG-FILTER-MULTI-01: 多标签联合筛选
  viewMode: ViewMode;
  /** 左侧栏当前面板（方案 B：Rail 只切面板，不替换主区）。
   *  B1a 上线 tree/tags；B1b 扩到 fav/trash/files。 */
  sidebarPanel: SidebarPanelId;
  /** 统一路由镜像（单一 RouteOwner 维护，见 lib/appRoute.ts）：
   *  URL 解析结果，供视图层判断 isSheetView / issue 详情 / 导图路由等。 */
  route: AppRoute;
  searchQuery: string;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  noteListWidth: number;
  /** 桌面端：笔记列表面板是否折叠（折叠后整列消失，编辑器占满）。
   *  与 sidebarCollapsed 完全平行的开关，互不影响。 */
  noteListCollapsed: boolean;
  /** 桌面端：编辑器专注全屏。仅临时隐藏外侧导航，不改写各面板折叠偏好。 */
  editorFullscreen: boolean;
  isLoading: boolean;
  /** 兼容旧组件：仅在延迟阈值后或错误状态下为 true。 */
  noteLoading: boolean;
  /** 当前主编辑区正在打开的目标笔记及分级加载状态。 */
  noteLoadingState: NoteLoadingState;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  mobileView: MobileView;
  mobileSidebarOpen: boolean;
  /** 全局"笔记列表刷新"令牌：递增时 NoteList 会重新拉取当前视图的列表 */
  notesRefreshToken: number;
  /** 打开的笔记页签：只保存元信息，不保存正文/编辑器状态。展示于侧栏「打开的」面板。 */
  openNoteTabs: OpenNoteTab[];
  /** 已打开的工具页签（顺序即显示顺序）。 */
  openToolTabs: ToolTabKey[];
  /** 当前激活的工具页签；null 表示主区显示笔记/其它视图。 */
  activeToolTab: ToolTabKey | null;
  /** 路由文档打开失败（不存在/无权限）：主区显示「打不开」状态页，不跳转、不丢 URL。 */
  noteLoadError: { noteId: string; status?: number; message?: string } | null;
  /** 桌面端编辑区分屏：一个副分屏；两栏各自固定绑定一篇文档（primaryNoteId + noteId），聚焦切换只改 activeNote。 */
  editorSplit: EditorSplitState | null;
}

type Action =
  | { type: "SET_NOTEBOOKS"; payload: Notebook[] }
  | { type: "ADD_NOTEBOOK"; payload: Notebook }
  | { type: "REPLACE_NOTEBOOK"; payload: { id: string; notebook: Notebook } }
  | { type: "UPDATE_NOTEBOOK"; payload: Partial<Notebook> & { id: string } }
  | { type: "REMOVE_NOTEBOOK"; payload: string }
  | { type: "INVALIDATE_CONVERTED_NOTE"; payload: string }
  | { type: "SET_NOTES"; payload: NoteListItem[] }
  | { type: "SET_ACTIVE_NOTE"; payload: Note | null }
  | { type: "SET_TAGS"; payload: Tag[] }
  | { type: "SET_SELECTED_NOTEBOOK"; payload: string | null }
  | { type: "SET_SELECTED_KNOWLEDGE_TREE_PARENT"; payload: string | null | undefined }
  | { type: "SET_SELECTED_TAG"; payload: string | null }
  | { type: "SET_SELECTED_TAGS"; payload: string[] }        // TAG-FILTER-MULTI-01
  | { type: "TOGGLE_SELECTED_TAG"; payload: string }        // TAG-FILTER-MULTI-01
  | { type: "CLEAR_SELECTED_TAGS" }                         // TAG-FILTER-MULTI-01
  | { type: "SET_VIEW_MODE"; payload: ViewMode }
  | { type: "SET_SIDEBAR_PANEL"; payload: SidebarPanelId }
  | { type: "SET_ROUTE"; payload: AppRoute }
  | { type: "SET_SEARCH_QUERY"; payload: string }
  | { type: "TOGGLE_SIDEBAR" }
  | { type: "SET_SIDEBAR_WIDTH"; payload: number }
  | { type: "SET_NOTELIST_WIDTH"; payload: number }
  | { type: "TOGGLE_NOTELIST_COLLAPSED" }
  | { type: "SET_EDITOR_FULLSCREEN"; payload: boolean }
  | { type: "TOGGLE_EDITOR_FULLSCREEN" }
  | { type: "SET_LOADING"; payload: boolean }
  | { type: "SET_NOTE_LOADING"; payload: boolean }
  | { type: "BEGIN_NOTE_LOAD"; payload: NoteLoadBeginPayload }
  | { type: "SHOW_NOTE_LOAD"; payload: number }
  | { type: "MARK_NOTE_LOAD_SLOW"; payload: number }
  | { type: "FAIL_NOTE_LOAD"; payload: { requestId: number; error: string } }
  | { type: "FINISH_NOTE_LOAD"; payload: number }
  | { type: "UPDATE_NOTE_IN_LIST"; payload: Partial<NoteListItem> & { id: string } }
  | { type: "REMOVE_NOTE_FROM_LIST"; payload: string }
  | { type: "ADD_NOTE_TO_LIST"; payload: NoteListItem }
  | { type: "SET_SYNC_STATUS"; payload: SyncStatus }
  | { type: "SET_LAST_SYNCED"; payload: string }
  | { type: "SET_MOBILE_VIEW"; payload: MobileView }
  | { type: "SET_MOBILE_SIDEBAR"; payload: boolean }
  | { type: "TRIGGER_REFRESH_NOTES" }
  | { type: "OPEN_NOTE_TAB"; payload: OpenNoteTab }
  | { type: "OPEN_TOOL_TAB"; payload: ToolTabKey }
  | { type: "CLOSE_TOOL_TAB"; payload: ToolTabKey }
  | { type: "SET_ACTIVE_TOOL_TAB"; payload: ToolTabKey | null }
  | { type: "SET_NOTE_LOAD_ERROR"; payload: { noteId: string; status?: number; message?: string } | null }
  | { type: "CLOSE_NOTE_TAB"; payload: string }
  | { type: "UPDATE_NOTE_TAB"; payload: Partial<OpenNoteTab> & { id: string } }
  | { type: "REMOVE_NOTE_TAB"; payload: string }
  | { type: "CLEAR_NOTE_TABS" }
  | { type: "SET_NOTE_TABS"; payload: OpenNoteTab[] }
  | { type: "SPLIT_EDITOR"; payload: EditorSplitState }
  | { type: "CLOSE_EDITOR_SPLIT" }
  | { type: "CLEAR_EDITOR_SPLITS" };

const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

const DEFAULT_NOTELIST_WIDTH = 300;
const MIN_NOTELIST_WIDTH = 220;
const MAX_NOTELIST_WIDTH = 500;
const MAX_OPEN_NOTE_TABS = 12;

function createIdleNoteLoadingState(): NoteLoadingState {
  return {
    requestId: 0,
    pendingNoteId: null,
    pendingSummary: null,
    startedAt: null,
    visible: false,
    slow: false,
    error: null,
  };
}

function sortOpenNoteTabs(tabs: OpenNoteTab[]): OpenNoteTab[] {
  return [...tabs].sort((a, b) => {
    if (!!a.pinned === !!b.pinned) return 0;
    return a.pinned ? -1 : 1;
  });
}

function trimOpenNoteTabs(tabs: OpenNoteTab[], activeId?: string | null): OpenNoteTab[] {
  if (tabs.length <= MAX_OPEN_NOTE_TABS) return tabs;
  const removableIndex = tabs.findIndex((tab) => !tab.pinned && tab.id !== activeId);
  const fallbackIndex = tabs.findIndex((tab) => tab.id !== activeId);
  const index = removableIndex >= 0 ? removableIndex : fallbackIndex;
  if (index < 0) return tabs.slice(-MAX_OPEN_NOTE_TABS);
  return tabs.filter((_, tabIndex) => tabIndex !== index);
}

export const OPEN_NOTE_TAB_STORAGE_KEY = "nowen-open-note-tabs";

/**
 * 从 localStorage 恢复「打开的」页签。恢复通道与 dispatch 通道走同样的防线：
 * 条目形状校验（防旧版本/脏数据形态）、加密转换屏障 isConversionMetadataSafe
 * （已转换笔记不得以明文 contentFormat 复活）、按 id 去重、上限截断。
 * 不做存在性校验（需要后端）：404 由 useTabNoteOpener 打开时自愈移除。
 */
function loadSavedOpenNoteTabs(): OpenNoteTab[] {
  try {
    const saved = localStorage.getItem(OPEN_NOTE_TAB_STORAGE_KEY);
    const parsed: unknown = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const restored: OpenNoteTab[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const candidate = entry as Partial<OpenNoteTab>;
      if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 512) continue;
      if (seen.has(candidate.id)) continue;
      const tab: OpenNoteTab = {
        id: candidate.id,
        title: typeof candidate.title === "string" ? candidate.title : "",
        notebookId: typeof candidate.notebookId === "string" ? candidate.notebookId : "",
        workspaceId: typeof candidate.workspaceId === "string" ? candidate.workspaceId : null,
        contentFormat: typeof candidate.contentFormat === "string" ? candidate.contentFormat : undefined,
        isLocked: candidate.isLocked === 1 ? 1 : 0,
        isTrashed: candidate.isTrashed === 1 ? 1 : 0,
        updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
        pinned: candidate.pinned === true,
      };
      if (!isConversionMetadataSafe(tab)) continue;
      seen.add(tab.id);
      restored.push(tab);
      if (restored.length >= MAX_OPEN_NOTE_TABS) break;
    }
    return restored;
  } catch {
    return [];
  }
}

function getSavedSidebarWidth(): number {
  try {
    const saved = localStorage.getItem("nowen-sidebar-width");
    if (saved) {
      const w = Number(saved);
      if (w >= MIN_SIDEBAR_WIDTH && w <= MAX_SIDEBAR_WIDTH) return w;
    }
  } catch {}
  return DEFAULT_SIDEBAR_WIDTH;
}

function getSavedNoteListWidth(): number {
  try {
    const saved = localStorage.getItem("nowen-notelist-width");
    if (saved) {
      const w = Number(saved);
      if (w >= MIN_NOTELIST_WIDTH && w <= MAX_NOTELIST_WIDTH) return w;
    }
  } catch {}
  return DEFAULT_NOTELIST_WIDTH;
}

function getSavedNoteListCollapsed(): boolean {
  try {
    return localStorage.getItem("nowen-notelist-collapsed") === "1";
  } catch {
    return false;
  }
}

const initialState: AppState = {
  notebooks: [],
  notes: [],
  activeNote: null,
  tags: [],
  selectedNotebookId: null,
  selectedKnowledgeTreeParentId: undefined,
  selectedTagId: null,
  selectedTagIds: [],
  viewMode: "all",
  sidebarPanel: "tree",
  route: getCurrentAppRoute(),
  searchQuery: "",
  sidebarCollapsed: false,
  sidebarWidth: getSavedSidebarWidth(),
  noteListWidth: getSavedNoteListWidth(),
  noteListCollapsed: getSavedNoteListCollapsed(),
  editorFullscreen: false,
  isLoading: false,
  noteLoading: false,
  noteLoadingState: createIdleNoteLoadingState(),
  syncStatus: "idle",
  lastSyncedAt: null,
  mobileView: "list",
  mobileSidebarOpen: false,
  notesRefreshToken: 0,
  openNoteTabs: loadSavedOpenNoteTabs(),
  openToolTabs: [],
  activeToolTab: null,
  noteLoadError: null,
  editorSplit: null,
};

export { MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, MIN_NOTELIST_WIDTH, MAX_NOTELIST_WIDTH, DEFAULT_NOTELIST_WIDTH };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_NOTEBOOKS":
      return {
        ...state,
        notebooks: mergeAuthoritativeNotebooks(state.notebooks, action.payload),
      };
    case "ADD_NOTEBOOK":
      if (state.notebooks.some((notebook) => notebook.id === action.payload.id)) return state;
      return { ...state, notebooks: [...state.notebooks, action.payload] };
    case "REPLACE_NOTEBOOK": {
      const notebooks = replaceOptimisticNotebook(
        state.notebooks,
        action.payload.id,
        action.payload.notebook,
      );
      return notebooks === state.notebooks ? state : { ...state, notebooks };
    }
    case "UPDATE_NOTEBOOK":
      return {
        ...state,
        notebooks: state.notebooks.map((notebook) =>
          notebook.id === action.payload.id ? { ...notebook, ...action.payload } : notebook
        ),
      };
    case "REMOVE_NOTEBOOK":
      return { ...state, notebooks: state.notebooks.filter((notebook) => notebook.id !== action.payload) };
    case "INVALIDATE_CONVERTED_NOTE": {
      const split = state.editorSplit;
      return {
        ...state,
        activeNote: state.activeNote?.id === action.payload ? null : state.activeNote,
        notes: state.notes.filter((note) => note.id !== action.payload),
        openNoteTabs: state.openNoteTabs.filter((tab) => tab.id !== action.payload),
        // 参考栏文档被转换 → 整个分屏关闭；主栏文档被转换 → 主栏退回空态，分屏保留。
        editorSplit: !split
          ? null
          : split.noteId === action.payload
            ? null
            : split.primaryNoteId === action.payload
              ? { ...split, primaryNoteId: null }
              : split,
        noteLoading: state.noteLoadingState.pendingNoteId === action.payload ? false : state.noteLoading,
        noteLoadingState: state.noteLoadingState.pendingNoteId === action.payload ? createIdleNoteLoadingState() : state.noteLoadingState,
        notesRefreshToken: state.notesRefreshToken + 1,
      };
    }
    case "SET_NOTES":
      return { ...state, notes: action.payload.filter(isConversionNoteSafe) };
    case "SET_ACTIVE_NOTE": {
      if (action.payload && !isConversionNoteSafe(action.payload)) return state;
      const split = state.editorSplit;
      const note = action.payload;
      // 无分屏 / 清空焦点 / 聚焦主栏：主栏文档绑定不受影响。
      if (!split || !note || note.id === split.primaryNoteId) {
        return { ...state, activeNote: note };
      }
      if (note.id === split.noteId) {
        // 聚焦参考栏文档：两栏与文档的绑定原地不动，只切换焦点。
        return { ...state, activeNote: note };
      }
      // 打开两栏之外的第三篇文档：落到主栏（主栏文档跟随 activeNote）。
      return { ...state, activeNote: note, editorSplit: { ...split, primaryNoteId: note.id } };
    }
    case "SET_TAGS":
      return { ...state, tags: action.payload };
    case "SET_SELECTED_NOTEBOOK":
      if (state.selectedNotebookId === action.payload) return state;
      return {
        ...state,
        selectedNotebookId: action.payload,
        selectedKnowledgeTreeParentId: undefined,
      };
    case "SET_SELECTED_KNOWLEDGE_TREE_PARENT":
      if (state.selectedKnowledgeTreeParentId === action.payload) return state;
      return { ...state, selectedKnowledgeTreeParentId: action.payload };
    case "SET_SELECTED_TAG": {
      // 兼容旧调用：同步更新 selectedTagId + selectedTagIds
      const id = action.payload;
      return {
        ...state,
        selectedTagId: id,
        selectedTagIds: id ? [id] : [],
      };
    }
    case "SET_SELECTED_TAGS": {
      const ids = action.payload;
      return {
        ...state,
        selectedTagIds: ids,
        selectedTagId: ids.length === 1 ? ids[0] : null,
      };
    }
    case "TOGGLE_SELECTED_TAG": {
      const tagId = action.payload;
      const exists = state.selectedTagIds.includes(tagId);
      const next = exists
        ? state.selectedTagIds.filter((id) => id !== tagId)
        : [...state.selectedTagIds, tagId];
      return {
        ...state,
        selectedTagIds: next,
        selectedTagId: next.length === 1 ? next[0] : null,
      };
    }
    case "CLEAR_SELECTED_TAGS":
      return {
        ...state,
        selectedTagIds: [],
        selectedTagId: null,
      };
    case "OPEN_TOOL_TAB": {
      const already = state.openToolTabs.includes(action.payload);
      return {
        ...state,
        openToolTabs: already ? state.openToolTabs : [...state.openToolTabs, action.payload],
        activeToolTab: action.payload,
      };
    }
    case "CLOSE_TOOL_TAB": {
      const rest = state.openToolTabs.filter((key) => key !== action.payload);
      const nextActive =
        state.activeToolTab === action.payload ? (rest.length > 0 ? rest[rest.length - 1] : null) : state.activeToolTab;
      return { ...state, openToolTabs: rest, activeToolTab: nextActive };
    }
    case "SET_ACTIVE_TOOL_TAB":
      return state.activeToolTab === action.payload ? state : { ...state, activeToolTab: action.payload };
    case "SET_NOTE_LOAD_ERROR":
      return { ...state, noteLoadError: action.payload };
    case "SET_SIDEBAR_PANEL":
      return state.sidebarPanel === action.payload
        ? state
        : { ...state, sidebarPanel: action.payload, sidebarCollapsed: false };
    case "SET_VIEW_MODE":
      // 幂等：视图未变化时返回原 state，避免下游 useEffect 重复拉取造成卡顿
      if (state.viewMode === action.payload) return state;
      return { ...state, viewMode: action.payload };
    case "SET_ROUTE":
      // 去重须含查询附加字段（q/scope/tree）：?tree=focus 等瞬态只改 query 不改
      // url/kind，按 url 去重会把「进入/退出库内树空间」的路由更新整个吞掉。
      return state.route.url === action.payload.url && state.route.kind === action.payload.kind
        && state.route.q === action.payload.q
        && state.route.scope === action.payload.scope
        && state.route.tree === action.payload.tree
        ? state
        : { ...state, route: action.payload };
    case "SET_SEARCH_QUERY":
      if (state.searchQuery === action.payload) return state;
      return { ...state, searchQuery: action.payload };
    case "TOGGLE_SIDEBAR":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case "SET_SIDEBAR_WIDTH": {
      const w = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, action.payload));
      try { localStorage.setItem("nowen-sidebar-width", String(w)); } catch {}
      return { ...state, sidebarWidth: w };
    }
    case "SET_NOTELIST_WIDTH": {
      const w = Math.max(MIN_NOTELIST_WIDTH, Math.min(MAX_NOTELIST_WIDTH, action.payload));
      try { localStorage.setItem("nowen-notelist-width", String(w)); } catch {}
      return { ...state, noteListWidth: w };
    }
    case "TOGGLE_NOTELIST_COLLAPSED": {
      const next = !state.noteListCollapsed;
      try { localStorage.setItem("nowen-notelist-collapsed", next ? "1" : "0"); } catch {}
      return { ...state, noteListCollapsed: next };
    }
    case "SET_EDITOR_FULLSCREEN":
      return { ...state, editorFullscreen: action.payload };
    case "TOGGLE_EDITOR_FULLSCREEN":
      return { ...state, editorFullscreen: !state.editorFullscreen };
    case "SET_LOADING":
      return { ...state, isLoading: action.payload };
    case "SET_NOTE_LOADING":
      return action.payload
        ? {
          ...state,
          noteLoading: true,
          noteLoadingState: { ...state.noteLoadingState, visible: true, error: null },
        }
        : { ...state, noteLoading: false, noteLoadingState: createIdleNoteLoadingState() };
    case "BEGIN_NOTE_LOAD":
      if (!isConversionMetadataSafe({ id: action.payload.noteId, ...action.payload.summary })) return state;
      return {
        ...state,
        noteLoading: false,
        noteLoadingState: {
          requestId: action.payload.requestId,
          pendingNoteId: action.payload.noteId,
          pendingSummary: action.payload.summary,
          startedAt: action.payload.startedAt,
          visible: false,
          slow: false,
          error: null,
        },
      };
    case "SHOW_NOTE_LOAD":
      if (state.noteLoadingState.requestId !== action.payload) return state;
      return {
        ...state,
        noteLoading: true,
        noteLoadingState: { ...state.noteLoadingState, visible: true },
      };
    case "MARK_NOTE_LOAD_SLOW":
      if (state.noteLoadingState.requestId !== action.payload) return state;
      return {
        ...state,
        noteLoadingState: { ...state.noteLoadingState, slow: true },
      };
    case "FAIL_NOTE_LOAD":
      if (state.noteLoadingState.requestId !== action.payload.requestId) return state;
      return {
        ...state,
        noteLoading: true,
        noteLoadingState: {
          ...state.noteLoadingState,
          visible: true,
          slow: false,
          error: action.payload.error,
        },
      };
    case "FINISH_NOTE_LOAD":
      if (state.noteLoadingState.requestId !== action.payload) return state;
      return { ...state, noteLoading: false, noteLoadingState: createIdleNoteLoadingState() };
    case "UPDATE_NOTE_IN_LIST":
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === action.payload.id && isConversionNoteSafe({ ...n, ...action.payload }) ? { ...n, ...action.payload } : n
        ),
      };
    case "REMOVE_NOTE_FROM_LIST":
      return {
        ...state,
        notes: state.notes.filter((n) => n.id !== action.payload),
      };
    case "ADD_NOTE_TO_LIST":
      // 如果笔记已存在，不重复添加（避免 AnimatePresence 中出现重复 key）
      if (!isConversionNoteSafe(action.payload) || state.notes.some((n) => n.id === action.payload.id)) {
        return state;
      }
      return {
        ...state,
        notes: [action.payload, ...state.notes],
      };
    case "SET_SYNC_STATUS":
      return { ...state, syncStatus: action.payload };
    case "SET_LAST_SYNCED":
      return { ...state, lastSyncedAt: action.payload };
    case "SET_MOBILE_VIEW":
      return { ...state, mobileView: action.payload };
    case "SET_MOBILE_SIDEBAR":
      return { ...state, mobileSidebarOpen: action.payload };
    case "TRIGGER_REFRESH_NOTES":
      return { ...state, notesRefreshToken: state.notesRefreshToken + 1 };
    case "OPEN_NOTE_TAB": {
      const incoming = action.payload;
      if (!isConversionMetadataSafe(incoming)) return state;
      const existingIndex = state.openNoteTabs.findIndex((tab) => tab.id === incoming.id);
      let tabs = existingIndex >= 0
        ? state.openNoteTabs.map((tab) =>
          tab.id === incoming.id ? { ...tab, ...incoming, pinned: incoming.pinned ?? tab.pinned } : tab
        )
        : [...state.openNoteTabs, incoming];
      tabs = trimOpenNoteTabs(sortOpenNoteTabs(tabs), state.activeNote?.id);
      return { ...state, openNoteTabs: tabs, activeToolTab: null };
    }
    case "CLOSE_NOTE_TAB":
    case "REMOVE_NOTE_TAB":
      return {
        ...state,
        openNoteTabs: state.openNoteTabs.filter((tab) => tab.id !== action.payload),
        editorSplit: state.editorSplit?.noteId === action.payload ? null : state.editorSplit,
      };
    case "UPDATE_NOTE_TAB":
      return {
        ...state,
        openNoteTabs: sortOpenNoteTabs(state.openNoteTabs.map((tab) =>
          tab.id === action.payload.id && isConversionMetadataSafe({ ...tab, ...action.payload }) ? { ...tab, ...action.payload } : tab
        )),
      };
    case "CLEAR_NOTE_TABS":
      return { ...state, openNoteTabs: [], editorSplit: null, activeNote: null };
    case "SET_NOTE_TABS":
      return {
        ...state,
        openNoteTabs: trimOpenNoteTabs(sortOpenNoteTabs(action.payload.filter(isConversionMetadataSafe)), state.activeNote?.id),
        editorSplit: state.editorSplit && action.payload.some((tab) => tab.id === state.editorSplit?.noteId)
          ? state.editorSplit
          : null,
      };
    case "SPLIT_EDITOR":
      return {
        ...state,
        editorSplit: {
          ...action.payload,
          // 旧调用方只传参考栏文档：主栏缺省迁移为派发当时的 activeNote（无主文档 → null 空态）。
          primaryNoteId: action.payload.primaryNoteId !== undefined
            ? action.payload.primaryNoteId
            : (state.activeNote?.id ?? null),
        },
      };
    case "CLOSE_EDITOR_SPLIT":
    case "CLEAR_EDITOR_SPLITS":
      return { ...state, editorSplit: null };
    default:
      return state;
  }
}

const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // 打开的页签持久化：刷新后恢复"打开的编辑器"（侧栏面板依赖）
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_NOTE_TAB_STORAGE_KEY, JSON.stringify(state.openNoteTabs));
    } catch { /* quota/serialization failures are non-fatal */ }
  }, [state.openNoteTabs]);
  const noteActivationGuard = useMemo(() => new NoteActivationGuard(), []);
  const profiledDispatch = useCallback<React.Dispatch<Action>>((action) => {
    // 关闭页签/清空页签时取消仍在进行的加载，否则迟到的加载结果会把
    // activeNote 重新写回已关闭的笔记（URL 也会跳回 /notes/:id）。
    if (action.type === "CLEAR_NOTE_TABS") {
      if (stateRef.current.noteLoadingState.pendingNoteId) primaryNoteLoadCoordinator.cancel();
    } else if (action.type === "CLOSE_NOTE_TAB" || action.type === "REMOVE_NOTE_TAB") {
      if (stateRef.current.noteLoadingState.pendingNoteId === action.payload) {
        primaryNoteLoadCoordinator.cancel();
      }
    }
    if (action.type === "BEGIN_NOTE_LOAD") {
      noteActivationGuard.begin(action.payload, stateRef.current.activeNote?.id ?? null);
    } else if (action.type === "FAIL_NOTE_LOAD") {
      noteActivationGuard.fail(action.payload.requestId);
    } else if (action.type === "FINISH_NOTE_LOAD") {
      noteActivationGuard.finish(action.payload);
    }

    if (
      action.type === "SET_ACTIVE_NOTE"
      && !noteActivationGuard.allowActiveNote(action.payload?.id ?? null)
    ) {
      recordPhaseAPerfEvent({
        type: "app-context-dispatch",
        detail: { action: action.type, changedFields: "blocked-stale-note-activation" },
      });
      return;
    }

    const current = stateRef.current;
    const leavingNote = (
      (action.type === "SET_ACTIVE_NOTE" && Boolean(current.activeNote) && action.payload?.id !== current.activeNote?.id)
      || (action.type === "SET_VIEW_MODE" && current.viewMode !== action.payload)
      || (action.type === "SET_MOBILE_VIEW" && action.payload !== "editor")
      || ((action.type === "CLOSE_NOTE_TAB" || action.type === "REMOVE_NOTE_TAB") && action.payload === current.activeNote?.id)
    );
    if (leavingNote) {
      // 加密笔记/含加密区域的笔记在离开前可拦截：监听方有未保存改动时会 preventDefault。
      if (!window.dispatchEvent(new Event("nowen:encrypted-note-before-leave", { cancelable: true }))) return;
    }
    let changedFields = "";
    if (action.type === "SET_ACTIVE_NOTE") {
      const previous = current.activeNote;
      const next = action.payload;
      if (previous && next) {
        changedFields = Object.keys(next)
          .filter((key) => previous[key as keyof Note] !== next[key as keyof Note])
          .join(",");
      } else if (previous !== next) {
        changedFields = "activeNote";
      }
    }
    recordPhaseAPerfEvent({
      type: "app-context-dispatch",
      detail: { action: action.type, changedFields },
    });
    dispatch(action);
  }, [noteActivationGuard]);

  useEffect(() => subscribeConversionInvalidation((noteId) => {
    dispatch({ type: "INVALIDATE_CONVERTED_NOTE", payload: noteId });
  }), []);

  useEffect(() => {
    noteActivationGuard.commit(state.activeNote?.id ?? null);
  }, [noteActivationGuard, state.activeNote?.id]);

  useEffect(() => {
    let refreshTimer: number | null = null;
    let requestVersion = 0;

    const reconcileNotebookTree = () => {
      const version = ++requestVersion;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      // Drag-and-drop performs move then sibling reorder as two confirmed requests.
      // Debounce both invalidations so the final read cannot race the reorder write.
      refreshTimer = window.setTimeout(async () => {
        refreshTimer = null;
        try {
          const notebooks = await api.getNotebooks();
          if (version !== requestVersion) return;
          dispatch({ type: "SET_NOTEBOOKS", payload: notebooks });
          // The selected notebook query includes descendants. Moving a folder changes
          // that scope even though no note row changed, so refresh the main list and
          // every expanded notebook's direct-note cache as one reconciliation step.
          dispatch({ type: "TRIGGER_REFRESH_NOTES" });
        } catch (error) {
          console.error("[AppContext] failed to reconcile notebook tree:", error);
        }
      }, 250);
    };

    window.addEventListener(NOTEBOOKS_INVALIDATED_EVENT, reconcileNotebookTree);
    return () => {
      requestVersion++;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener(NOTEBOOKS_INVALIDATED_EVENT, reconcileNotebookTree);
    };
  }, []);

  return (
    <AppContext.Provider value={{ state, dispatch: profiledDispatch }}>
      <PhaseAPerfProfiler id="AppProvider">{children}</PhaseAPerfProfiler>
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used within AppProvider");
  return context;
}

export function useAppActions() {
  const { dispatch } = useApp();

  // 用 useMemo 让返回对象保持稳定引用 —— 只要 dispatch 不变，整个 actions 对象也稳定。
  // 这样依赖 `[actions]` 的 useCallback / useEffect 不会在每次 render 都失效，
  // 从而避免保存期间频繁 dispatch 导致的编辑器状态抖动（如光标跳行）。
  return useMemo(() => ({
    setNotebooks: (v: Notebook[]) => dispatch({ type: "SET_NOTEBOOKS", payload: v }),
    addNotebook: (v: Notebook) => dispatch({ type: "ADD_NOTEBOOK", payload: v }),
    replaceNotebook: (id: string, notebook: Notebook) => dispatch({ type: "REPLACE_NOTEBOOK", payload: { id, notebook } }),
    updateNotebook: (v: Partial<Notebook> & { id: string }) => dispatch({ type: "UPDATE_NOTEBOOK", payload: v }),
    removeNotebook: (id: string) => dispatch({ type: "REMOVE_NOTEBOOK", payload: id }),
    setNotes: (v: NoteListItem[]) => dispatch({ type: "SET_NOTES", payload: v }),
    setActiveNote: (v: Note | null) => dispatch({ type: "SET_ACTIVE_NOTE", payload: v }),
    setTags: (v: Tag[]) => dispatch({ type: "SET_TAGS", payload: v }),
    setSelectedNotebook: (v: string | null) => dispatch({ type: "SET_SELECTED_NOTEBOOK", payload: v }),
    setSelectedKnowledgeTreeParent: (v: string | null | undefined) => dispatch({
      type: "SET_SELECTED_KNOWLEDGE_TREE_PARENT",
      payload: v,
    }),
    setSelectedTag: (v: string | null) => dispatch({ type: "SET_SELECTED_TAG", payload: v }),
    setSelectedTags: (v: string[]) => dispatch({ type: "SET_SELECTED_TAGS", payload: v }),
    toggleSelectedTag: (v: string) => dispatch({ type: "TOGGLE_SELECTED_TAG", payload: v }),
    clearSelectedTags: () => dispatch({ type: "CLEAR_SELECTED_TAGS" }),
    setViewMode: (v: ViewMode) => dispatch({ type: "SET_VIEW_MODE", payload: v }),
    setRoute: (r: AppRoute) => dispatch({ type: "SET_ROUTE", payload: r }),
    setSidebarPanel: (p: SidebarPanelId) => dispatch({ type: "SET_SIDEBAR_PANEL", payload: p }),
    setSearchQuery: (v: string) => dispatch({ type: "SET_SEARCH_QUERY", payload: v }),
    toggleSidebar: () => dispatch({ type: "TOGGLE_SIDEBAR" }),
    setSidebarWidth: (v: number) => dispatch({ type: "SET_SIDEBAR_WIDTH", payload: v }),
    setNoteListWidth: (v: number) => dispatch({ type: "SET_NOTELIST_WIDTH", payload: v }),
    toggleNoteListCollapsed: () => dispatch({ type: "TOGGLE_NOTELIST_COLLAPSED" }),
    setEditorFullscreen: (v: boolean) => dispatch({ type: "SET_EDITOR_FULLSCREEN", payload: v }),
    toggleEditorFullscreen: () => dispatch({ type: "TOGGLE_EDITOR_FULLSCREEN" }),
    setLoading: (v: boolean) => dispatch({ type: "SET_LOADING", payload: v }),
    setNoteLoading: (v: boolean) => dispatch({ type: "SET_NOTE_LOADING", payload: v }),
    beginNoteLoad: (payload: NoteLoadBeginPayload) => dispatch({ type: "BEGIN_NOTE_LOAD", payload }),
    showNoteLoad: (requestId: number) => dispatch({ type: "SHOW_NOTE_LOAD", payload: requestId }),
    markNoteLoadSlow: (requestId: number) => dispatch({ type: "MARK_NOTE_LOAD_SLOW", payload: requestId }),
    failNoteLoad: (requestId: number, error: string) => dispatch({ type: "FAIL_NOTE_LOAD", payload: { requestId, error } }),
    finishNoteLoad: (requestId: number) => dispatch({ type: "FINISH_NOTE_LOAD", payload: requestId }),
    updateNoteInList: (v: Partial<NoteListItem> & { id: string }) => dispatch({ type: "UPDATE_NOTE_IN_LIST", payload: v }),
    removeNoteFromList: (id: string) => dispatch({ type: "REMOVE_NOTE_FROM_LIST", payload: id }),
    addNoteToList: (v: NoteListItem) => dispatch({ type: "ADD_NOTE_TO_LIST", payload: v }),
    setSyncStatus: (v: SyncStatus) => dispatch({ type: "SET_SYNC_STATUS", payload: v }),
    setLastSynced: (v: string) => dispatch({ type: "SET_LAST_SYNCED", payload: v }),
    setMobileView: (v: MobileView) => dispatch({ type: "SET_MOBILE_VIEW", payload: v }),
    setMobileSidebar: (v: boolean) => dispatch({ type: "SET_MOBILE_SIDEBAR", payload: v }),
    openNoteTab: (v: OpenNoteTab) => dispatch({ type: "OPEN_NOTE_TAB", payload: v }),
    openToolTab: (key: ToolTabKey) => dispatch({ type: "OPEN_TOOL_TAB", payload: key }),
    closeToolTab: (key: ToolTabKey) => dispatch({ type: "CLOSE_TOOL_TAB", payload: key }),
    setActiveToolTab: (key: ToolTabKey | null) => dispatch({ type: "SET_ACTIVE_TOOL_TAB", payload: key }),
    setNoteLoadError: (payload: { noteId: string; status?: number; message?: string } | null) => dispatch({ type: "SET_NOTE_LOAD_ERROR", payload }),
    closeNoteTab: (id: string) => dispatch({ type: "CLOSE_NOTE_TAB", payload: id }),
    updateNoteTab: (v: Partial<OpenNoteTab> & { id: string }) => dispatch({ type: "UPDATE_NOTE_TAB", payload: v }),
    removeNoteTab: (id: string) => dispatch({ type: "REMOVE_NOTE_TAB", payload: id }),
    clearNoteTabs: () => dispatch({ type: "CLEAR_NOTE_TABS" }),
    setNoteTabs: (v: OpenNoteTab[]) => dispatch({ type: "SET_NOTE_TABS", payload: v }),
    splitEditor: (v: EditorSplitState) => dispatch({ type: "SPLIT_EDITOR", payload: v }),
    closeEditorSplit: () => {
      prepareEditorSplitClose();
      dispatch({ type: "CLOSE_EDITOR_SPLIT" });
    },
    clearEditorSplits: () => {
      prepareEditorSplitClose();
      dispatch({ type: "CLEAR_EDITOR_SPLITS" });
    },
    refreshNotebooks: () => {
      api.getNotebooks().then((v) => dispatch({ type: "SET_NOTEBOOKS", payload: v })).catch(console.error);
    },
    /** 触发 NoteList 重新拉取当前视图的笔记列表 */
    refreshNotes: () => dispatch({ type: "TRIGGER_REFRESH_NOTES" }),
  }), [dispatch]);
}