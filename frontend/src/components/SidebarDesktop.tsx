/**
 * SidebarDesktop —— 原型 r15 侧栏的 React 实现（批次 A+B+C）
 *
 * 视觉与交互事实源：docs/product/base-notes-current.backup-20261017-r15.html
 * 规格：docs/product/impl-brief-01-sidebar.md
 *
 * 与旧 SidebarMobile 并存：旧 SidebarMobile 已从 App.tsx 摘除，本组件为当前唯一生效侧栏。
 * 范围：头部（位置/搜索/筛选）+ 三面板（知识库/标签/打开的编辑器）
 *      + 知识树嵌套/折叠/搜索/筛选 + 专注模式 + 行级菜单
 *      + 拖拽 + 面板沉底 + 区段拖拽排序。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  CheckCircle2,
  ChevronDown,
  Circle,
  ExternalLink,
  FileCode,
  FileText,
  Folder,
  Home,
  Link2,
  ListTodo,
  Pin,
  Play,
  BookOpen,
  PenTool,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Table2,
  Sparkles,
  Star,
  Trash2,
  Upload,
  Users,
  Waypoints,
  X,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useApp, useAppActions } from "@/store/AppContext";
import { api, getCurrentWorkspace, setCurrentWorkspace } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  knowledgeTreeApi,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import type { FileItem, NoteListItem, PmProject, PmWorkItem, PmWorkItemStatus, Tag, Workspace } from "@/types";
import { JoinWorkspaceDialog } from "@/components/WorkspaceSwitcher";
import { BUILTIN_PLUGINS, getDisabledBuiltinPlugins, isBuiltinPluginEnabled, setBuiltinPluginDisabled, type BuiltinPluginId } from "@/plugins/builtin/registry";
import { TasksMiniPanel, DiaryMiniPanel, PmMiniPanel } from "@/plugins/builtin/MiniPanels";
import { KnowledgeTreeCreateDropdown, type KnowledgeTreeCreateMenuState } from "@/components/KnowledgeTreeCreateMenuRuntime";
import { FaFolder, FaBook } from "react-icons/fa";
import {
  importMarkdownIntoKnowledgeTree,
  importMarkdownZipIntoKnowledgeTree,
  importWordIntoKnowledgeTree,
  importPdfIntoKnowledgeTree,
  importWeChatArticleIntoKnowledgeTree,
} from "@/components/knowledgeTreeImport";
import type { KnowledgeTreeImportRequest } from "@/components/KnowledgeTreePanel";
import YuqueImport from "@/components/YuqueImport";
import { toast } from "@/lib/toast";
import {
  KNOWLEDGE_TREE_SORT_OPTIONS,
  KNOWLEDGE_TREE_SORT_CHANGED_EVENT,
  loadKnowledgeTreeSortMode,
  saveKnowledgeTreeSortMode,
  type KnowledgeTreeSortMode,
} from "@/lib/knowledgeTreeSort";
import FileUploadDialog from "@/components/FileUploadDialog";
import { pushAppPathState, replaceAppPathState, resolveCurrentAppPathname, hasInAppForwardNavigationOccurred } from "@/lib/appPathNavigation";
import { kbNoteAppPath, KB_ROOT_APP_PATH, moduleAppPath } from "@/lib/appRoute";
import { pushSheetAppPath } from "@/lib/sheetDeepLink";
import { getNextTabAfterClose, useTabNoteOpener } from "@/hooks/useTabNoteOpener";
import { useNoteLoader } from "@/hooks/useNoteLoader";

/** 侧栏根宽，原型固定 260px（批次 C 做拖宽，范围 200–420）。 */
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 420;

type FilterScope = "all" | "folder" | "note";

/** 区段顺序（可拖拽排序，持久化到 localStorage）。收藏作为知识库面板的一个区段（功能太少，不设独立面板） */
type SectionId = "kb" | "tags" | "editors" | "star";
const SECTION_ORDER_KEY = "nowen-next-sidebar-sections";

type ExpandedSet = Set<string>;

interface FlatRow {
  node: KnowledgeTreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  ancestorIds: string[];
}

/** 折叠全部按钮的图标态：全部折叠中（可展开）↔ 全部展开中（可折叠） */
function isAnyFolderExpanded(nodes: KnowledgeTreeNode[], expanded: ExpandedSet): boolean {
  return nodes.some(
    (n) => !n.isDeleted && n.nodeType === "folder" && expanded.has(n.id),
  );
}

function buildChildrenMap(nodes: KnowledgeTreeNode[], sortMode?: KnowledgeTreeSortMode) {
  const children = new Map<string | null, KnowledgeTreeNode[]>();
  for (const node of nodes) {
    const key = node.parentId ?? null;
    const list = children.get(key);
    if (list) list.push(node);
    else children.set(key, [node]);
  }
  for (const list of children.values()) {
    const byManual = (a: KnowledgeTreeNode, b: KnowledgeTreeNode) =>
      a.sortOrder - b.sortOrder || a.title.localeCompare(b.title);
    switch (sortMode) {
      case "title-asc": list.sort((a, b) => a.title.localeCompare(b.title)); break;
      case "title-desc": list.sort((a, b) => b.title.localeCompare(a.title)); break;
      case "updated-desc": list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); break;
      case "created-desc": list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); break;
      default: list.sort(byManual);
    }
  }
  return children;
}

/**
 * 可见性引擎（brief 4.3）。
 * @param focusRootId 专注模式根节点 id；非空时只遍历该子树。
 */
function buildRows(
  nodes: KnowledgeTreeNode[],
  expanded: ExpandedSet,
  query: string,
  scope: FilterScope,
  focusRootId: string | null,
): FlatRow[] {
  const children = buildChildrenMap(nodes);
  const keyword = query.trim().toLowerCase();
  const searching = keyword.length > 0;

  const matchesScope = (node: KnowledgeTreeNode): boolean => {
    if (scope === "all") return true;
    const isFolder = node.nodeType === "folder";
    return scope === "folder" ? isFolder : !isFolder;
  };
  const matchesKeyword = (node: KnowledgeTreeNode): boolean =>
    !searching || node.title.toLowerCase().includes(keyword);

  const rows: FlatRow[] = [];
  let sawVisible = false;

  const walk = (parentId: string | null, depth: number, ancestorIds: string[]) => {
    const list = children.get(parentId) ?? [];
    for (const node of list) {
      if (node.isDeleted) continue;
      const kids = children.get(node.id) ?? [];
      const hasChildren = kids.length > 0;
      const isExpanded = expanded.has(node.id);

      if (searching) {
        // 搜索：忽略折叠态，自身或后代命中即显示，路径自动展开
        const subtreeHit = matchesKeyword(node) && matchesScope(node);
        const descendantHit = subtreeHasMatch(node.id, children, keyword, scope);
        if (!subtreeHit && !descendantHit) continue;
        sawVisible = true;
        rows.push({ node, depth, hasChildren, expanded: true, ancestorIds });
        walk(node.id, depth + 1, [...ancestorIds, node.id]);
        continue;
      }

      // 无关键词：scope 过滤（文件夹作为路径保留，但"仅笔记"下无可见文档的空文件夹剔除）
      const self = matchesScope(node);
      if (scope === "note" && !self) {
        // 文件夹只有在其子树内存在文档时才保留
        if (subtreeHasMatch(node.id, children, "", "note")) {
          sawVisible = true;
          rows.push({ node, depth, hasChildren, expanded: isExpanded, ancestorIds });
          if (isExpanded) walk(node.id, depth + 1, [...ancestorIds, node.id]);
        }
        continue;
      }
      if (scope === "folder" && !self && !hasChildren) continue;
      if (scope === "folder" && !self) {
        // 仅文件夹模式：含子文件夹的文件夹保留
        if (!subtreeHasMatch(node.id, children, "", "folder")) continue;
      }

      sawVisible = true;
      rows.push({ node, depth, hasChildren, expanded: isExpanded, ancestorIds });
      if (isExpanded) walk(node.id, depth + 1, [...ancestorIds, node.id]);
    }
  };

  if (focusRootId) {
    const focusRoot = nodes.find((n) => n.id === focusRootId && !n.isDeleted);
    if (focusRoot) {
      const isExpanded = expanded.has(focusRoot.id) || true;
      const kids = children.get(focusRoot.id) ?? [];
      rows.push({
        node: focusRoot,
        depth: 0,
        hasChildren: kids.length > 0,
        expanded: isExpanded,
        ancestorIds: [],
      });
      walk(focusRoot.id, 1, [focusRoot.id]);
    }
  } else {
    walk(null, 0, []);
  }

  // scope=note 无关键词时空文件夹已被 walk 内剔除；scope=folder 空叶子文件夹同理。
  void sawVisible;
  return rows;
}

/** 子树内是否存在匹配节点（用于搜索命中路径与 scope 下的路径保留）。 */
function subtreeHasMatch(
  nodeId: string,
  children: Map<string | null, KnowledgeTreeNode[]>,
  keyword: string,
  scope: FilterScope,
): boolean {
  const k = keyword.trim().toLowerCase();
  const stack = [...(children.get(nodeId) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.isDeleted) continue;
    const isFolder = cur.nodeType === "folder";
    const scopeHit = scope === "all" || (scope === "folder" ? isFolder : !isFolder);
    const kwHit = !k || cur.title.toLowerCase().includes(k);
    if (scopeHit && kwHit) return true;
    stack.push(...(children.get(cur.id) ?? []));
  }
  return false;
}

function fileIconFor(node: KnowledgeTreeNode, isRoot = false) {
  if (node.nodeType === "folder") {
    // 根层知识库（笔记本）用实心书本与普通实心文件夹区分
    if (isRoot && node.resourceType === "notebook") {
      return <FaBook size={14} className="shrink-0 text-accent-primary" />;
    }
    return <FaFolder size={14} className="shrink-0 text-amber-400" />;
  }
  // 轻量表格 / 思维导图节点（对齐 KnowledgeTreePanel 的语义图标）
  if (node.noteType === "sheet") {
    return <Table2 size={15} className="shrink-0 text-emerald-500" />;
  }
  if (node.contentFormat === "board") {
    return <PenTool size={15} className="shrink-0 text-teal-500" />;
  }
  // 导图归一后是 contentFormat="mindmap" 的笔记节点；nodeType/resourceType 判断保留给遗留数据。
  if (node.nodeType === "mindmap" || node.resourceType === "mindmap" || node.contentFormat === "mindmap") {
    return <Waypoints size={15} className="shrink-0 text-violet-500" />;
  }
  if (node.contentFormat === "pdf") {
    return <FileText size={15} className="shrink-0 text-red-500" />;
  }
  if (node.contentFormat === "markdown" || node.nodeType === "markdown") {
    return <FileCode size={15} className="shrink-0 text-emerald-500" />;
  }
  return <FileText size={15} className="shrink-0 text-[var(--color-accent-primary)]" />;
}

const TAG_DOT_COLORS = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#f43f5e", "#06b6d4"];

interface TagNodeRow {
  tag: Tag;
  expanded: boolean;
  docs: NoteListItem[];
}

interface RowMenuState {
  kind: "kb-folder" | "kb-note" | "tag-group" | "tag-doc" | "sec-kb";
  nodeId?: string;
  tagId?: string;
  docId?: string;
  x: number;
  y: number;
}

interface DragState {
  /** 被拖拽节点 id（kb 树） */
  nodeId?: string;
  /** 区段拖拽排序 */
  sectionId?: SectionId;
}

export default function SidebarDesktop() {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();

  const [nodes, setNodes] = useState<KnowledgeTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<FilterScope>("all");
  // 树筛选 scope ⇄ URL（?scope=note|folder）：与 ?q= 同款握手（回灌置标记让写侧让位）。
  const applyingRouteScopeRef = useRef(false);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // 回灌只由 route 变化驱动（不得依赖 scope 本身——否则用户改 scope 后会被
  // URL 旧值弹回，形成「切不回全部」的死锁）。
  useEffect(() => {
    const routeScope = state.route.scope;
    if (routeScope !== "note" && routeScope !== "folder") return;
    if (routeScope === scopeRef.current) return;
    applyingRouteScopeRef.current = true;
    setScope(routeScope);
  }, [state.route]);
  useEffect(() => {
    if (applyingRouteScopeRef.current) {
      applyingRouteScopeRef.current = false;
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const current = params.get("scope") ?? "all";
    if (current === scope) return;
    if (scope === "all") params.delete("scope");
    else params.set("scope", scope);
    const qs = params.toString();
    replaceAppPathState(`${resolveCurrentAppPathname()}${qs ? `?${qs}` : ""}`);
  }, [scope]);
  const [spaceOpen, setSpaceOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [expanded, setExpanded] = useState<ExpandedSet>(() => new Set());

  // 标签树状态
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagDocs, setTagDocs] = useState<Record<string, NoteListItem[]>>({});
  const [tagsExpanded, setTagsExpanded] = useState<ExpandedSet>(() => new Set());
  const [tagsLoading, setTagsLoading] = useState(true);

  // 专注模式（=知识库「进入态」）：面板显示库列表 ⇄ 该库目录树的两级态。
  // 唯一真相是 URL（/kb/:id[.../notes/:n]）：进入/退出只写 URL，由此处的
  // route 派生 effect 回灌本地 state；刷新/前进/后退天然恢复，无需 localStorage。
  const [focusRootId, setFocusRootId] = useState<string | null>(null);

  // 搜索结果弹层（搜当前空间标签+文档）
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchDocs, setSearchDocs] = useState<NoteListItem[]>([]);
  const [searchFetching, setSearching] = useState(false);
  // 搜索范围：进入知识库后默认「库内」，可切「全空间」；未进入恒为全空间
  const [searchScope, setSearchScope] = useState<"kb" | "all">("all");
  const [searchTagOpen, setSearchTagOpen] = useState<string | null>(null);
  const searchRef2 = useRef<HTMLDivElement>(null);

  // 行级菜单
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);

  // 重命名（行内 input）
  const [renaming, setRenaming] = useState<{ kind: "kb" | "tag"; id: string; value: string } | null>(null);

  // 区段折叠 + 排序（折叠状态持久化）
  const SECTION_COLLAPSED_KEY = "nowen-next-sidebar-sections-collapsed";
  const [collapsedSections, setCollapsedSections] = useState<Set<SectionId>>(() => {
    try {
      const saved = localStorage.getItem(SECTION_COLLAPSED_KEY);
      if (saved) return new Set((saved.split(",") as SectionId[]).filter(Boolean));
    } catch { /* ignore */ }
    return new Set();
  });
  useEffect(() => {
    try { localStorage.setItem(SECTION_COLLAPSED_KEY, Array.from(collapsedSections).join(",")); } catch { /* ignore */ }
  }, [collapsedSections]);
  // 模块侧栏面板折叠状态（projects/files/shares 等单块面板，同样持久化）
  const SIDEBAR_PANEL_COLLAPSED_KEY = "nowen-next-sidebar-panel-collapsed";
  const [panelCollapsed, setPanelCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_PANEL_COLLAPSED_KEY);
      if (saved) return JSON.parse(saved) as Record<string, boolean>;
    } catch { /* ignore */ }
    return {};
  });
  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_PANEL_COLLAPSED_KEY, JSON.stringify(panelCollapsed)); } catch { /* ignore */ }
  }, [panelCollapsed]);
  const togglePanelCollapsed = useCallback((key: string) => {
    setPanelCollapsed((cur) => ({ ...cur, [key]: !cur[key] }));
  }, []);
  const [sectionOrder, setSectionOrder] = useState<SectionId[]>(() => {
    try {
      const saved = localStorage.getItem(SECTION_ORDER_KEY);
      if (saved === "kb,tags,editors" || saved === "kb,editors,tags" || saved === "tags,kb,editors" ||
          saved === "tags,editors,kb" || saved === "editors,kb,tags" || saved === "editors,tags,kb") {
        return saved.split(",") as SectionId[];
      }
    } catch { /* ignore */ }
    return ["kb", "tags", "editors"];
  });

  // 拖拽
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    nodeId: string;
    position: "before" | "after" | "into";
  } | null>(null);

  // 定位高亮
  const [flashId, setFlashId] = useState<string | null>(null);

  // 侧栏宽度（批次 C）
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("nowen-next-sidebar-width"));
    return Number.isFinite(saved) && saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH
      ? saved
      : SIDEBAR_DEFAULT_WIDTH;
  });

  // 空间列表（头部位置按钮弹出）
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWs, setCurrentWs] = useState<string>(() => getCurrentWorkspace());

  // ===== 侧栏活动栏视图（FR-IA-02）：kb / star / trash / files / plugins =====
  // Rail 点击经 nowen:sidebar-view 事件切换；主区视图不变（语雀式）
  type SidebarView = "kb" | "trash" | "files" | "plugins" | "projects" | "shares";
  const [sidebarView, setSidebarView] = useState<SidebarView>("kb");

  // 收藏 / 回收站 / 文件管理数据
  const [starDocs, setStarDocs] = useState<NoteListItem[]>([]);
  const [trashItems, setTrashItems] = useState<import("@/features/trash/trashTypes").TrashItem[]>([]);
  const [fileItems, setFileItems] = useState<FileItem[]>([]);
  const [fileCat, setFileCat] = useState<"all" | "image" | "other">("all");
  // 插件列表（后端 GET /plugins）
  const [plugCat, setPlugCat] = useState<"installed" | "market" | "disabled">("installed");
  const [plugins, setPlugins] = useState<Array<{ id: string; name: string; description?: string; version: string; status: string; source?: string }>>([]);
  const [joinOpen, setJoinOpen] = useState(false);
  // 知识库面板：+ 新建菜单（复用旧版 KnowledgeTreeCreateDropdown）与 ⋮ 更多菜单（排序/折叠/刷新）
  const [createMenuState, setCreateMenuState] = useState<KnowledgeTreeCreateMenuState | null>(null);
  // Yuque 导入模态：null = 关闭；非 null = 目标笔记本 id（fallback 由 YuqueImport 处理）
  const [yuqueImportNotebookId, setYuqueImportNotebookId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<KnowledgeTreeSortMode>(() => loadKnowledgeTreeSortMode());
  const [kbMoreOpen, setKbMoreOpen] = useState<{ x: number; y: number } | null>(null);
  const [tagsMoreOpen, setTagsMoreOpen] = useState<{ x: number; y: number } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  // 侧栏内嵌打开的插件面板（runtimeId），null = 未打开（返回条隐藏）
  const [openPluginPanel, setOpenPluginPanel] = useState<string | null>(null);
  // 知识树统一选中系统：单选/ctrl 多选/shift 范围选；点空白清空
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("nowen-next-sidebar-selection");
      const parsed = saved ? (JSON.parse(saved) as string[]) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });
  const selectionAnchorRef = useRef<string | null>(null);
  const [builtinDisabled, setBuiltinDisabled] = useState<Set<BuiltinPluginId>>(() => getDisabledBuiltinPlugins());

  /** 切换侧栏视图并加载对应面板数据（Rail 事件与 viewMode 同步共用，避免同步路径缺数据） */
  const applySidebarView = useCallback((view: string) => {
    // 插件导航项（待办/日记/AI 问答）：侧栏切回知识库并打开对应迷你面板
    if (view === "tasks" || view === "diary" || view === "ai-chat") {
      setOpenPluginPanel(view === "ai-chat" ? "ai" : view);
      setSidebarView("kb");
      return;
    }
    // 切到其他视图（回收站/文件管理/插件/知识库等）时关闭插件迷你面板
    setOpenPluginPanel(null);
    if (!["kb", "trash", "files", "projects", "shares", "plugins"].includes(view)) return;
    setSidebarView(view as SidebarView);
    if (view === "trash") {
      api.trash.list(getCurrentWorkspace()).then((r) => setTrashItems(r.items)).catch(() => setTrashItems([]));
    }
    if (view === "files") {
      api.files.list({ pageSize: 100 }).then((r) => setFileItems(r.items)).catch(() => setFileItems([]));
    }
    if (view === "plugins") {
      api.plugins.list().then((list) => setPlugins(list)).catch(() => setPlugins([]));
    }
  }, []);

  useEffect(() => {
    const onSwitch = (event: Event) => {
      const raw = (event as CustomEvent<{ view: string }>).detail?.view;
      // Rail 事件视图名（ViewMode 语义）→ 侧栏视图 id（收藏已并入知识库面板区段）
      applySidebarView(raw === "notebook" || raw === "favorites" ? "kb" : raw ?? "");
    };
    window.addEventListener("nowen:sidebar-view", onSwitch);
    return () => window.removeEventListener("nowen:sidebar-view", onSwitch);
  }, [applySidebarView]);

  // 插件工作区「打开侧栏面板」按钮 → 侧栏切到知识库视图并展开对应迷你面板
  useEffect(() => {
    const onOpenPanel = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      setOpenPluginPanel(id);
      setSidebarView("kb");
    };
    window.addEventListener("nowen:open-plugin-panel", onOpenPanel);
    return () => window.removeEventListener("nowen:open-plugin-panel", onOpenPanel);
  }, []);

  // PM 主区激活时，侧栏跟随切到项目面板（URL 直达/刷新恢复不走 Rail 点击，需主动跟随）
  useEffect(() => {
    if (state.viewMode === "projects" && sidebarView !== "projects") applySidebarView("projects");
  }, [state.viewMode, sidebarView, applySidebarView]);

  // 三区联动：工作区切到核心模块视图时，侧栏跟随对应视图（含从非 Rail 入口进来的场景）
  useEffect(() => {
    const map: Partial<Record<string, SidebarView>> = {
      notebook: "kb",
      favorites: "kb",
      trash: "trash",
      files: "files",
      shares: "shares",
    };
    const v = map[state.viewMode];
    if (v && sidebarView !== v) applySidebarView(v);
  }, [state.viewMode, sidebarView, applySidebarView]);

  // 统一打开链路：页签/知识树/搜索/收藏的笔记打开共用 openNoteFromTab（协调器 + 404 自愈）
  const openNoteFromTab = useTabNoteOpener();
  const { loadNote, cancelNoteLoad } = useNoteLoader();

  // 收藏模块：当前笔记不在收藏中时，自动落到第一条收藏（避免编辑器停留在无关笔记）。
  // 走协调器（缓存优先 + 意图守卫）但保持原语义：只预载 activeNote，不切视图、不开页签。
  useEffect(() => {
    if (state.viewMode !== "favorites" || starDocs.length === 0) return;
    const activeId = state.activeNote?.id;
    if (activeId && starDocs.some((d) => d.id === activeId)) return;
    const first = starDocs[0];
    void loadNote({
      noteId: first.id,
      summary: { title: first.title ?? "", notebookId: first.notebookId ?? "", contentFormat: first.contentFormat },
      request: () => api.getNote(first.id),
      onSuccess: (note) => actions.setActiveNote(note),
    }).then((result) => {
      // 收藏列表可能是陈旧数据（笔记已删）：404 静默收场，不弹错误浮层
      if (result?.status === "error" && (result.error as { status?: number } | undefined)?.status === 404) {
        cancelNoteLoad();
      }
    });
  }, [state.viewMode, state.activeNote?.id, starDocs, loadNote, cancelNoteLoad, actions]);

  // 收藏区段数据：收藏已并入知识库面板区段（不再是独立视图），挂载与笔记变更时刷新
  const reloadStar = useCallback(() => {
    api.getNotes({ isFavorite: "1" }).then((items) => setStarDocs(items)).catch(() => undefined);
  }, []);
  useEffect(() => {
    reloadStar();
    const onKbChanged = () => reloadStar();
    window.addEventListener("nowen:knowledge-tree-changed", onKbChanged);
    return () => window.removeEventListener("nowen:knowledge-tree-changed", onKbChanged);
  }, [reloadStar]);

  useEffect(() => {
    const onChanged = () => setBuiltinDisabled(getDisabledBuiltinPlugins());
    window.addEventListener("nowen:builtin-plugins-changed", onChanged);
    return () => window.removeEventListener("nowen:builtin-plugins-changed", onChanged);
  }, []);

  const reloadTrash = useCallback(() => {
    api.trash.list(getCurrentWorkspace()).then((r) => setTrashItems(r.items)).catch(() => undefined);
  }, []);
  const reloadFiles = useCallback(() => {
    api.files.list({ pageSize: 100 }).then((r) => setFileItems(r.items)).catch(() => undefined);
  }, []);

  // 排序模式：保存并广播（本组件监听变化重排），与其他消费方共享
  const applySortMode = useCallback((mode: KnowledgeTreeSortMode) => {
    setSortMode(mode);
    saveKnowledgeTreeSortMode(mode);
  }, []);

  useEffect(() => {
    const onSortChanged = (event: Event) => {
      const mode = (event as CustomEvent<{ mode: KnowledgeTreeSortMode }>).detail?.mode;
      if (mode) setSortMode(mode);
    };
    window.addEventListener(KNOWLEDGE_TREE_SORT_CHANGED_EVENT, onSortChanged);
    return () => window.removeEventListener(KNOWLEDGE_TREE_SORT_CHANGED_EVENT, onSortChanged);
  }, []);

  /** + 新建菜单的统一创建入口（复用旧版节点创建语义） */
  const handleCreate = useCallback(async (parentId: string | null, kind: "folder" | "note" | "markdown" | "mindmap" | "sheet" | "plain" | "board") => {
    setCreateMenuState(null);
    try {
      const titles: Record<string, string> = {
        folder: "新建文件夹", note: "新建文档", markdown: "新建 Markdown",
        mindmap: "新建思维导图", sheet: "新建表格", plain: "新建纯文本", board: "新建画板",
      };
      const created = await knowledgeTreeApi.create({ parentId, nodeType: kind, title: titles[kind] });
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
      if (parentId) setExpanded((cur) => new Set(cur).add(parentId));
      // 创建后进入重命名（选中原标题，直接输入新名字），与行内新建体验一致
      setRenaming({ kind: "kb", id: created.id, value: created.title });
    } catch (error) {
      console.error("[SidebarDesktop] create node failed:", error);
    }
  }, []);

  // 知识树「导入」：与 KnowledgeTreePanel 的导入 effect 同一套实现（文件选择器 + 入库 + 刷新）。
  // 此前桌面树这里被接成 onImport={() => setCreateMenuState(null)} 的空壳——点导入只关菜单，什么都不发生。
  const handleImport = useCallback(async (parentId: string | null, importKind: KnowledgeTreeImportRequest["kind"]) => {
    setCreateMenuState(null);
    // Yuque 走模态流程（不依赖父节点类型）
    if (importKind === "yuque") {
      setYuqueImportNotebookId(
        state.activeNote?.notebookId || state.selectedNotebookId || (state.notebooks ?? [])[0]?.id || null,
      );
      return;
    }
    const parent = parentId ? nodes.find((node) => node.id === parentId) ?? null : null;
    const options = {
      parent,
      nodes,
      fallbackNotebookId: state.activeNote?.notebookId || state.selectedNotebookId || (state.notebooks ?? [])[0]?.id || null,
    };
    try {
      const imported = importKind === "markdown"
        ? await importMarkdownIntoKnowledgeTree(options)
        : importKind === "markdown-zip"
          ? await importMarkdownZipIntoKnowledgeTree(options)
          : importKind === "word"
            ? await importWordIntoKnowledgeTree(options)
            : importKind === "pdf"
              ? await importPdfIntoKnowledgeTree(options)
              : await importWeChatArticleIntoKnowledgeTree(options);
      if (!imported) return;
      if (parentId) setExpanded((cur) => new Set(cur).add(parentId));
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
      void openNoteFromTab(imported.id);
      actions.refreshNotes();
      actions.refreshNotebooks();
    } catch (error) {
      toast.error((error as Error)?.message || "导入失败，请重试");
    }
  }, [nodes, openNoteFromTab, actions, state.activeNote?.notebookId, state.selectedNotebookId, state.notebooks]);

  const spaceRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const treeRootRef = useRef<HTMLDivElement>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);

  // ---- 数据加载 ----
  const reload = useCallback(async () => {
    try {
      const response = await knowledgeTreeApi.list();
      setNodes(response.nodes);
    } catch (error) {
      console.error("[SidebarDesktop] knowledge tree load failed:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadTags = useCallback(async () => {
    try {
      const tagList = await api.getTags();
      setTags(tagList);
      // 拉每个标签的文档（并行）
      const results = await Promise.all(
        tagList.map(async (tag) => {
          try {
            const docs = await api.getNotesWithTag(tag.id);
            return [tag.id, docs] as const;
          } catch {
            return [tag.id, [] as NoteListItem[]] as const;
          }
        }),
      );
      setTagDocs(Object.fromEntries(results));
    } catch (error) {
      console.error("[SidebarDesktop] tags load failed:", error);
    } finally {
      setTagsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    void reloadTags();
    api.getWorkspaces().then((list) => setWorkspaces(list)).catch(() => undefined);
    const onChange = () => void reload();
    const onTagChange = () => void reloadTags();
    const onWsChange = () => setCurrentWs(getCurrentWorkspace());
    window.addEventListener("nowen:knowledge-tree-changed", onChange);
    window.addEventListener("nowen:workspace-changed", onChange);
    window.addEventListener("nowen:workspace-changed", onWsChange);
    window.addEventListener("nowen:tags-changed", onTagChange);
    return () => {
      window.removeEventListener("nowen:knowledge-tree-changed", onChange);
      window.removeEventListener("nowen:workspace-changed", onChange);
      window.removeEventListener("nowen:workspace-changed", onWsChange);
      window.removeEventListener("nowen:tags-changed", onTagChange);
    };
  }, [reload, reloadTags]);

  const switchSpace = useCallback((workspaceId: string) => {
    setCurrentWorkspace(workspaceId);
    setCurrentWs(workspaceId);
    window.dispatchEvent(new CustomEvent("nowen:workspace-changed", { detail: { workspaceId } }));
    // 旧空间的文档不属于新空间：切空间即收起，避免笔记路径被写进新空间的 URL。
    actions.setActiveNote(null);
    actions.setMobileView("list");
    // 空间真相归 URL：带空间域的路径上切空间 = 改写 URL 空间段，内容层级
    // 落到新空间的同模块根（读侧回灌其余状态；旧空间的库/文档不跨空间携带）。
    const route = state.route;
    let target: string | null = null;
    if (route.kind === "kb" || route.kind === "note" || route.kind === "home") {
      target = moduleAppPath("notebook", workspaceId);
    } else if (route.kind === "module" && route.space) {
      target = moduleAppPath(route.viewMode, workspaceId);
    } else if (route.kind === "issue") {
      target = moduleAppPath("issues", workspaceId);
    }
    if (target) pushAppPathState(target);
  }, [actions, state.route]);

  // ---- 标签默认展开：BLE（首个），其余折叠 —— 原型 r15 的默认态是首个展开 ----
  // AppContext.tags 变化（TagInput 增删标签会 setTags）时同步标签面板
  useEffect(() => {
    void reloadTags();
  }, [state.tags, reloadTags]);

  useEffect(() => {
    if (!tags.length) return;
    setTagsExpanded((current) => {
      if (current.size > 0) return current;
      const next: ExpandedSet = new Set();
      if (tags[0]) next.add(tags[0].id);
      return next;
    });
  }, [tags]);

  // ---- 浮层关闭 ----
  useEffect(() => {
    if (!spaceOpen && !filterOpen && !rowMenu && !searchOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!spaceRef.current?.contains(target)) setSpaceOpen(false);
      if (!filterRef.current?.contains(target)) setFilterOpen(false);
      if (!menuRef.current?.contains(target)) setRowMenu(null);
      // 搜索弹层：点弹层外（含搜索框本身外）关闭
      if (!searchRef2.current?.contains(target) && !searchRef.current?.contains(target)) setSearchOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Esc 优先退专注（brief 4.5），其次关菜单/浮层，最后清空搜索
      if (rowMenu) { setRowMenu(null); return; }
      if (spaceOpen || filterOpen) { setSpaceOpen(false); setFilterOpen(false); return; }
      if (focusRootId) { exitKb(); return; }
      if (searchOpen) { setSearchOpen(false); return; }
      if (query) { setQuery(""); return; }
      if (renaming) setRenaming(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [spaceOpen, filterOpen, rowMenu, focusRootId, query, renaming, searchOpen]);

  // ---- 重命名 input 自动聚焦 ----
  useEffect(() => {
    if (renaming) {
      requestAnimationFrame(() => renameInputRef.current?.select());
    }
  }, [renaming]);

  // ---- 搜索弹层：防抖搜当前空间文档 + 本地过滤标签 ----
  useEffect(() => {
    const keyword = query.trim();
    if (!keyword) {
      setSearchOpen(false);
      setSearchDocs([]);
      return;
    }
    setSearchOpen(true);
    setSearching(true);
    const timer = setTimeout(() => {
      api.searchNotes(keyword, 20)
        .then((items) => setSearchDocs(items as NoteListItem[]))
        .catch(() => setSearchDocs([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // ---- 搜索状态 ⇄ URL（?q= 叠加在当前路径上，replace 不污染历史）----
  // 写侧：与搜索请求同防抖节奏，停止输入 250ms 后 URL 稳定为 /当前路径?q=词；
  // 清空 → 移除 ?q=。lastUrlQRef 防止「URL 回灌 → 写侧 → 再回灌」的乒乓，
  // 并避免首帧把直开链接 ?q= 剥掉。AI/外部工具直达入口：/search?q=…。
  // ---- 搜索状态 ⇄ URL 握手 ----
  // 读侧（URL → 搜索框）：仅在 state.route 变化时运行；?q= 与本地不同才回灌，
  // 回灌前置 applyingRouteQRef 标记，写侧见标记即让位（防 StrictMode 双跑与
  // 「回灌覆盖用户输入」两个时序坑）。
  // 写侧（搜索框 → URL）：仅响应用户输入（标记未置位）；与 URL 现值对比相等
  // 则跳过（首帧直开 /search?q=x 时 URL 已正确，不剥 q）。
  const queryRef = useRef(query);
  queryRef.current = query;
  const applyingRouteQRef = useRef(false);
  useEffect(() => {
    if (!("q" in state.route)) return;
    const routeQ = (state.route as { q?: string }).q ?? "";
    if (routeQ === queryRef.current.trim()) return;
    applyingRouteQRef.current = true;
    setQuery(routeQ);
    setSearchOpen(Boolean(routeQ.trim()));
  }, [state.route]);
  useEffect(() => {
    if (applyingRouteQRef.current) {
      applyingRouteQRef.current = false;
      return;
    }
    const keyword = query.trim();
    const currentQ = new URLSearchParams(window.location.search).get("q") ?? "";
    if (keyword === currentQ) return;
    const base = resolveCurrentAppPathname();
    replaceAppPathState(keyword ? `${base}?q=${encodeURIComponent(keyword)}` : base);
  }, [query]);

  const matchedTags = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];
    return tags.filter((tag) => tag.name.toLowerCase().includes(keyword)).slice(0, 8);
  }, [tags, query]);

  const openSearchDoc = useCallback(async (docId: string) => {
    // 统一走协调器链路（此前裸 getNote + setActiveNote 绕过加载协调器与页签治理）
    setSearchOpen(false);
    setQuery("");
    await openNoteFromTab(docId);
  }, [openNoteFromTab]);

  // 标签文档懒加载（弹层内展开标签时拉一次）
  const tagDocsForSearch = useCallback(async (tagId: string) => {
    const cached = tagDocs[tagId];
    if (cached) return cached;
    try {
      const docs = await api.getNotesWithTag(tagId);
      setTagDocs((cur) => ({ ...cur, [tagId]: docs }));
      return docs;
    } catch {
      return [];
    }
  }, [tagDocs]);

  const childrenMap = useMemo(() => buildChildrenMap(nodes, sortMode), [nodes, sortMode]);

  // 文档计数预计算：避免每次 render 对每个文件夹 O(N) 遍历（大树下显著卡顿）
  const docCountMap = useMemo(() => {
    const counts = new Map<string, number>();
    const byParent = childrenMap;
    const count = (id: string) => {
      const cached = counts.get(id);
      if (cached !== undefined) return cached;
      let total = 0;
      for (const child of byParent.get(id) ?? []) {
        if (child.isDeleted) continue;
        if (child.nodeType !== "folder") total += 1;
        total += count(child.id);
      }
      counts.set(id, total);
      return total;
    };
    for (const node of nodes) {
      if (node.nodeType === "folder") count(node.id);
    }
    return counts;
  }, [nodes, childrenMap]);

  /** 文档 resourceId -> 根层知识库 resourceId（notebook id，URL 外名层用 notebook 实体 id，
   *  不用树节点 id——URL 表达「哪个库」，不表达「树里哪个格子」）。
   *  同时反查：notebook resourceId -> 树节点 id（URL 回灌侧栏聚焦态用）。 */
  const docRootMap = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const map = new Map<string, string>();
    const kbNodeByResourceId = new Map<string, string>();
    for (const node of nodes) {
      if (node.isDeleted || node.nodeType === "folder") continue;
      let cursor: KnowledgeTreeNode | undefined = node;
      while (cursor?.parentId) cursor = byId.get(cursor.parentId);
      if (!cursor) continue;
      map.set(node.resourceId, cursor.resourceId);
      if (cursor.resourceType === "notebook") kbNodeByResourceId.set(cursor.resourceId, cursor.id);
    }
    return { docRoot: map, kbNodeByResourceId };
  }, [nodes]);

  // 深链规范化（对齐语雀：文档 URL 始终携带知识库层级）：裸 /notes/:n 入口
  // （刷新/外链/登录回跳——本次加载未发生应用内前进导航）且文档归属库已知时，
  // replace 成 /kb/:k/notes/:n。popstate 回退与退出库写入的裸路径发生在导航之后
  // （标记已置位），不重写，不破坏后退链。
  useEffect(() => {
    if (loading || hasInAppForwardNavigationOccurred()) return;
    const route = state.route;
    if (route.kind !== "note" || route.kbId) return;
    const root = docRootMap.docRoot.get(route.noteId);
    if (!root) return;
    replaceAppPathState(kbNoteAppPath(getCurrentWorkspace(), root, route.noteId));
  }, [state.route, docRootMap, loading]);

  // 进入态 ⇄ URL：route 是唯一真相，这里只做「读侧回灌」到本地 state。
  // URL 里的 kbId 是 notebook id（resourceId），侧栏聚焦态用树节点 id，经反查转换；
  // 树未加载时不动（等反查就绪），避免把刷新恢复的进入态先清后设。
  // 进入/退出动作一律写 URL（enterKb/exitKb），不直接 setFocusRootId。
  const routeKbId = state.route.kind === "kb"
    ? state.route.kbId
    : state.route.kind === "note" ? state.route.kbId ?? null : null;

  // 进入态兜底：URL 里的库（notebook id）被删除/不存在/无权限时自动退回列表态。
  // 必须等树加载完成（loading=false）再判定——刷新恢复时 nodes 未到，会误判
  // 「库不存在」把刚解析好的 /kb URL 推回知识库根。
  //（依赖 routeKbId，必须放在其声明之后——TDZ。）
  useEffect(() => {
    if (loading || !routeKbId) return;
    if (!nodes.some((n) => n.resourceId === routeKbId && n.resourceType === "notebook" && !n.isDeleted)) {
      const ws = getCurrentWorkspace();
      pushAppPathState(state.activeNote ? kbNoteAppPath(ws, null, state.activeNote.id) : moduleAppPath("notebook", ws) ?? KB_ROOT_APP_PATH);
    }
  }, [nodes, routeKbId, state.activeNote, loading]);
  useEffect(() => {
    if (routeKbId && loading) return;
    setFocusRootId(routeKbId ? docRootMap.kbNodeByResourceId.get(routeKbId) ?? null : null);
  }, [routeKbId, docRootMap, loading]);

  /** 进入知识库：写 URL（/kb/:space/:kbId；当前打开文档属于该库时带 notes 前缀，刷新可完整恢复）。 */
  const enterKb = useCallback((kbNodeId: string) => {
    const kbNode = nodes.find((n) => n.id === kbNodeId);
    const kbIdForUrl = kbNode?.resourceId ?? kbNodeId;
    const ws = getCurrentWorkspace();
    const activeInKb = state.activeNote && docRootMap.docRoot.get(state.activeNote.id) === kbIdForUrl;
    pushAppPathState(
      activeInKb && state.activeNote
        ? kbNoteAppPath(ws, kbIdForUrl, state.activeNote.id)
        : `/kb/${encodeURIComponent(ws)}/${encodeURIComponent(kbIdForUrl)}`,
    );
  }, [nodes, docRootMap, state.activeNote]);

  /** 退出知识库（回库列表）：URL 落回当前文档（空间内形态）或知识库模块根。 */
  const exitKb = useCallback(() => {
    const ws = getCurrentWorkspace();
    pushAppPathState(state.activeNote
      ? kbNoteAppPath(ws, null, state.activeNote.id)
      : moduleAppPath("notebook", ws) ?? KB_ROOT_APP_PATH);
  }, [state.activeNote]);

  // 搜索范围跟随进入态：进入某库时默认库内，退出回到全空间
  useEffect(() => {
    setSearchScope(focusRootId ? "kb" : "all");
  }, [focusRootId]);

  const rows = useMemo(
    () => buildRows(nodes, expanded, query, scope, focusRootId),
    [nodes, expanded, query, scope, focusRootId],
  );

  // 知识库列表态数据：根层知识库节点（resourceType=notebook），行尾为库内文档数
  const kbRoots = useMemo(() => {
    const roots = childrenMap.get(null) ?? [];
    return roots.filter((n) => !n.isDeleted);
  }, [childrenMap]);

  // 搜索结果范围过滤：进入知识库后默认只显示该库命中的文档（弹层胶囊可切全空间）。
  // docRoot 存的是根库 resourceId，聚焦态是节点 id——用聚焦根的 resourceId 对齐。
  const focusRootResourceId = useMemo(
    () => (focusRootId ? nodes.find((n) => n.id === focusRootId)?.resourceId ?? null : null),
    [nodes, focusRootId],
  );
  const visibleSearchDocs = useMemo(() => {
    if (searchScope !== "kb" || !focusRootResourceId) return searchDocs;
    return searchDocs.filter((doc) => docRootMap.docRoot.get(doc.id) === focusRootResourceId);
  }, [searchDocs, searchScope, focusRootResourceId, docRootMap]);

  const searching = query.trim().length > 0;
  const docCount = useMemo(
    () => nodes.filter((node) => !node.isDeleted && node.nodeType !== "folder").length,
    [nodes],
  );

  const toggleNode = useCallback((node: KnowledgeTreeNode, force?: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      const shouldExpand = force ?? !next.has(node.id);
      if (shouldExpand) next.add(node.id);
      else next.delete(node.id);
      return next;
    });
    if (!node.sharedRootId) {
      const willExpand = force ?? !expanded.has(node.id);
      void knowledgeTreeApi.update(node.id, { isExpanded: willExpand }).catch(() => undefined);
    }
  }, [expanded]);

  const toggleTag = useCallback((tagId: string) => {
    setTagsExpanded((current) => {
      const next = new Set(current);
      if (next.has(tagId)) {
        next.delete(tagId);
        // 折叠：URL 退出标签态，回常规路径
        pushAppPathState(state.activeNote ? `/notes/${encodeURIComponent(state.activeNote.id)}` : "/");
      } else {
        next.add(tagId);
        // 展开：URL 跟随（/tags/:tagId），刷新/直开可恢复该标签展开
        pushAppPathState(`/tags/${encodeURIComponent(tagId)}`);
      }
      return next;
    });
  }, [state.activeNote]);

  // 标签回灌：route.kind==="tag" 时确保该标签展开（URL 直达 / 刷新恢复）
  useEffect(() => {
    if (state.route.kind !== "tag") return;
    const tagId = state.route.tagId;
    setTagsExpanded((current) => (current.has(tagId) ? current : new Set(current).add(tagId)));
  }, [state.route]);

  /** "折叠全部文件夹"按钮：专注模式下只碰专注子树内的文件夹（brief 4.5） */
  const toggleAllFolders = useCallback(() => {
    const inFocus = (node: KnowledgeTreeNode) => {
      if (!focusRootId) return true;
      // 专注根自身 + 其子树内
      return node.id === focusRootId || isDescendant(node.id, focusRootId, childrenMap);
    };
    // 全部文件夹含 lv1 根层知识库：收起=全收，展开=全开（专注根保持展开）
    const folderIds = nodes
      .filter(
        (node) =>
          !node.isDeleted &&
          node.nodeType === "folder" &&
          inFocus(node) &&
          (!focusRootId || node.id !== focusRootId),
      )
      .map((node) => node.id);
    const anyExpanded = folderIds.some((id) => expanded.has(id));
    setExpanded((current) => {
      const next = new Set(current);
      for (const id of folderIds) {
        if (anyExpanded) next.delete(id);
        else next.add(id);
      }
      if (focusRootId) next.add(focusRootId);
      return next;
    });
  }, [nodes, expanded, focusRootId, childrenMap]);

  const toggleAllTagDocs = useCallback(() => {
    const anyExpanded = tags.some((tag) => tagsExpanded.has(tag.id));
    setTagsExpanded(() => {
      const next: ExpandedSet = new Set();
      if (!anyExpanded) {
        for (const tag of tags) next.add(tag.id);
      }
      return next;
    });
  }, [tags, tagsExpanded]);

  function isDescendant(nodeId: string, ancestorId: string, children: Map<string | null, KnowledgeTreeNode[]>): boolean {
    const stack = [...(children.get(ancestorId) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur.id === nodeId) return true;
      stack.push(...(children.get(cur.id) ?? []));
    }
    return false;
  }

  /** 单选知识库/文件夹（同步主区筛选） */
  const selectFolder = useCallback((node: KnowledgeTreeNode) => {
    // 只同步主区筛选所需的两个 state（reducer 已幂等），减少全 App 重渲染
    if (node.resourceType === "notebook") actions.setSelectedNotebook(node.resourceId);
    actions.setSelectedKnowledgeTreeParent(node.id);
  }, [actions]);

  const openNode = useCallback(async (node: KnowledgeTreeNode) => {
    if (node.nodeType === "folder") {
      selectFolder(node);
      return;
    }
    // 表格走深链；导图归一后是笔记文档（contentFormat="mindmap"），直接当笔记打开
    if (node.noteType === "sheet") {
      pushSheetAppPath(node.resourceId);
      return;
    }
    // 统一走协调器链路（此前裸 getNote + setActiveNote 绕过加载协调器与页签治理）
    actions.setSelectedKnowledgeTreeParent(node.parentId);
    await openNoteFromTab(node.resourceId);
  }, [actions, openNoteFromTab, selectFolder]);

  /** 统一行点击：ctrl/meta=多选切换，shift=范围选，普通=单选 */
  const handleRowClick = useCallback((event: React.MouseEvent, node: KnowledgeTreeNode) => {
    const renderedIds = Array.from(
      treeRootRef.current?.querySelectorAll<HTMLElement>("[data-next-row]") || [],
    ).map((el) => el.dataset.nextRow || "").filter(Boolean);

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      setSelectedNodeIds((current) => {
        const next = new Set(current);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
      selectionAnchorRef.current = node.id;
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      const anchor = selectionAnchorRef.current;
      if (!anchor) {
        setSelectedNodeIds(new Set([node.id]));
        selectionAnchorRef.current = node.id;
        return;
      }
      const from = renderedIds.indexOf(anchor);
      const to = renderedIds.indexOf(node.id);
      if (from < 0 || to < 0) { setSelectedNodeIds(new Set([node.id])); return; }
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      setSelectedNodeIds(new Set(renderedIds.slice(lo, hi + 1)));
      return;
    }
    // 普通点击：单选
    setSelectedNodeIds(new Set([node.id]));
    selectionAnchorRef.current = node.id;
    if (node.nodeType === "folder") {
      selectFolder(node);
      return;
    }
    void openNode(node);
  }, [selectFolder, openNode]);

  const clearSelection = useCallback(() => {
    setSelectedNodeIds(new Set());
    selectionAnchorRef.current = null;
  }, []);

  // 选中态持久化：刷新后恢复（避免回退到旧版 isActive 视觉）
  useEffect(() => {
    try {
      localStorage.setItem("nowen-next-sidebar-selection", JSON.stringify([...selectedNodeIds]));
    } catch { /* storage failures are non-fatal */ }
  }, [selectedNodeIds]);

  // Esc 清空选中（仅焦点不在输入框/弹窗内时，避免关弹窗误清）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || selectedNodeIds.size === 0) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      // 有浮层/对话框打开时（role=dialog 存在）交给浮层处理 Esc
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      clearSelection();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedNodeIds.size, clearSelection]);


  const activeNoteId = state.activeNote?.id ?? null;
  const openTabs = state.openNoteTabs;

  // ---- 区段折叠/排序 ----
  const toggleSection = useCallback((id: SectionId) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    try { localStorage.setItem(SECTION_ORDER_KEY, sectionOrder.join(",")); } catch { /* ignore */ }
  }, [sectionOrder]);

  // 渲染兜底：顺序数组保证恰好包含全部三个区段（localStorage 脏数据/未来增删区段时不丢面板）
  const safeOrder = useMemo<SectionId[]>(() => {
    const all: SectionId[] = ["kb", "tags", "editors", "star"];
    const valid = sectionOrder.filter((s) => all.includes(s));
    for (const id of all) if (!valid.includes(id)) valid.push(id);
    return valid;
  }, [sectionOrder]);

  // ---- 区段排序（pointer 实现而非 HTML5 DnD：区段头按下拖动，松手时按当前指针位置落位） ----
  // 拖拽视觉反馈：正在拖拽的区段 id（HTML5 DnD）
  const [reorderActive, setReorderActive] = useState<SectionId | null>(null);

  // ---- 区段排序：HTML5 DnD（原生拖影），从区段头空白处启动；button 上按下不启动 ----
  const onSectionDragStart = useCallback((id: SectionId) => (event: React.DragEvent) => {
    if (id === "kb") return;
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
    setReorderActive(id);
  }, []);

  const onSectionDragEnd = useCallback(() => {
    setReorderActive(null);
    setSectionDropHint(null);
  }, []);

  // 指示线方向：dropTarget = { id, after }
  const [sectionDropHint, setSectionDropHint] = useState<{ id: SectionId; after: boolean } | null>(null);

  const onSectionDragOver = useCallback((id: SectionId) => (event: React.DragEvent) => {
    if (id === "kb") return;
    // 仅响应区段排序拖拽（dataTransfer 类型区分）
    if (!event.dataTransfer.types.includes("text/plain")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setSectionDropHint({ id, after: event.clientY > rect.top + rect.height / 2 });
  }, []);

  const onSectionDrop = useCallback((id: SectionId) => (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const from = event.dataTransfer.getData("text/plain") as SectionId;
    setReorderActive(null);
    setSectionDropHint(null);
    if (!from || from === id || id === "kb") return;
    // 落点在目标区段下半部 = 插到它后面；上半部 = 插到它前面（拖到文字下方=排到下面）
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    setSectionOrder((current) => {
      if (!current.includes(from)) return current;
      const next = current.filter((s) => s !== from);
      const idx = next.indexOf(id);
      next.splice(after ? idx + 1 : idx, 0, from);
      return next;
    });
  }, []);

  // 拖拽预演：不重排渲染（内容与 DOM 永不消失），只把 drop 意图存进 hint，
  // 由目标板块的"上/下半内阴影高亮"表达落点；松手时 onSectionDrop 一次性提交顺序。
  // （旧 previewOrder 重排渲染会在换位时移除被拖板块 DOM，导致原生拖影中断、面板闪没。）

  // ---- 面板高度（VS Code 式：把手拖拽定高，body 内部滚动；双击把手清除定高） ----
  const [sectionHeights, setSectionHeights] = useState<Partial<Record<SectionId, number>>>(() => {
    try {
      const saved = localStorage.getItem("nowen-next-sidebar-section-heights");
      if (saved) return JSON.parse(saved) as Partial<Record<SectionId, number>>;
    } catch { /* ignore */ }
    return {};
  });

  useEffect(() => {
    try { localStorage.setItem("nowen-next-sidebar-section-heights", JSON.stringify(sectionHeights)); } catch { /* ignore */ }
  }, [sectionHeights]);

  const startSectionResize = useCallback((sectionId: SectionId, e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = sectionHeights[sectionId]
      ?? (e.currentTarget.previousElementSibling?.getBoundingClientRect().height ?? 240);
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.max(96, Math.min(800, startHeight + (moveEvent.clientY - startY)));
      setSectionHeights((cur) => ({ ...cur, [sectionId]: next }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [sectionHeights]);

  // ---- kb 树拖拽 ----
  const onRowDragStart = useCallback((node: KnowledgeTreeNode) => (event: React.DragEvent) => {
    event.dataTransfer.setData("text/node", node.id);
    event.dataTransfer.effectAllowed = "move";
    setDrag({ nodeId: node.id });
  }, []);

  const onRowDragOver = useCallback((node: KnowledgeTreeNode) => (event: React.DragEvent) => {
    if (!drag?.nodeId) return;
    if (drag.nodeId === node.id) return;
    // 禁止移入自身子树
    if (isDescendant(node.id, drag.nodeId, childrenMap)) return;
    // 不可见行（搜索未命中）不作为目标 —— rows 里没有就跳过
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    const isFolder = node.nodeType === "folder";
    // 边缘命中区 35%：判定更容易（brief 4.7 是 30%，实际操作太苛刻）
    const position: "before" | "after" | "into" =
      !isFolder
        ? ratio < 0.5 ? "before" : "after"
        : ratio < 0.35 ? "before" : ratio > 0.65 ? "after" : "into";
    setDropTarget({ nodeId: node.id, position });
  }, [drag, childrenMap]);

  const onRowDrop = useCallback((target: KnowledgeTreeNode) => (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const sourceId = drag?.nodeId;
    const info = dropTarget;
    setDrag(null);
    setDropTarget(null);
    if (!sourceId || !info || info.nodeId !== target.id) return;
    const source = nodes.find((n) => n.id === sourceId);
    if (!source) return;

    void (async () => {
      try {
        if (info.position === "into") {
          // 移入文件夹
          await knowledgeTreeApi.move(sourceId, { parentId: target.id });
          // 折叠文件夹自动展开
          setExpanded((cur) => new Set(cur).add(target.id));
        } else {
          // 前/后插入：parentId 与目标一致
          await knowledgeTreeApi.move(sourceId, { parentId: target.parentId });
        }
        window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
      } catch (error) {
        console.error("[SidebarDesktop] drop move failed:", error);
      }
    })();
  }, [drag, dropTarget, nodes, childrenMap]);

  // ---- 行级菜单动作 ----
  const startCreateFolder = useCallback(async (parentId: string | null) => {
    try {
      const created = await knowledgeTreeApi.create({ parentId, nodeType: "folder", title: "新建文件夹" });
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
      if (parentId) {
        // 父折叠则展开
        const parent = nodes.find((n) => n.id === parentId);
        if (parent) setExpanded((cur) => new Set(cur).add(parentId));
      }
      setRenaming({ kind: "kb", id: created.id, value: created.title });
    } catch (error) {
      console.error("[SidebarDesktop] create folder failed:", error);
    }
  }, [nodes]);

  const startCreateNote = useCallback(async (parentId: string | null) => {
    try {
      const created = await knowledgeTreeApi.create({ parentId, nodeType: "note", title: "新建文档" });
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
      if (parentId) setExpanded((cur) => new Set(cur).add(parentId));
      setRenaming({ kind: "kb", id: created.id, value: created.title });
    } catch (error) {
      console.error("[SidebarDesktop] create note failed:", error);
    }
  }, []);

  const commitRename = useCallback(async () => {
    if (!renaming) return;
    const { kind, id, value } = renaming;
    const trimmed = value.trim();
    setRenaming(null);
    if (!trimmed) return;
    try {
      if (kind === "kb") {
        await knowledgeTreeApi.update(id, { title: trimmed });
        window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
      } else {
        await api.updateTag(id, { name: trimmed });
        void reloadTags();
      }
    } catch (error) {
      console.error("[SidebarDesktop] rename failed:", error);
    }
  }, [renaming, reloadTags]);

  const deleteNode = useCallback(async (nodeId: string) => {
    try {
      await knowledgeTreeApi.remove(nodeId, "subtree");
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
      if (focusRootId === nodeId) exitKb();
    } catch (error) {
      console.error("[SidebarDesktop] delete node failed:", error);
    }
  }, [focusRootId]);

  const deleteTag = useCallback(async (tagId: string) => {
    try {
      await api.deleteTag(tagId);
      void reloadTags();
    } catch (error) {
      console.error("[SidebarDesktop] delete tag failed:", error);
    }
  }, [reloadTags]);

  const togglePin = useCallback(async (node: KnowledgeTreeNode) => {
    // 真实置顶排序归数据层；本批次只做标记切换（brief 4.6）
    try {
      const nextPin = node.isPinned ? 0 : 1;
      await api.updateNote(node.resourceId, { isPinned: nextPin } as never);
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
    } catch (error) {
      console.error("[SidebarDesktop] toggle pin failed:", error);
    }
  }, []);

  /** 标签文档"定位"：退专注 → 展开祖先 → 滚动 + 高亮闪烁 1.6s */
  const locateDoc = useCallback(async (title: string) => {
    const hit = nodes.find((n) => !n.isDeleted && n.nodeType !== "folder" && n.title === title);
    if (!hit) { setRowMenu(null); return; }
    if (focusRootId && !isDescendant(hit.id, focusRootId, childrenMap) && hit.id !== focusRootId) {
      exitKb();
    }
    // 展开全部祖先
    setExpanded((current) => {
      const next = new Set(current);
      const chain: string[] = [];
      let cursor: KnowledgeTreeNode | undefined = hit;
      const byId = new Map(nodes.map((n) => [n.id, n]));
      while (cursor?.parentId) {
        chain.push(cursor.parentId);
        cursor = byId.get(cursor.parentId);
      }
      for (const id of chain) next.add(id);
      return next;
    });
    // 等渲染后滚动 + 闪烁
    requestAnimationFrame(() => {
      const el = treeRootRef.current?.querySelector(`[data-next-row="${hit.id}"]`);
      el?.scrollIntoView({ block: "center" });
      setFlashId(hit.id);
      setTimeout(() => setFlashId(null), 1600);
    });
    setRowMenu(null);
  }, [nodes, focusRootId, childrenMap]);

  // ---- 菜单渲染位置修正（底部越界上翻） ----
  const menuStyle = useMemo(() => {
    if (!rowMenu) return {};
    const menuH = 160; // 估算
    const flip = rowMenu.y + menuH > window.innerHeight;
    return {
      left: Math.min(rowMenu.x, window.innerWidth - 190),
      top: flip ? Math.max(8, rowMenu.y - menuH) : rowMenu.y,
    } as React.CSSProperties;
  }, [rowMenu]);

  // ---- 标签树行 ----
  const tagRows = useMemo<TagNodeRow[]>(() => {
    let rows = tags.map((tag) => ({
      tag,
      expanded: tagsExpanded.has(tag.id),
      docs: tagDocs[tag.id] ?? [],
    }));
    // 专注模式：标签只显示属于当前知识库的文档，空标签组隐藏
    if (focusRootResourceId) {
      rows = rows
        .map((row) => ({
          ...row,
          docs: row.docs.filter((doc) => docRootMap.docRoot.get(doc.id) === focusRootResourceId),
        }))
        .filter((row) => row.docs.length > 0);
    }
    return rows;
  }, [tags, tagsExpanded, tagDocs, focusRootResourceId, docRootMap]);

  const focusRoot = focusRootId ? nodes.find((n) => n.id === focusRootId) ?? null : null;

  // ---- 区段渲染顺序 ----
  const sectionMap: Record<SectionId, React.ReactNode> = {
    kb: (
      <section key="kb" className="shrink-0" data-next-section="kb">
        <div className="flex w-full items-center gap-1 px-2 py-1">
          <button
            type="button"
            onClick={() => toggleSection("kb")}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-[12px] font-semibold tracking-wide text-tx-tertiary hover:text-tx-primary"
            aria-expanded={!collapsedSections.has("kb")}
          >
            <ChevronDown size={12} className={cn("shrink-0 transition-transform", collapsedSections.has("kb") && "-rotate-90")} />
            <span className="shrink-0">{t("sidebarNext.knowledgeBase", { defaultValue: "知识库" })}</span>
          </button>
          {!collapsedSections.has("kb") && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  // 有选中知识库（或专注知识库）时在其下创建；否则根级（仅新建知识库）
                  // 仅当用户明确选中了知识库/文件夹（或双击专注）时才在该节点下创建；
                  // 打开文档会顺带设置 selectedKnowledgeTreeParentId，不算数
                  // 选中节点 → 创建目标：文件夹/知识库=其下；文档=其父级；多选取第一个可定位的
                  const selectedNode = [...selectedNodeIds]
                    .map((id) => nodes.find((x) => x.id === id && !x.isDeleted))
                    .find(Boolean);
                  const targetKbId = focusRootId
                    ?? (selectedNode
                      ? selectedNode.nodeType === "folder" ? selectedNode.id : selectedNode.parentId
                      : null);
                  setCreateMenuState({ parentId: targetKbId, anchor: new DOMRect(rect.left, rect.top, rect.width, rect.height) });
                }}
                title={t("sidebarNext.newFolder", { defaultValue: "新建" })}
                className="flex h-[22px] w-[22px] items-center justify-center rounded text-tx-tertiary hover:bg-app-active hover:text-tx-primary"
              >
                <Plus size={13} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setKbMoreOpen({ x: rect.left, y: rect.bottom + 4 });
                }}
                title={t("sidebarNext.more", { defaultValue: "更多操作" })}
                className="flex h-[22px] w-[22px] items-center justify-center rounded text-tx-tertiary hover:bg-app-active hover:text-tx-primary"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
              </button>
            </>
          )}
          <span className="ml-1 rounded-full bg-app-hover px-1.5 text-[10px] tabular-nums text-tx-tertiary">{docCount}</span>
        </div>

        {!collapsedSections.has("kb") && (
          <div className="pb-2 pl-2.5 pr-1">
            {focusRoot && (
              <div className="mx-1 mb-1 flex items-center gap-1 rounded-md bg-accent-primary/15 px-1 py-1">
                <button
                  type="button"
                  onClick={exitKb}
                  title={t("sidebarNext.focusBack", { defaultValue: "返回全部知识库" })}
                  className="flex h-5 w-5 items-center justify-center rounded text-accent-primary hover:bg-app-hover"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
                </button>
                <FaBook size={13} className="shrink-0 text-accent-primary" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-accent-primary">{focusRoot.title}</span>
                <span className="shrink-0 rounded-full bg-app-hover px-1.5 text-[10px] tabular-nums text-tx-tertiary">{docCountMap.get(focusRoot.id) ?? 0}</span>
              </div>
            )}
            {!focusRootId && !searching ? (
              /* 知识库列表态：默认只显示库列表（不再铺开混合树），单击库行进入该库。
                 进入后本区段切换为该库目录树（下方原渲染分支），← 返回见横幅。 */
              <div className="px-0.5 pb-2">
                {kbRoots.length === 0 ? (
                  <p className="px-2 py-2 text-[11px] text-tx-tertiary">
                    {t("sidebarNext.empty", { defaultValue: "暂无内容" })}
                  </p>
                ) : kbRoots.map((kb) => (
                  <div
                    key={kb.id}
                    className="group flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-1 text-xs text-tx-primary hover:bg-app-hover"
                    onClick={() => { enterKb(kb.id); setExpanded((cur) => new Set(cur).add(kb.id)); }}
                    title="点击进入知识库"
                  >
                    <FaBook size={14} className="shrink-0 text-accent-primary" />
                    <span className="min-w-0 flex-1 truncate">{kb.title}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-tx-tertiary group-hover:hidden">{docCountMap.get(kb.id) ?? 0}</span>
                    <ChevronRight size={12} className="hidden shrink-0 text-tx-tertiary group-hover:block" />
                  </div>
                ))}
              </div>
            ) : loading ? (
              <p className="px-2 py-2 text-[11px] text-tx-tertiary">加载中…</p>
            ) : rows.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-tx-tertiary">
                {searching
                  ? t("sidebarNext.noMatch", { defaultValue: "无匹配的文件夹或笔记" })
                  : t("sidebarNext.empty", { defaultValue: "暂无内容" })}
              </p>
            ) : (
              <div
                ref={treeRootRef}
                onDragOver={(e) => { if (drag?.nodeId) { e.preventDefault(); setDropTarget(null); } }}
                onDrop={(e) => {
                  // 空白区 drop：移到根层末尾（dropTarget 为 null 时才生效，行上的 drop 已 stopPropagation? 否——行 drop 会冒泡到这里，用 dropTarget 判定来源）
                  if (!drag?.nodeId || dropTarget) return;
                  e.preventDefault();
                  void (async () => {
                    try {
                      await knowledgeTreeApi.move(drag.nodeId!, { parentId: null });
                      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
                    } catch (err) { console.error("[SidebarDesktop] root drop failed:", err); }
                    setDrag(null);
                  })();
                }}
              >
                {rows.map((row) => {
                  const { node, depth, hasChildren, expanded: isExpanded } = row;
                  const isFolder = node.nodeType === "folder";
                  const isSelected = selectedNodeIds.has(node.id);
                  const isPinned = Boolean(node.isPinned);
                  const isDropInto = dropTarget?.nodeId === node.id && dropTarget.position === "into";
                  const isDropBefore = dropTarget?.nodeId === node.id && dropTarget.position === "before";
                  const isDropAfter = dropTarget?.nodeId === node.id && dropTarget.position === "after";
                  const isDragSource = drag?.nodeId === node.id;
                  const isFlash = flashId === node.id;
                  const isRenaming = renaming?.kind === "kb" && renaming.id === node.id;
                  return (
                    <div
                      key={node.id}
                      draggable={!isRenaming}
                      onDragStart={onRowDragStart(node)}
                      onDragOver={onRowDragOver(node)}
                      onDragLeave={() => setDropTarget((cur) => (cur?.nodeId === node.id ? null : cur))}
                      onDrop={onRowDrop(node)}
                      onDoubleClick={() => {
                        if (depth === 0 && isFolder && !focusRootId) {
                          enterKb(node.id);
                          setExpanded((cur) => new Set(cur).add(node.id));
                        }
                      }}
                      className={cn(
                        "group flex h-8 items-center gap-1 rounded-md pr-1 text-xs transition-colors",
                        isSelected ? "bg-accent-primary/20 font-medium text-tx-primary" : "text-tx-primary hover:bg-app-hover",
                        isDragSource && "opacity-40",
                        isFlash && "animate-pulse bg-accent-primary/25",
                        isDropInto && "bg-accent-primary/20 ring-1 ring-accent-primary",
                      )}
                      style={{
                        paddingLeft: 2 + depth * 16,
                        boxShadow:
                          isDropBefore
                            ? "inset 0 2px 0 var(--color-accent-primary)"
                            : isDropAfter
                              ? "inset 0 -2px 0 var(--color-accent-primary)"
                              : isSelected
                                ? "inset 2px 0 0 var(--color-accent-primary)"
                                : undefined,
                      }}
                      data-next-row={node.id}
                    >
                      <button
                        type="button"
                        onClick={() => hasChildren && toggleNode(node)}
                        aria-label={isExpanded ? "折叠" : "展开"}
                        className={cn(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded text-tx-tertiary hover:text-tx-primary",
                          !hasChildren && "invisible",
                        )}
                      >
                        <ChevronDown size={13} className={cn("transition-transform", !isExpanded && "-rotate-90")} />
                      </button>

                      {isRenaming ? (
                        <input
                          ref={renameInputRef}
                          value={renaming.value}
                          onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
                            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
                          }}
                          onBlur={() => void commitRename()}
                          className="min-w-0 flex-1 rounded border border-accent-primary bg-app-bg px-1 text-xs text-tx-primary outline-none"
                          autoFocus
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={(event) => handleRowClick(event, node)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        >
                          {fileIconFor(node, depth === 0)}
                          <span className="min-w-0 flex-1 truncate">{node.title}</span>
                          {isPinned && <Pin size={11} className="shrink-0 text-tx-tertiary" />}
                          {isFolder && (
                            <span className="shrink-0 text-[11px] tabular-nums text-tx-tertiary">
                              {docCountMap.get(node.id) ?? 0}
                            </span>
                          )}
                        </button>
                      )}

                      {!isRenaming && (
                        <>
                          {!isFolder && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); void togglePin(node); }}
                              title={isPinned ? "取消置顶" : "置顶"}
                              className={cn(
                                "hidden h-5 w-5 items-center justify-center rounded text-tx-tertiary hover:bg-app-hover hover:text-tx-primary group-hover:flex",
                                isPinned && "flex",
                              )}
                            >
                              <Pin size={11} className={cn(isPinned && "text-accent-primary")} />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRowMenu({
                                kind: isFolder ? "kb-folder" : "kb-note",
                                nodeId: node.id,
                                x: e.clientX,
                                y: e.clientY,
                              });
                            }}
                            title={t("sidebarNext.more", { defaultValue: "更多操作" })}
                            className="hidden h-5 w-5 items-center justify-center rounded text-tx-tertiary hover:bg-app-hover hover:text-tx-primary group-hover:flex"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
    ),
    tags: (
      <section key="tags" className="shrink-0" data-next-section="tags">
        <div
          draggable
          onDragStart={onSectionDragStart("tags")}
          onDragEnd={onSectionDragEnd}
          className={cn(
            "flex w-full cursor-grab select-none items-center gap-1 px-2 py-1 active:cursor-grabbing",
            reorderActive === "tags" && "opacity-40",
          )}
        >
          <button
            type="button"
            onClick={() => toggleSection("tags")}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-[12px] font-semibold tracking-wide text-tx-tertiary hover:text-tx-primary"
            aria-expanded={!collapsedSections.has("tags")}
          >
            <ChevronDown size={12} className={cn("shrink-0 transition-transform", collapsedSections.has("tags") && "-rotate-90")} />
            <span className="shrink-0">{t("sidebarNext.tags", { defaultValue: "标签" })}</span>
          </button>
          {!collapsedSections.has("tags") && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setTagsMoreOpen({ x: rect.left, y: rect.bottom + 4 });
                }}
                title={t("sidebarNext.more", { defaultValue: "更多操作" })}
                className="flex h-[22px] w-[22px] items-center justify-center rounded text-tx-tertiary hover:bg-app-active hover:text-tx-primary"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
              </button>
            </>
          )}
          <span className="ml-1 rounded-full bg-app-hover px-1.5 text-[10px] tabular-nums text-tx-tertiary">{tagRows.length}</span>
        </div>

        {!collapsedSections.has("tags") && (
          <div className="pb-2 pl-2.5 pr-1">
            {tagsLoading ? (
              <p className="px-2 py-2 text-[11px] text-tx-tertiary">加载中…</p>
            ) : tagRows.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-tx-tertiary">暂无标签</p>
            ) : (
              tagRows.map(({ tag, expanded: tagOpen, docs }) => {
                const isRenaming = renaming?.kind === "tag" && renaming.id === tag.id;
                return (
                  <React.Fragment key={tag.id}>
                    <div
                      className="group flex h-8 items-center gap-1 rounded-md pr-1 text-xs text-tx-primary hover:bg-app-hover"
                      style={{ paddingLeft: 2 }}
                    >
                      <button
                        type="button"
                        onClick={() => toggleTag(tag.id)}
                        aria-label={tagOpen ? "折叠" : "展开"}
                        className={cn(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded text-tx-tertiary hover:text-tx-primary",
                          docs.length === 0 && "invisible",
                        )}
                      >
                        <ChevronDown size={13} className={cn("transition-transform", !tagOpen && "-rotate-90")} />
                      </button>
                      {isRenaming ? (
                        <input
                          ref={renameInputRef}
                          value={renaming.value}
                          onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
                            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
                          }}
                          onBlur={() => void commitRename()}
                          className="min-w-0 flex-1 rounded border border-accent-primary bg-app-bg px-1 text-xs text-tx-primary outline-none"
                          autoFocus
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => docs.length > 0 && toggleTag(tag.id)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        >
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: tag.color || TAG_DOT_COLORS[0] }}
                          />
                          <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                          <span className="shrink-0 text-[11px] tabular-nums text-tx-tertiary">{tag.noteCount ?? docs.length}</span>
                        </button>
                      )}
                      {!isRenaming && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRowMenu({ kind: "tag-group", tagId: tag.id, x: e.clientX, y: e.clientY });
                          }}
                          title={t("sidebarNext.more", { defaultValue: "更多操作" })}
                          className="hidden h-5 w-5 items-center justify-center rounded text-tx-tertiary hover:bg-app-hover hover:text-tx-primary group-hover:flex"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
                        </button>
                      )}
                    </div>
                    {tagOpen && docs.map((doc) => (
                      <div
                        key={`${tag.id}-${doc.id}`}
                        className="group flex h-8 items-center gap-1 rounded-md pr-1 text-xs text-tx-primary hover:bg-app-hover"
                        style={{ paddingLeft: 18 }}
                      >
                        <span className="w-5 shrink-0" />
                        <button
                          type="button"
                          onClick={() => { void openNoteFromTab(doc.id); }}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        >
                          {doc.contentFormat === "markdown" ? (
                            <FileCode size={15} className="shrink-0 text-emerald-500" />
                          ) : (
                            <FileText size={15} className="shrink-0 text-[var(--color-accent-primary)]" />
                          )}
                          <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRowMenu({ kind: "tag-doc", tagId: tag.id, docId: doc.id, x: e.clientX, y: e.clientY });
                          }}
                          title={t("sidebarNext.more", { defaultValue: "更多操作" })}
                          className="hidden h-5 w-5 items-center justify-center rounded text-tx-tertiary hover:bg-app-hover hover:text-tx-primary group-hover:flex"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
                        </button>
                      </div>
                    ))}
                  </React.Fragment>
                );
              })
            )}
          </div>
        )}
      </section>
    ),
    editors: (
      <section key="editors" className="shrink-0" data-next-section="editors">
        <div
          draggable
          onDragStart={onSectionDragStart("editors")}
          onDragEnd={onSectionDragEnd}
          className={cn(
            "flex w-full cursor-grab select-none items-center gap-1 px-2 py-1 active:cursor-grabbing",
            reorderActive === "editors" && "opacity-40",
          )}
        >
          <button
            type="button"
            onClick={() => toggleSection("editors")}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-[12px] font-semibold tracking-wide text-tx-tertiary hover:text-tx-primary"
            aria-expanded={!collapsedSections.has("editors")}
          >
            <ChevronDown size={12} className={cn("shrink-0 transition-transform", collapsedSections.has("editors") && "-rotate-90")} />
            <span className="shrink-0">{t("sidebarNext.openEditors", { defaultValue: "打开的编辑器" })}</span>
          </button>
          {!collapsedSections.has("editors") && openTabs.length > 0 && (
            <button
              type="button"
              onClick={() => actions.clearNoteTabs()}
              title={t("sidebarNext.closeAll", { defaultValue: "全部关闭" })}
              className="flex h-[22px] w-[22px] items-center justify-center rounded text-tx-tertiary hover:bg-app-active hover:text-tx-primary"
            >
              <XCircle size={13} />
            </button>
          )}
          <span className="ml-1 rounded-full bg-app-hover px-1.5 text-[10px] tabular-nums text-tx-tertiary">{openTabs.length}</span>
        </div>

        {!collapsedSections.has("editors") && (
          <div className="pb-2 pl-2.5 pr-1">
            {openTabs.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-tx-tertiary">没有打开的编辑器</p>
            ) : (
              openTabs.map((tab) => {
                const isActive = tab.id === activeNoteId;
                return (
                  <div
                    key={tab.id}
                    className={cn(
                      "group flex h-8 items-center gap-1.5 rounded-md px-1 text-xs",
                      isActive ? "bg-app-active text-tx-primary" : "text-tx-primary hover:bg-app-hover",
                    )}
                  >
                    {tab.contentFormat === "markdown" ? (
                      <FileCode size={14} className="shrink-0 text-emerald-500" />
                    ) : tab.contentFormat === "board" ? (
                      <PenTool size={14} className="shrink-0 text-teal-500" />
                    ) : (
                      <FileText size={14} className="shrink-0 text-[var(--color-accent-primary)]" />
                    )}
                    <button
                      type="button"
                      onClick={() => void openNoteFromTab(tab.id)}
                      className="min-w-0 flex-1 truncate text-left"
                    >
                      {tab.title}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const closingActive = tab.id === activeNoteId;
                        const nextTab = closingActive ? getNextTabAfterClose(openTabs, tab.id) : null;
                        actions.closeNoteTab(tab.id);
                        if (!closingActive) return;
                        // 关闭激活文档：切到相邻页签（右侧优先），无页签则清空编辑区
                        if (nextTab) {
                          await openNoteFromTab(nextTab.id);
                        } else {
                          actions.setActiveNote(null);
                        }
                      }}
                      title={t("sidebarNext.close", { defaultValue: "关闭" })}
                      className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-tx-tertiary hover:bg-app-hover hover:text-tx-primary group-hover:flex"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </section>
    ),
    star: (
      <section key="star" className="shrink-0" data-next-section="star">
        <div className="flex w-full items-center gap-1 px-2 py-1">
          <button
            type="button"
            onClick={() => toggleSection("star")}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-[12px] font-semibold tracking-wide text-tx-tertiary hover:text-tx-primary"
            aria-expanded={!collapsedSections.has("star")}
          >
            <ChevronDown size={12} className={cn("shrink-0 transition-transform", collapsedSections.has("star") && "-rotate-90")} />
            <span className="shrink-0">收藏</span>
          </button>
          {!collapsedSections.has("star") && (
            <>
              <button
                type="button"
                title={`取消所有收藏（${starDocs.length} 条）`}
                className="flex h-[22px] w-[22px] items-center justify-center rounded text-tx-tertiary hover:bg-app-active hover:text-accent-danger"
                onClick={() => {
                  if (starDocs.length === 0) return;
                  if (!window.confirm(`确定取消全部 ${starDocs.length} 条收藏吗？`)) return;
                  Promise.all(starDocs.map((doc) => api.updateNote(doc.id, { isFavorite: 0 } as never)))
                    .then(() => {
                      reloadStar();
                      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
                    })
                    .catch(() => undefined);
                }}
              >
                <Star size={13} />
              </button>
              <span className="pr-1 text-[11px] tabular-nums text-tx-tertiary">{starDocs.length}</span>
            </>
          )}
        </div>
        {!collapsedSections.has("star") && (
          <div className="pb-1">
            {starDocs.length === 0 ? (
              <p className="px-6 py-1 text-xs text-tx-tertiary">暂无收藏</p>
            ) : starDocs.map((doc) => (
              <div
                key={doc.id}
                className="sbx-row group"
                onClick={() => { void openNoteFromTab(doc.id); }}
              >
                <span className="sbx-ico">{doc.contentFormat === "markdown" ? <FileCode size={14} className="text-emerald-500" /> : <FileText size={14} className="text-accent-primary" />}</span>
                <span className="min-w-0 flex-1">
                  <div className="truncate text-xs text-tx-primary">{doc.title}</div>
                  <div className="sbx-sub">{(state.notebooks ?? []).find((nb) => nb.id === doc.notebookId)?.name ?? ""}</div>
                </span>
                <span className="sbx-acts">
                  <button
                    type="button"
                    title="取消收藏"
                    onClick={(e) => { e.stopPropagation(); api.updateNote(doc.id, { isFavorite: 0 } as never).then(() => reloadStar()).catch(() => undefined); }}
                    className="sbx-btn"
                  >
                    <Star size={12} className="text-amber-400" fill="currentColor" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    ),
  };

  return (
    <aside
      className="relative flex h-full min-w-0 flex-col overflow-hidden border-r border-app-border bg-app-surface text-tx-primary"
      style={{ width: sidebarWidth }}
      data-next-sidebar=""
    >
      {/* ===== 头部：位置 + 搜索 + 筛选（48px，三区通栏线对齐） ===== */}
      <header className="relative flex h-12 shrink-0 items-center gap-1.5 border-b border-app-border px-2.5">
        <div ref={spaceRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setSpaceOpen((v) => !v)}
            aria-expanded={spaceOpen}
            title={t("sidebarNext.switchSpace", { defaultValue: "切换空间" })}
            className="flex h-8 max-w-[104px] items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-tx-primary transition-colors hover:bg-app-hover"
          >
            <Home size={14} className="shrink-0 text-tx-tertiary" />
            <span className="min-w-0 truncate">
              {currentWs && currentWs !== "personal"
                ? workspaces.find((w) => w.id === currentWs)?.name ?? "团队空间"
                : "个人空间"}
            </span>
            <ChevronDown
              size={11}
              className={cn("shrink-0 text-tx-tertiary transition-transform", spaceOpen && "rotate-180")}
            />
          </button>

          {spaceOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-app-border bg-app-elevated p-1 shadow-lg">
              <button
                type="button"
                onClick={() => { switchSpace("personal"); setSpaceOpen(false); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover"
              >
                <Home size={13} className="shrink-0 text-tx-tertiary" />
                <span className="flex-1">个人空间</span>
                {(!currentWs || currentWs === "personal") && <Check size={12} className="text-accent-primary" />}
              </button>
              {workspaces.filter((w) => w.id !== "personal").map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => { switchSpace(w.id); setSpaceOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover"
                >
                  <Users size={13} className="shrink-0 text-tx-tertiary" />
                  <span className="flex-1">{w.name}</span>
                  {currentWs === w.id && <Check size={12} className="text-accent-primary" />}
                </button>
              ))}
              <button
                type="button"
                onClick={() => { setSpaceOpen(false); setJoinOpen(true); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover"
              >
                <Plus size={13} className="shrink-0 text-tx-tertiary" />
                <span className="flex-1">加入空间</span>
              </button>
            </div>
          )}
        </div>

        {/* 搜索：照抄原型 .sb-search（26px 高、透明边框、聚焦实底+accent 边框）；仅知识库视图有语义 */}
        <div
          hidden={sidebarView !== "kb"}
          className={cn(
            "relative flex h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded-md border border-transparent px-2",
            "bg-[rgba(17,24,39,0.05)] hover:bg-[rgba(17,24,39,0.08)] dark:bg-[rgba(255,255,255,0.06)] dark:hover:bg-[rgba(255,255,255,0.09)]",
            "transition-[background-color,border-color] duration-150 focus-within:border-accent-primary focus-within:bg-app-bg dark:focus-within:bg-app-bg",
          )}
        >
          <Search size={12} className="shrink-0 opacity-75" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => { if (query.trim()) setSearchOpen(true); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Esc 优先退专注，其次清空搜索（brief 4.5）
                if (focusRootId) exitKb();
                else setQuery("");
              }
            }}
            placeholder={focusRoot
              ? t("sidebarNext.searchInKb", { defaultValue: `在「${focusRoot.title}」内搜索` })
              : t("sidebarNext.searchPlaceholder", { defaultValue: "搜索" })}
            aria-label={t("sidebarNext.searchLabel", { defaultValue: "搜索知识库" })}
            className="no-focus-ring min-w-0 flex-1 bg-transparent text-xs text-tx-primary outline-none placeholder:text-tx-tertiary"
          />

          {/* 搜索结果弹层：当前空间的标签 + 文档 */}
          {searchOpen && (query.trim() || matchedTags.length > 0) && (
            <div
              ref={searchRef2}
              className="absolute left-1 top-full z-[90] mt-1 max-h-[70vh] w-[calc(100%-8px)] overflow-y-auto rounded-[10px] border border-app-border bg-app-elevated p-1 text-left shadow-[0_8px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
              role="listbox"
            >
              {/* 搜索范围胶囊：进入知识库后默认库内，可切全空间 */}
              {focusRoot && (
                <div className="flex items-center gap-1 px-2 pb-1 pt-1.5">
                  <button
                    type="button"
                    onClick={() => setSearchScope("kb")}
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] transition-colors",
                      searchScope === "kb" ? "bg-accent-primary/15 font-medium text-accent-primary" : "text-tx-tertiary hover:bg-app-hover",
                    )}
                  >
                    库内
                  </button>
                  <button
                    type="button"
                    onClick={() => setSearchScope("all")}
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] transition-colors",
                      searchScope === "all" ? "bg-accent-primary/15 font-medium text-accent-primary" : "text-tx-tertiary hover:bg-app-hover",
                    )}
                  >
                    全空间
                  </button>
                </div>
              )}
              {matchedTags.length === 0 && visibleSearchDocs.length === 0 && (
                <p className="px-2 py-3 text-center text-[11px] text-tx-tertiary">
                  {searchFetching ? "搜索中…" : "无匹配的标签或文档"}
                </p>
              )}

              {matchedTags.length > 0 && (
                <>
                  <p className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-tx-tertiary">标签</p>
                  {matchedTags.map((tag) => {
                    const tagOpen = searchTagOpen === tag.id;
                    const docs = tagDocs[tag.id] ?? [];
                    return (
                      <React.Fragment key={tag.id}>
                        <button
                          type="button"
                          role="option"
                          onClick={() => {
                            if (tagOpen) { setSearchTagOpen(null); return; }
                            setSearchTagOpen(tag.id);
                            void tagDocsForSearch(tag.id);
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-tx-primary hover:bg-app-hover"
                        >
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: tag.color || TAG_DOT_COLORS[0] }}
                          />
                          <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                          <span className="shrink-0 text-[11px] tabular-nums text-tx-tertiary">{tag.noteCount ?? docs.length}</span>
                          <ChevronDown size={11} className={cn("shrink-0 text-tx-tertiary transition-transform", !tagOpen && "-rotate-90")} />
                        </button>
                        {tagOpen && docs.map((doc) => (
                          <button
                            key={doc.id}
                            type="button"
                            role="option"
                            onClick={() => void openSearchDoc(doc.id)}
                            className="flex w-full items-center gap-2 rounded-md py-1.5 pl-6 pr-2 text-left text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                          >
                            {doc.contentFormat === "markdown" ? (
                              <FileCode size={13} className="shrink-0 text-emerald-500" />
                            ) : (
                              <FileText size={13} className="shrink-0 text-[var(--color-accent-primary)]" />
                            )}
                            <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                          </button>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </>
              )}

              {visibleSearchDocs.length > 0 && (
                <>
                  <p className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-tx-tertiary">
                    {focusRoot && searchScope === "kb" ? "文档 · 库内" : "文档"}
                  </p>
                  {visibleSearchDocs.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      role="option"
                      onClick={() => void openSearchDoc(doc.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-tx-primary hover:bg-app-hover"
                    >
                      {doc.contentFormat === "markdown" ? (
                        <FileCode size={13} className="shrink-0 text-emerald-500" />
                      ) : (
                        <FileText size={13} className="shrink-0 text-[var(--color-accent-primary)]" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        <div ref={filterRef} className="relative shrink-0" hidden={sidebarView !== "kb"}>
          <button
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            aria-expanded={filterOpen}
            title={t("sidebarNext.filter", { defaultValue: "筛选" })}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              scope !== "all" ? "bg-accent-primary/15 text-accent-primary" : "text-tx-tertiary hover:bg-app-hover",
            )}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
          </button>

          {filterOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-lg border border-app-border bg-app-elevated p-1 shadow-lg">
              {([
                ["all", "全部"],
                ["folder", "仅文件夹"],
                ["note", "仅笔记"],
              ] as Array<[FilterScope, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => { setScope(value); setFilterOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover"
                >
                  <span className="flex-1">{label}</span>
                  {scope === value && <Check size={12} className="text-accent-primary" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* ===== 三面板容器（kb 固定置顶；其余区段头 HTML5 拖拽排序；折叠在原位收起；面板高度可拖拽） ===== */}
      <div
        ref={panelScrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        onClick={(event) => {
          // 点侧栏空白（非行/按钮/面板头）= 清空选中
          const target = event.target as HTMLElement;
          if (!target.closest("[data-next-row], button, input, .sbx-row, .sbx-view")) clearSelection();
        }}
      >
        {/* 多选浮动工具条：批量删除（知识树内） */}
      {openPluginPanel === null && sidebarView === "kb" && selectedNodeIds.size > 1 && (
        <div className="sticky bottom-0 z-20 mx-2 mb-2 flex items-center gap-2 rounded-lg border border-app-border bg-app-elevated px-2 py-1.5 shadow-md">
          <span className="text-[11px] text-tx-secondary">已选 {selectedNodeIds.size} 项</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => clearSelection()}
            className="rounded px-1.5 py-0.5 text-[11px] text-tx-tertiary hover:bg-app-hover"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              const ids = [...selectedNodeIds];
              void (async () => {
                try {
                  await knowledgeTreeApi.batchRemove(ids);
                  clearSelection();
                  window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
                } catch (error) {
                  console.error("[SidebarDesktop] batch remove failed:", error);
                }
              })();
            }}
            className="rounded px-1.5 py-0.5 text-[11px] text-accent-danger hover:bg-app-hover"
          >
            删除
          </button>
        </div>
      )}

      {/* 内置官方插件的侧栏迷你面板（打开时遮盖知识库，带返回条） */}
        {openPluginPanel && (
          <div className="shrink-0">
            {(() => {
              const def = BUILTIN_PLUGINS.find((p) => p.id === openPluginPanel);
              if (!def || def.embedded || !isBuiltinPluginEnabled(def.id)) return null;
              return (
                <>
                  <div className="mx-2 mb-1 mt-2 flex items-center gap-1 rounded-md bg-accent-primary/10 px-1 py-1">
                    <button
                      type="button"
                      onClick={() => setOpenPluginPanel(null)}
                      title="返回知识库"
                      className="flex h-5 w-5 items-center justify-center rounded text-accent-primary hover:bg-app-hover"
                    >
                      <ChevronDown size={13} className="rotate-90" />
                    </button>
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-accent-primary">{def.sidebarPanel.title}</span>
                  </div>
                  {def.id === "tasks" && <TasksMiniPanel onOpenMain={(view) => { actions.setViewMode(view); }} />}
                  {def.id === "diary" && <DiaryMiniPanel onOpenMain={(view) => { actions.setViewMode(view); }} />}
                  {def.id === "pm" && <PmMiniPanel onOpenMain={(view) => { actions.setViewMode(view); }} />}
                  {def.id === "ai" && (
                    <div className="sbx-view">
                      <div className="px-2 pb-2">
                        <p className="sbx-view-empty">AI 基于知识库回答问题，支持检索引用与上下文来源。</p>
                        <div className="sbx-foot-row">
                          <span className="sbx-foot-tip" />
                          <button type="button" className="sbx-foot-link" onClick={() => actions.setViewMode("ai-chat")}>
                            在主区打开
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}
        {sidebarView === "kb" && !openPluginPanel && safeOrder.map((sectionId) => {
          const collapsed = collapsedSections.has(sectionId);
          const rawHeight = sectionHeights[sectionId];
          // 定高 clamp 到当前可视空间：保证所有区段头都留在视口内，任何面板都不会被挤出屏幕
          const bodyHeight = rawHeight && panelScrollRef.current
            ? Math.max(96, Math.min(rawHeight, panelScrollRef.current.clientHeight - 160))
            : rawHeight;
          // 拖拽视觉：被拖板块整块半透明（=被拿起）；
          // 目标板块按指针在上/下半显示上/下内阴影（=落点预示，阴影随上下移动）
          const isDraggingThis = reorderActive === sectionId;
          const isDropTarget = reorderActive && sectionDropHint?.id === sectionId;
          const shadowClass = isDropTarget
            ? sectionDropHint.after
              ? "shadow-[inset_0_-14px_18px_-12px_rgba(59,130,246,0.55)]"
              : "shadow-[inset_0_14px_18px_-12px_rgba(59,130,246,0.55)]"
            : undefined;
          return (
            <div
              key={sectionId}
              onDragOver={onSectionDragOver(sectionId)}
              onDrop={onSectionDrop(sectionId)}
              className={cn(shadowClass, isDraggingThis && "opacity-40")}
            >
              {/* 区段体：定高时内部滚动（VS Code 式），否则自然高度由外层统一滚动 */}
              <div
                className={cn(
                  !collapsed && bodyHeight ? "overflow-y-auto" : undefined,
                )}
                style={!collapsed && bodyHeight ? { height: bodyHeight } : undefined}
              >
                {sectionMap[sectionId]}
              </div>
              {/* 高度调节把手：展开态才显示 */}
              {!collapsed && (
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  className="group/hr flex h-2.5 cursor-row-resize items-center justify-center border-t border-app-border transition-colors hover:bg-accent-primary/20"
                  title="拖拽调整面板高度"
                  onPointerDown={(e) => startSectionResize(sectionId, e)}
                />
              )}
            </div>
          );
        })}

        {/* ===== 回收站视图 ===== */}
        {sidebarView === "trash" && (
          <div className="sbx-view">
            <div className="sbx-view-head"><span>回收站</span><span className="flex-1" /><span className="sbx-badge">{trashItems.length}</span></div>
            <div
              className="mx-2 mb-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-accent-danger hover:bg-app-hover"
              onClick={() => {
                if (trashItems.length === 0) return;
                api.trash.empty(getCurrentWorkspace()).then(() => reloadTrash()).catch(() => undefined);
              }}
            >
              <Trash2 size={13} />
              清空回收站
            </div>
            <div className="px-1 pb-2">
              {trashItems.length === 0 ? (
                <p className="sbx-view-empty">回收站是空的</p>
              ) : trashItems.map((item) => (
                <div key={item.id} className="sbx-row group">
                  <span className="sbx-ico">{item.resourceType === "notebook" ? <Folder size={14} className="text-amber-500" /> : item.contentFormat === "markdown" ? <FileCode size={14} className="text-emerald-500" /> : <FileText size={14} className="text-accent-primary" />}</span>
                  <span className="min-w-0 flex-1">
                    <div className="truncate text-xs text-tx-primary">{item.title}</div>
                    <div className="sbx-sub">{item.resourceType === "notebook" ? "文件夹" : "文档"} · {item.deletedAt ? item.deletedAt.slice(5, 10) : ""} 删除</div>
                  </span>
                  <span className="sbx-acts">
                    <button
                      type="button"
                      title="恢复"
                      onClick={() => { api.trash.mutate(getCurrentWorkspace(), "restore", [item.id]).then(() => { reloadTrash(); window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed")); }).catch(() => undefined); }}
                      className="sbx-btn"
                    >
                      <RotateCcw size={12} />
                    </button>
                    <button
                      type="button"
                      title="彻底删除"
                      onClick={() => { api.trash.mutate(getCurrentWorkspace(), "permanent", [item.id]).then(() => reloadTrash()).catch(() => undefined); }}
                      className="sbx-btn hover:text-accent-danger"
                    >
                      <X size={12} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ===== 项目管理视图 ===== */}
        {sidebarView === "projects" && (
          <div>
            <div className="sbx-view-head cursor-pointer select-none" onClick={() => togglePanelCollapsed("projects")} title={panelCollapsed.projects ? "展开" : "折叠"}>
              <ChevronDown size={12} className={cn("shrink-0 transition-transform", panelCollapsed.projects && "-rotate-90")} />
              <span>项目管理</span>
            </div>
            {!panelCollapsed.projects && <ProjectsSidePanel onOpenMain={() => actions.setViewMode("projects")} />}
          </div>
        )}

        {/* ===== 分享管理视图 ===== */}
        {sidebarView === "shares" && (
          <div>
            <div className="sbx-view-head cursor-pointer select-none" onClick={() => togglePanelCollapsed("shares")} title={panelCollapsed.shares ? "展开" : "折叠"}>
              <ChevronDown size={12} className={cn("shrink-0 transition-transform", panelCollapsed.shares && "-rotate-90")} />
              <span>分享管理</span>
            </div>
            {!panelCollapsed.shares && <SharesSidePanel onOpenMain={() => actions.setViewMode("shares")} />}
          </div>
        )}

        {/* ===== 文件管理视图 ===== */}
        {sidebarView === "files" && (
          <div className="sbx-view">
            <div className="sbx-view-head">
              <button
                type="button"
                aria-expanded={!panelCollapsed.files}
                title={panelCollapsed.files ? "展开" : "折叠"}
                className="flex items-center gap-1 text-xs text-tx-secondary hover:text-tx-primary"
                onClick={() => togglePanelCollapsed("files")}
              >
                <ChevronDown size={12} className={cn("transition-transform", panelCollapsed.files && "-rotate-90")} />
                <span>文件管理</span>
              </button>
              <span className="flex-1" />
              <button type="button" title="上传文件" onClick={() => setUploadOpen(true)} className="sbx-btn">
                <Upload size={13} />
              </button>
              <span className="sbx-badge">{fileItems.length}</span>
            </div>
            {!panelCollapsed.files && (
            <>
            <div className="sbx-chips">
              {([["all", "全部"], ["image", "图片"], ["other", "其他"]] as Array<[typeof fileCat, string]>).map(([cat, label]) => (
                <span key={cat} className={cn("sbx-chip", fileCat === cat && "on")} onClick={() => setFileCat(cat)}>{label}</span>
              ))}
              <span
                className="sbx-chip"
                title="远程文件（WebDAV / 百度网盘）：在文件管理中打开"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("nowen:files-remote-tab"));
                  actions.setViewMode("files");
                }}
              >
                ☁ 远程
              </span>
            </div>
            <div className="px-1 pb-2">
              {fileItems.filter((f) => fileCat === "all" || f.category === fileCat).length === 0 ? (
                <p className="sbx-view-empty">该类型暂无文件</p>
              ) : fileItems.filter((f) => fileCat === "all" || f.category === fileCat).map((f) => (
                <div key={f.id} className="sbx-row group" onClick={() => window.open(f.url, "_blank")}>
                  <span className="sbx-ico">{f.category === "image" ? <FileText size={14} className="text-accent-primary" /> : <FileText size={14} className="text-tx-tertiary" />}</span>
                  <span className="min-w-0 flex-1">
                    <div className="truncate text-xs text-tx-primary">{f.filename}</div>
                    <div className="sbx-sub">{f.createdAt.slice(0, 10)}</div>
                  </span>
                  <span className="sbx-meta">{f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(f.size / 1024)} KB`}</span>
                </div>
              ))}
            </div>
            </>
            )}
          </div>
        )}

        {/* ===== 插件视图 ===== */}
        {sidebarView === "plugins" && (
          <div className="sbx-view">
            <div className="sbx-view-head"><span>插件</span><span className="flex-1" /><span className="sbx-badge">{BUILTIN_PLUGINS.length}</span></div>
            <div className="sbx-chips">
              {([["installed", "已安装"], ["market", "市场"], ["disabled", "已停用"]] as Array<[typeof plugCat, string]>).map(([cat, label]) => (
                <span key={cat} className={cn("sbx-chip", plugCat === cat && "on")} onClick={() => setPlugCat(cat)}>{label}</span>
              ))}
            </div>
            <div className="px-1 pb-2">
              {plugCat === "installed" && BUILTIN_PLUGINS.map((plug) => {
                const enabled = isBuiltinPluginEnabled(plug.id) && !builtinDisabled.has(plug.id);
                return (
                  <div
                    key={plug.id}
                    className="sbx-row group cursor-pointer items-start"
                    title="查看插件详情"
                    onClick={() => {
                      // VSCode 式：点击插件 → 工作区显示详情页
                      try { localStorage.setItem("nowen-plugins-workspace-selected", plug.id); } catch { /* ignore */ }
                      window.dispatchEvent(new CustomEvent("nowen:plugin-selected", { detail: { id: plug.id } }));
                      if (state.viewMode !== "plugins") actions.setViewMode("plugins");
                    }}
                  >
                    <span className="sbx-ico mt-0.5">{plug.icon === "tasks" ? <ListTodo size={14} className="text-violet-500" /> : plug.icon === "diary" ? <RefreshCw size={14} className="text-amber-500" /> : plug.icon === "ai" ? <Sparkles size={14} className="text-accent-primary" /> : <Link2 size={14} className="text-tx-tertiary" />}</span>
                    <span className="min-w-0 flex-1">
                      <div className="truncate text-xs text-tx-primary">{plug.name}</div>
                      <div className="sbx-sub">{plug.description}</div>
                    </span>
                    <span className="sbx-acts">
                      {enabled && (
                        <button
                          type="button"
                          title="打开面板"
                          onClick={(e) => { e.stopPropagation(); setOpenPluginPanel(plug.id); setSidebarView("kb"); }}
                          className="sbx-btn"
                        >
                          <ChevronDown size={12} className="-rotate-90" />
                        </button>
                      )}
                    </span>
                    <span
                      className={cn("sbx-switch", enabled && "on")}
                      title={enabled ? "停用插件" : "启用插件"}
                      onClick={() => setBuiltinPluginDisabled(plug.id, enabled)}
                    />
                  </div>
                );
              })}
              {(plugCat === "market"
                ? []
                : plugins.filter((p) => plugCat === "installed" ? p.status === "enabled" : p.status !== "enabled")
              ).map((plug) => (
                <div key={plug.id} className="sbx-row group items-start">
                  <span className="sbx-ico mt-0.5"><ListTodo size={14} className="text-violet-500" /></span>
                  <span className="min-w-0 flex-1">
                    <div className="truncate text-xs text-tx-primary">{plug.name}</div>
                    <div className="sbx-sub">v{plug.version} · {plug.status === "enabled" ? "已启用" : "已停用"}{plug.source ? ` · ${plug.source}` : ""}</div>
                    {plug.description && <div className="sbx-sub">{plug.description}</div>}
                  </span>
                  <span
                    className={cn("sbx-switch", plug.status === "enabled" && "on")}
                    title={plug.status === "enabled" ? "停用插件" : "启用插件"}
                    onClick={() => {
                      const action = plug.status === "enabled" ? api.plugins.disable(plug.id) : api.plugins.enable(plug.id);
                      action
                        .then(() => api.plugins.list().then((list) => setPlugins(list)).catch(() => undefined))
                        .catch(() => undefined);
                    }}
                  />
                </div>
              ))}

              {plugCat === "disabled" && plugins.filter((p) => p.status !== "enabled").length === 0 && (
                <p className="sbx-view-empty">没有已停用的插件</p>
              )}
              {plugCat === "market" && (
                <p className="sbx-view-empty">插件市场（后续批次）</p>
              )}
            </div>
            <p className="sbx-view-tip">插件面板不由宿主写死入口：启用后经 contributes.sidebarPanels 注册到侧栏，卸载即移除；数据始终保留。</p>
          </div>
        )}
      </div>

      {/* ===== 调宽把手（批次 C） ===== */}
      <div
        role="separator"
        aria-orientation="vertical"
        className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-accent-primary/40"
        title="拖拽调整侧边栏宽度 / 双击恢复默认"
        onPointerDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startWidth = sidebarWidth;
          const onMove = (moveEvent: PointerEvent) => {
            const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + (moveEvent.clientX - startX)));
            setSidebarWidth(next);
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            try { localStorage.setItem("nowen-next-sidebar-width", String(sidebarWidth)); } catch { /* ignore */ }
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
        onDoubleClick={() => {
          setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
          try { localStorage.setItem("nowen-next-sidebar-width", String(SIDEBAR_DEFAULT_WIDTH)); } catch { /* ignore */ }
        }}
      />

      {/* ===== 知识库 + 新建菜单（复用旧版 KnowledgeTreeCreateDropdown） ===== */}
      {createMenuState && (
        <KnowledgeTreeCreateDropdown
          menu={createMenuState}
          onClose={() => setCreateMenuState(null)}
          onCreate={(parentId, kind) => void handleCreate(parentId, kind)}
          onCreateFromTemplate={() => setCreateMenuState(null)}
          onImport={(parentId, importKind) => void handleImport(parentId, importKind)}
        />
      )}

      {/* 知识树触发的 Yuque 导入面板（与 KnowledgeTreePanel 同款） */}
      {yuqueImportNotebookId !== null && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setYuqueImportNotebookId(null);
          }}
        >
          <div className="w-full max-w-lg max-h-[82vh] overflow-y-auto rounded-xl border border-app-border bg-app-elevated p-5 shadow-2xl">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-tx-primary">从 Yuque 导入</span>
              <button
                type="button"
                onClick={() => setYuqueImportNotebookId(null)}
                className="rounded-md p-1 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                aria-label="close"
              >
                <X size={16} />
              </button>
            </div>
            <YuqueImport defaultNotebookId={yuqueImportNotebookId ?? undefined} />
          </div>
        </div>
      )}

      {/* ===== 知识库 ⋮ 更多菜单（排序/折叠全部/刷新） ===== */}
      {kbMoreOpen && (
        <>
          <div className="fixed inset-0 z-[95]" onPointerDown={() => setKbMoreOpen(null)} />
          <div
            className="fixed z-[100] min-w-[150px] rounded-lg border border-app-border bg-app-elevated p-1 shadow-lg"
            style={{ left: kbMoreOpen.x, top: kbMoreOpen.y }}
            role="menu"
          >
            <div className="px-2 pb-1 pt-1 text-[10px] text-tx-tertiary">排序方式</div>
            {KNOWLEDGE_TREE_SORT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                onClick={() => { applySortMode(option.value); setKbMoreOpen(null); }}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-tx-primary hover:bg-app-hover"
              >
                <span className="flex-1">{option.label}</span>
                {sortMode === option.value && <Check size={12} className="text-accent-primary" />}
              </button>
            ))}
            <div className="my-1 border-t border-app-border" />
            <button
              type="button"
              role="menuitem"
              onClick={() => { toggleAllFolders(); setKbMoreOpen(null); }}
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-tx-primary hover:bg-app-hover"
            >
              {isAnyFolderExpanded(nodes, expanded) ? "折叠全部文件夹" : "展开全部文件夹"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { void reload(); setKbMoreOpen(null); }}
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-tx-primary hover:bg-app-hover"
            >
              刷新
            </button>
          </div>
        </>
      )}

      {/* ===== 标签 ⋮ 更多菜单（折叠全部/刷新） ===== */}
      {tagsMoreOpen && (
        <>
          <div className="fixed inset-0 z-[95]" onPointerDown={() => setTagsMoreOpen(null)} />
          <div
            className="fixed z-[100] min-w-[150px] rounded-lg border border-app-border bg-app-elevated p-1 shadow-lg"
            style={{ left: tagsMoreOpen.x, top: tagsMoreOpen.y }}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => { toggleAllTagDocs(); setTagsMoreOpen(null); }}
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-tx-primary hover:bg-app-hover"
            >
              {tags.some((tg) => tagsExpanded.has(tg.id)) ? "折叠全部标签文档" : "展开全部标签文档"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { void reloadTags(); setTagsMoreOpen(null); }}
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-tx-primary hover:bg-app-hover"
            >
              刷新
            </button>
          </div>
        </>
      )}

      {/* ===== 加入空间对话框 ===== */}
      {joinOpen && (
        <JoinWorkspaceDialog
          onClose={() => setJoinOpen(false)}
          onJoined={() => {
            setJoinOpen(false);
            api.getWorkspaces().then((list) => setWorkspaces(list)).catch(() => undefined);
          }}
        />
      )}

      {/* ===== 文件上传对话框 ===== */}
      {uploadOpen && (
        <FileUploadDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => { setUploadOpen(false); reloadFiles(); }}
        />
      )}

      {/* ===== 行级 ⋮ 菜单（fixed 挂 body 语义，此处挂 aside 根部 fixed 等价） ===== */}
      {rowMenu && (
        <div
          ref={menuRef}
          className="fixed z-[100] min-w-[140px] rounded-lg border border-app-border bg-app-elevated p-1 shadow-lg"
          style={menuStyle}
          role="menu"
        >
          {rowMenu.kind === "sec-kb" && (
            <>
              <button type="button" role="menuitem" onClick={() => { setRowMenu(null); expandAllFolders(); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover">全部展开</button>
              <button type="button" role="menuitem" onClick={() => { setRowMenu(null); collapseAllFolders(); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover">全部折叠</button>
            </>
          )}
          {rowMenu.kind === "kb-folder" && (() => {
            const node = nodes.find((n) => n.id === rowMenu.nodeId);
            if (!node) return null;
            return (
              <>
                <button type="button" role="menuitem" onClick={() => { setRowMenu(null); void startCreateNote(node.id); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover">新建文档</button>
                <button type="button" role="menuitem" onClick={() => { setRowMenu(null); void startCreateFolder(node.id); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover">新建子文件夹</button>
                <button type="button" role="menuitem" onClick={() => { setRowMenu(null); setRenaming({ kind: "kb", id: node.id, value: node.title }); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover">重命名</button>
                <button type="button" role="menuitem" onClick={() => { setRowMenu(null); void deleteNode(node.id); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-red-600 hover:bg-app-hover dark:text-red-400">删除</button>
              </>
            );
          })()}
          {rowMenu.kind === "kb-note" && (() => {
            const node = nodes.find((n) => n.id === rowMenu.nodeId);
            if (!node) return null;
            const pinned = Boolean(node.isPinned);
            return (
              <>
                <button type="button" role="menuitem" onClick={() => { setRowMenu(null); void togglePin(node); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover">{pinned ? "取消置顶" : "置顶"}</button>
                <button type="button" role="menuitem" onClick={() => { setRowMenu(null); setRenaming({ kind: "kb", id: node.id, value: node.title }); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover">重命名</button>
                <button type="button" role="menuitem" onClick={() => { setRowMenu(null); void deleteNode(node.id); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-red-600 hover:bg-app-hover dark:text-red-400">删除</button>
              </>
            );
          })()}
          {rowMenu.kind === "tag-group" && (() => {
            const tag = tags.find((tg) => tg.id === rowMenu.tagId);
            if (!tag) return null;
            return (
              <>
                <button type="button" role="menuitem" onClick={() => { setRowMenu(null); setRenaming({ kind: "tag", id: tag.id, value: tag.name }); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover">重命名</button>
                <button type="button" role="menuitem" onClick={() => { setRowMenu(null); void deleteTag(tag.id); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-red-600 hover:bg-app-hover dark:text-red-400">删除</button>
              </>
            );
          })()}
          {rowMenu.kind === "tag-doc" && (() => {
            const doc = (tagDocs[rowMenu.tagId ?? ""] ?? []).find((d) => d.id === rowMenu.docId);
            if (!doc) return null;
            return (
              <>
                <button type="button" role="menuitem" onClick={() => void locateDoc(doc.title)} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover">定位</button>
                <button type="button" role="menuitem" onClick={() => { setRowMenu(null); setRenaming({ kind: "kb", id: doc.id, value: doc.title }); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover">重命名</button>
                <button type="button" role="menuitem" onClick={() => { setRowMenu(null); void deleteNode(doc.id); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-red-600 hover:bg-app-hover dark:text-red-400">删除</button>
              </>
            );
          })()}
        </div>
      )}
    </aside>
  );

  function expandAllFolders() {
    setExpanded((current) => {
      const next = new Set(current);
      for (const node of nodes) {
        if (!node.isDeleted && node.nodeType === "folder") next.add(node.id);
      }
      return next;
    });
  }

  function collapseAllFolders() {
    setExpanded((current) => {
      const next = new Set(current);
      for (const node of nodes) {
        if (!node.isDeleted && node.nodeType === "folder" && node.parentId !== null) next.delete(node.id);
      }
      // 专注根保持展开
      if (focusRootId) next.add(focusRootId);
      return next;
    });
  }
}

/** 侧栏开关：保留导出兼容既有引用（当前无调用方）。 */
export const NEXT_SIDEBAR_ENABLED_KEY = "nowen-next-sidebar-enabled";

export function isNextSidebarEnabled(): boolean {
  try {
    return localStorage.getItem(NEXT_SIDEBAR_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}


/** 项目管理侧栏面板（官方插件 pm · 视觉重设计）：项目选择 + 状态分组导航 + 工单速览快改 */
function ProjectsSidePanel(props: { onOpenMain: () => void }) {
  const { onOpenMain } = props;
  const [projects, setProjects] = useState<PmProject[]>([]);
  const [activeId, setActiveId] = useState("");
  const [items, setItems] = useState<PmWorkItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<PmWorkItemStatus>>(() => new Set(["done"]));

  const loadCounts = useCallback(async (list: PmProject[]) => {
    const entries = await Promise.all(
      list.map((p) =>
        api
          .listPmWorkItems(p.id)
          .then((r) => [p.id, r.items.filter((i) => i.status !== "done" && i.status !== "canceled").length] as const)
          .catch(() => [p.id, 0] as const),
      ),
    );
    setCounts(Object.fromEntries(entries));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listPmProjects();
      setProjects(res.projects);
      setActiveId((prev) => (prev && res.projects.some((p) => p.id === prev) ? prev : res.projects[0]?.id || ""));
      void loadCounts(res.projects);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, [loadCounts]);

  useEffect(() => { void reload(); }, [reload]);

  const loadItems = useCallback(async (projectId: string) => {
    if (!projectId) { setItems([]); return; }
    try {
      const res = await api.listPmWorkItems(projectId);
      setItems(res.items);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => { void loadItems(activeId); }, [activeId, loadItems]);

  const quickStatus = useCallback(
    async (id: string, status: PmWorkItemStatus) => {
      await api.updatePmWorkItem(id, { status });
      await loadItems(activeId);
      void loadCounts(projects);
    },
    [activeId, loadItems, loadCounts, projects],
  );

  const activeProject = projects.find((p) => p.id === activeId) || null;
  const byStatus = (st: PmWorkItemStatus) => items.filter((i) => i.status === st);
  const isOverdue = (item: PmWorkItem) =>
    !!item.dueDate && new Date(item.dueDate) < new Date(new Date().toDateString()) && item.status !== "done" && item.status !== "canceled";

  const GROUPS: Array<{ key: PmWorkItemStatus; label: string; tint: string; color: string }> = [
    { key: "todo", label: "待处理", tint: "#FEF3C7", color: "#F59E0B" },
    { key: "doing", label: "进行中", tint: "#DBEAFE", color: "#2563EB" },
    { key: "review", label: "待验证", tint: "#EDE9FE", color: "#8B5CF6" },
    { key: "done", label: "已完成", tint: "#D1FAE5", color: "#10B981" },
  ];
  const GROUP_ICONS: Partial<Record<PmWorkItemStatus, React.ReactNode>> = {
    todo: <Circle size={12} />,
    doing: <Play size={12} />,
    review: <CheckCircle2 size={12} />,
    done: <Check size={12} />,
  };

  const toggleGroup = (key: PmWorkItemStatus) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="sbx-view flex min-h-0 flex-col">
      <div className="sbx-view-head">
        <span>项目管理</span>
        <span className="flex-1" />
        <button type="button" title="刷新" className="sbx-btn" onClick={() => void reload()}>↻</button>
        <button type="button" title="在主区打开" className="sbx-btn" onClick={onOpenMain}>↗</button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="sbx-view-empty">加载中…</p>
        ) : projects.length === 0 ? (
          <p className="sbx-view-empty">还没有项目，去主区新建</p>
        ) : (
          <>
            {/* 项目选择：色块 + 名称 + 未完成计数 + 选中态 */}
            <div className="px-2 pt-2">
              {projects.map((p) => {
                const on = p.id === activeId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setActiveId(p.id)}
                    className={`mb-0.5 flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                      on ? "border-accent-primary/40 bg-accent-primary/10" : "border-transparent hover:bg-app-hover"}`}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: p.color || "#6b7280" }} />
                    <span className={`min-w-0 flex-1 truncate text-[12px] ${on ? "font-semibold text-accent-primary" : "text-tx-primary"}`}>{p.name}</span>
                    <span
                      className={`shrink-0 rounded-full px-1.5 text-[10px] tabular-nums ${
                        on ? "bg-white text-accent-primary" : "bg-app-hover text-tx-tertiary"}`}
                    >
                      {counts[p.id] ?? 0}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 状态分组导航：彩色图标底 + 组名 + 计数右对齐；点击折叠/展开 */}
            {activeProject
              ? GROUPS.map((group) => {
                  const list = byStatus(group.key);
                  const isCollapsed = collapsed.has(group.key);
                  return (
                    <div key={group.key} className="mb-0.5">
                      <button
                        type="button"
                        className={`flex w-full items-center gap-2 px-2.5 py-1 text-left ${isCollapsed ? "" : "text-tx-primary"}`}
                        onClick={() => toggleGroup(group.key)}
                      >
                        <span
                          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md"
                          style={{ backgroundColor: group.tint, color: group.color }}
                        >
                          {GROUP_ICONS[group.key]}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px]">{group.label}</span>
                        <span className={`shrink-0 text-[11px] tabular-nums ${isCollapsed ? "text-tx-tertiary" : "font-semibold text-accent-primary"}`}>{list.length}</span>
                      </button>
                      {!isCollapsed ? (
                        <div className="pb-1">
                          {list.length === 0 ? (
                            <p className="px-3 pb-1 pt-0.5 text-[10px] text-zinc-400">空</p>
                          ) : (
                            list.map((item) => (
                              <div key={item.id} className="sbx-row group flex items-center gap-1.5 rounded-md py-1 pl-4 pr-1.5">
                                <span className="w-[30px] shrink-0 font-mono text-[9.5px] text-zinc-400">#{item.itemNo ?? "—"}</span>
                                <span
                                  className={`min-w-0 flex-1 truncate text-[11px] ${item.status === "done" ? "text-zinc-400 line-through" : ""}`}
                                  title={item.title}
                                >
                                  {item.title}
                                </span>
                                {isOverdue(item) ? <span className="shrink-0 text-[9.5px] text-red-500">逾期</span> : null}
                                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                                  {item.status !== "done" && item.status !== "canceled" ? (
                                    <button
                                      type="button"
                                      title="标记完成"
                                      className="rounded p-0.5 text-emerald-500 hover:bg-app-hover"
                                      onClick={() => void quickStatus(item.id, "done")}
                                    >
                                      <Check size={11} />
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    title="在主区打开"
                                    className="rounded p-0.5 text-zinc-400 hover:bg-app-hover"
                                    onClick={onOpenMain}
                                  >
                                    <ExternalLink size={11} />
                                  </button>
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              : null}
          </>
        )}
      </div>

      {/* 底部动作：新建走主区表单（事件通知），打开看板切换主区 */}
      <div className="border-t border-app-border px-2 py-1.5">
        <button
          type="button"
          className="mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] font-medium text-accent-primary hover:bg-app-hover"
          onClick={() => {
            onOpenMain();
            window.dispatchEvent(new CustomEvent("nowen:pm-new-item"));
          }}
        >
          <Plus size={12} /> 新建工作项
        </button>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] text-tx-secondary hover:bg-app-hover"
          onClick={onOpenMain}
        >
          <ListTodo size={12} /> 在主区打开看板
        </button>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] text-tx-secondary hover:bg-app-hover"
          onClick={() => {
            onOpenMain();
            window.dispatchEvent(new CustomEvent("nowen:pm-new-project"));
          }}
        >
          <Plus size={12} /> 新建项目
        </button>
      </div>
    </div>
  );
}

/** 分享管理侧栏面板（核心模块 shares）：统计速览 + 最近分享链接，点击进主区管理 */
function SharesSidePanel({ onOpenMain }: { onOpenMain: () => void }) {
  const [stats, setStats] = useState<{ total: number; active: number; paused: number } | null>(null);
  const [recent, setRecent] = useState<Array<{ id: string; title: string; isActive: boolean }>>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .getShareManagement({ sort: "updatedAt", order: "desc" })
      .then((r) => {
        setStats({ total: r.stats.total, active: r.stats.active, paused: Math.max(0, r.stats.total - r.stats.active) });
        setRecent(
          (r.items ?? []).slice(0, 8).map((item) => ({
            id: item.id,
            title: item.noteTitle || "未命名笔记",
            isActive: !!item.isActive,
          })),
        );
      })
      .catch(() => {
        setStats(null);
        setRecent([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="sbx-view">
      <div className="sbx-view-head">
        <span>分享管理</span><span className="flex-1" />
        <button type="button" title="刷新" onClick={reload} className="sbx-btn">
          <RefreshCw size={13} />
        </button>
        <span className="sbx-badge">{stats?.total ?? 0}</span>
      </div>
      <div className="px-2 pb-1 grid grid-cols-3 gap-1">
        <div className="rounded-md border border-app-border bg-app-surface px-1.5 py-1 text-center">
          <p className="text-sm font-semibold text-tx-primary">{stats?.total ?? "—"}</p>
          <p className="text-[10px] text-tx-tertiary">全部</p>
        </div>
        <div className="rounded-md border border-app-border bg-app-surface px-1.5 py-1 text-center">
          <p className="text-sm font-semibold text-emerald-500">{stats?.active ?? "—"}</p>
          <p className="text-[10px] text-tx-tertiary">启用</p>
        </div>
        <div className="rounded-md border border-app-border bg-app-surface px-1.5 py-1 text-center">
          <p className="text-sm font-semibold text-amber-500">{stats?.paused ?? "—"}</p>
          <p className="text-[10px] text-tx-tertiary">停用</p>
        </div>
      </div>
      <div className="px-1 pb-2">
        {loading ? (
          <p className="sbx-view-empty">加载中…</p>
        ) : recent.length === 0 ? (
          <p className="sbx-view-empty">还没有分享链接，在笔记里点击「分享」创建</p>
        ) : (
          recent.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={onOpenMain}
              className="sbx-row w-full text-left flex items-center gap-2"
              title="在主区打开分享管理"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  item.isActive ? "bg-emerald-500" : "bg-amber-500",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-[11px]">{item.title}</span>
              <ExternalLink size={11} className="shrink-0 text-tx-tertiary" />
            </button>
          ))
        )}
      </div>
      <div className="sbx-foot-row">
        <span className="sbx-foot-tip" />
        <button type="button" onClick={onOpenMain} className="sbx-foot-link">
          在主区打开
        </button>
      </div>
    </div>
  );
}
