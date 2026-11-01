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
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowUpDown,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  Copy,
  Download,
  FileArchive,
  FileType2,
  FolderInput,
  Image as ImageIcon,
  Printer,
  Share2,
  Ellipsis,
  ExternalLink,
  Columns2,
  FilePlus2,
  FileText,
  Focus,
  Folder,
  Home,
  Link2,
  Locate,
  ListTodo,
  Pencil,
  Play,
  BookOpen,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Trash2,
  Upload,
  KanbanSquare,
  Inbox,
  Users,
  X,
  XCircle,
  Puzzle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useApp, useAppActions } from "@/store/AppContext";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "@/components/ui/menu";
import { SplitView } from "@/components/ui/split-view";
import { confirm } from "@/components/ui/confirm";
import { api, getCurrentWorkspace, setCurrentWorkspace } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  knowledgeTreeApi,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import { descendantNotebookResources } from "@/lib/knowledgeTreeDescendants";
import { knowledgeTreeEmojiFor, docEmojiForFormat } from "@/lib/knowledgeTreeIcons";
import {
  getRetentionDays,
  getTrashSetting,
  getTrashTimeFilter,
  getTrashTypeFilter,
  setTrashSetting,
  setTrashTimeFilter,
  TRASH_TIME_META,

  retentionColor,
  retentionDaysLeft,
  setRetentionDays,
  setTrashTypeFilter as persistTrashTypeFilter,
  TRASH_RETENTION_OPTIONS,
  TRASH_TYPE_META,
  trashTypeEmoji,
  trashTypeKey,
  trashTypeLabel,
  type TrashTimeFilter,
  type TrashTypeFilterKey,
  type TrashTypeKey,
} from "@/features/trash/trashUi";
import {
  exportNoteAsImage,
  exportSingleNote,
  exportSingleNoteAsPDF,
} from "@/lib/exportService";
import {
  NOTEBOOK_EXPORT_FORMAT_ITEMS,
  exportNotebookAsFormat,
  type NotebookExportFormat,
} from "@/lib/notebookFormatExport";
import { KnowledgeTreeBatchMovePanel } from "@/components/KnowledgeTreeBatchActions";
import NotebookShareDialog from "@/components/NotebookShareDialog";
import ShareModal from "@/components/ShareModal";
import type { FileItem, FileSortKey, FileStats, NoteListItem, Notebook, PmProject, PmWorkItem, PmWorkItemStatus, Tag, Workspace } from "@/types";
import { FILE_REMOTE_SORT_OPTIONS, FILE_REMOTE_TYPE_CHIPS, FILE_SHARE_OPTIONS, FILE_SORT_OPTIONS, getFilesCategory, getFilesGroupMode, getFilesRemoteSort, getFilesRemoteTime, getFilesRemoteTypes, getFilesShare, getFilesSort, getFilesSource, getFilesTime, getFilesUiVersion, getFilesViewMode, setFilesUi, subscribeFilesUi, type FilesGroupMode, type FilesRemoteSortKey, type FilesSource, type FilesViewMode } from "@/features/files/filesUi";
import { CreateWorkspaceDialog, JoinWorkspaceDialog } from "@/components/WorkspaceSwitcher";
import MembersPanel from "@/components/MembersPanel";
import { BUILTIN_PLUGINS, getDisabledBuiltinPlugins, isBuiltinPluginEnabled, setBuiltinPluginDisabled, type BuiltinPluginId } from "@/plugins/builtin/registry";
import { TasksMiniPanel, DiaryMiniPanel, PmMiniPanel } from "@/plugins/builtin/MiniPanels";
import { KnowledgeTreeCreateDropdown, type KnowledgeTreeCreateMenuState } from "@/components/KnowledgeTreeCreateMenuRuntime";
import { LiaThumbtackSolid } from "react-icons/lia";
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
import { useSortableDrag } from "@/hooks/useSortableDrag";

/** 侧栏根宽，原型固定 260px（批次 C 做拖宽，范围 200–420）。 */
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 420;

/** 搜索筛选范围（头部漏斗）：限制搜索结果的类型；收藏/标签 = 只在已收藏/已加标签的文档里搜 */
type FilterScope = "all" | "notebook" | "document" | "folder" | "favorite" | "tag";
const FILTER_SCOPE_VALUES: FilterScope[] = ["all", "notebook", "document", "folder", "favorite", "tag"];
/** 搜索结果面板内置的类型筛选（chips） */
const FILTER_SCOPE_OPTIONS: Array<{ value: FilterScope; label: string }> = [
  { value: "all", label: "全部" },
  { value: "notebook", label: "知识库" },
  { value: "document", label: "文档" },
  { value: "folder", label: "文件夹" },
  { value: "favorite", label: "收藏" },
  { value: "tag", label: "标签" },
];

/** 区段顺序（可拖拽排序，持久化到 localStorage）。收藏作为知识库面板的一个区段（功能太少，不设独立面板） */
type SectionId = "kb" | "tags" | "editors" | "star";
const SECTION_ORDER_KEY = "nowen-next-sidebar-sections";
/** 区段排序拖拽专用 dataTransfer 类型：与知识树行拖拽（text/plain）区分，互不误触。 */
const SECTION_DRAG_TYPE = "application/x-nowen-sidebar-section";
/** 区段全集（同时也是缺失区段的补位顺序）。 */
const SECTION_IDS: SectionId[] = ["kb", "tags", "editors", "star"];

/**
 * 区段顺序归一化：过滤脏数据、补齐缺失区段。
 * 归一是必须的——localStorage 里的旧顺序只有三个区段（收藏是后加的），
 * 直接拿它算插入下标会 indexOf("star") === -1，落点被算成 0（跑到最上方）。
 */
function normalizeSectionOrder(order: readonly SectionId[]): SectionId[] {
  const valid = order.filter((id) => SECTION_IDS.includes(id));
  for (const id of SECTION_IDS) if (!valid.includes(id)) valid.push(id);
  return valid;
}

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

/** 根级知识库节点（无父级 + notebook 资源）：只能在根层内重排，不能被拖入其它库/文件夹。 */
function isRootNotebookNode(node: KnowledgeTreeNode): boolean {
  return node.parentId === null && node.resourceType === "notebook";
}

/**
 * 拖拽落点的本地乐观重排：与后端 move 的锚点语义保持一致——
 * 把源节点挂到目标父级下，再把该父级兄弟按 0..n-1 重新编号（无锚点 = 落到末尾）。
 *
 * 为什么要本地先算：松手到 reload 回来之间有一次网络往返，树在这段时间里仍然
 * 按旧顺序渲染（拖拽期间不做预演重排），表现为"松手后先弹回旧位置、稍后再跳到新位置"。
 * 本地按同一套规则先摆好，reload 回来的服务端顺序与之一致，就不会再跳。
 */
function applyOptimisticMove(
  nodes: KnowledgeTreeNode[],
  sourceId: string,
  parentId: string | null,
  anchor: { id: string; position: "before" | "after" } | null,
): KnowledgeTreeNode[] {
  const source = nodes.find((node) => node.id === sourceId);
  if (!source) return nodes;
  const siblings = nodes
    .filter((node) => !node.isDeleted && node.id !== sourceId && (node.parentId ?? null) === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
  const anchorIndex = anchor ? siblings.findIndex((node) => node.id === anchor.id) : -1;
  const insertIndex = anchor && anchorIndex >= 0
    ? (anchor.position === "before" ? anchorIndex : anchorIndex + 1)
    : siblings.length;
  const ordered = [
    ...siblings.slice(0, insertIndex),
    source,
    ...siblings.slice(insertIndex),
  ];
  const nextSort = new Map(ordered.map((node, index) => [node.id, index] as const));
  return nodes.map((node) => {
    const sortOrder = nextSort.get(node.id);
    const nextParentId = node.id === sourceId ? parentId : node.parentId;
    if (sortOrder === undefined) {
      return nextParentId === node.parentId ? node : { ...node, parentId: nextParentId };
    }
    if (sortOrder === node.sortOrder && nextParentId === node.parentId) return node;
    return { ...node, parentId: nextParentId, sortOrder };
  });
}

/**
 * 可见性引擎（brief 4.3）。头部筛选（FilterScope）只作用于搜索弹层，不再生效于树。
 * @param focusRootId 专注模式根节点 id；非空时只遍历该子树。
 */
function buildRows(
  nodes: KnowledgeTreeNode[],
  expanded: ExpandedSet,
  query: string,
  focusRootId: string | null,
): FlatRow[] {
  const children = buildChildrenMap(nodes);
  const keyword = query.trim().toLowerCase();
  const searching = keyword.length > 0;

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
        const subtreeHit = matchesKeyword(node);
        const descendantHit = subtreeHasMatch(node.id, children, keyword);
        if (!subtreeHit && !descendantHit) continue;
        sawVisible = true;
        rows.push({ node, depth, hasChildren, expanded: true, ancestorIds });
        walk(node.id, depth + 1, [...ancestorIds, node.id]);
        continue;
      }

      sawVisible = true;
      rows.push({ node, depth, hasChildren, expanded: isExpanded, ancestorIds });
      if (isExpanded) walk(node.id, depth + 1, [...ancestorIds, node.id]);
    }
  };

  if (focusRootId) {
    const focusRoot = nodes.find((n) => n.id === focusRootId && !n.isDeleted);
    if (focusRoot) {
      // 进入态不重复渲染库根行（顶部横幅已显示库名 + 返回），直接铺开子节点，
      // depth 从 0 起——否则会出现「← 某库」与「⌄ 某库」两行同一个库。
      walk(focusRoot.id, 0, [focusRoot.id]);
    }
  } else {
    walk(null, 0, []);
  }

  void sawVisible;
  return rows;
}

/** 子树内是否存在关键词匹配节点（用于搜索命中路径保留）。 */
function subtreeHasMatch(
  nodeId: string,
  children: Map<string | null, KnowledgeTreeNode[]>,
  keyword: string,
): boolean {
  const k = keyword.trim().toLowerCase();
  const stack = [...(children.get(nodeId) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.isDeleted) continue;
    if (k && cur.title.toLowerCase().includes(k)) return true;
    stack.push(...(children.get(cur.id) ?? []));
  }
  return false;
}

function fileIconFor(node: KnowledgeTreeNode, isRoot = false) {
  // 与总览页共用一套 emoji 图标（见 knowledgeTreeIcons.ts），两处类型视觉一致
  return <span className="shrink-0 text-[13px] leading-none">{knowledgeTreeEmojiFor(node, isRoot)}</span>;
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

/** 面板内可折叠分区：与知识库区段同一折叠交互（箭头 + panelCollapsed 持久化）。 */
function PanelSection({ label, extra, children }: {
  label: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-app-border px-2 py-1.5">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[10.5px] text-tx-tertiary">{label}</span>
        {extra}
      </div>
      {children}
    </div>
  );
}

export default function SidebarDesktop() {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();

  const [nodes, setNodes] = useState<KnowledgeTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<FilterScope>("all");
  // 搜索筛选 scope ⇄ URL（?scope=all|notebook|document|folder|favorite|tag）：
  // 与 ?q= 同款握手（回灌置标记让写侧让位）。遗留值 note/folder 中 note 已并入 document。
  const applyingRouteScopeRef = useRef(false);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // 回灌只由 route 变化驱动（不得依赖 scope 本身——否则用户改 scope 后会被
  // URL 旧值弹回，形成「切不回全部」的死锁）。
  useEffect(() => {
    const routeScope = state.route.scope;
    const normalized: FilterScope | null =
      routeScope === "note" || routeScope === "document" ? "document"
        : FILTER_SCOPE_VALUES.includes(routeScope as FilterScope) ? (routeScope as FilterScope)
          : null;
    if (!normalized || normalized === scopeRef.current) return;
    applyingRouteScopeRef.current = true;
    setScope(normalized);
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

  // 行级菜单
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  // 行菜单里的“移动 / 分享”入口状态（侧栏内置面板/弹窗，无需离开当前页）。
  const [moveNodeId, setMoveNodeId] = useState<string | null>(null);
  const [shareNote, setShareNote] = useState<{ id: string; title: string } | null>(null);
  const [shareNotebook, setShareNotebook] = useState<Notebook | null>(null);

  // 重命名（行内 input）。isNew = 刚新建、正处于"先建后改名"流程：
  // 这种情况下取消/清空名字要真正把节点删掉，否则"取消"只是个装饰按钮。
  const [renaming, setRenaming] = useState<{ kind: "kb" | "tag"; id: string; value: string; isNew?: boolean } | null>(null);

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
  // 文件管理面板的来源/筛选状态（filesUi）：订阅保证侧栏 chips 即时反映选择
  const filesUiVersion = useSyncExternalStore(subscribeFilesUi, getFilesUiVersion);
  void filesUiVersion;
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
      // 旧数据只有三个区段（收藏是后加的），补齐交给归一化，不要在这里写死排列。
      if (saved) return normalizeSectionOrder(saved.split(",") as SectionId[]);
    } catch { /* ignore */ }
    return ["kb", "tags", "editors", "star"];
  });

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
  // 侧栏回收站类型筛选（与主区 TrashPage 同语义：按 resourceType）
  const [trashFilter, setTrashFilterState] = useState<TrashTypeFilterKey[]>(() => getTrashTypeFilter());
  const [retentionDays, setRetentionDaysState] = useState(() => getRetentionDays());
  const [timeFilter, setTimeFilterState] = useState<TrashTimeFilter>(() => getTrashTimeFilter());
  const [notifyExpiry, setNotifyExpiryState] = useState(() => getTrashSetting("notifyExpiry"));
  const [weeklySummary, setWeeklySummaryState] = useState(() => getTrashSetting("weeklySummary"));
  const setTrashTypeFilter = useCallback((keys: TrashTypeFilterKey[]) => { setTrashFilterState(keys); persistTrashTypeFilter(keys); }, []);
  // 回收站视图激活时，恢复/删除/清空等操作后即时刷新计数与类型分布
  useEffect(() => {
    if (sidebarView !== "trash") return;
    const reload = () => { api.trash.list(getCurrentWorkspace()).then((r) => setTrashItems(r.items)).catch(() => undefined); };
    window.addEventListener("nowen:storage-changed", reload);
    window.addEventListener("nowen:knowledge-tree-changed", reload);
    window.addEventListener("nowen:notes-changed", reload);
    return () => {
      window.removeEventListener("nowen:storage-changed", reload);
      window.removeEventListener("nowen:knowledge-tree-changed", reload);
      window.removeEventListener("nowen:notes-changed", reload);
    };
  }, [sidebarView]);
  // 文件管理视图激活时：上传/删除/清理后即时刷新计数（stats + 文件列表）
  useEffect(() => {
    if (sidebarView !== "files") return;
    const reload = () => {
      api.files.stats().then((s) => setFileStats(s)).catch(() => undefined);
      api.files.list({ pageSize: 100 }).then((r) => setFileItems(r.items)).catch(() => undefined);
    };
    window.addEventListener("nowen:storage-changed", reload);
    window.addEventListener("nowen:knowledge-tree-changed", reload);
    window.addEventListener("nowen:notes-changed", reload);
    return () => {
      window.removeEventListener("nowen:storage-changed", reload);
      window.removeEventListener("nowen:knowledge-tree-changed", reload);
      window.removeEventListener("nowen:notes-changed", reload);
    };
  }, [sidebarView]);
  useEffect(() => {
    const onFilter = () => { setTrashFilterState(getTrashTypeFilter()); setTimeFilterState(getTrashTimeFilter()); }
    const onSettings = () => { setRetentionDaysState(getRetentionDays()); setNotifyExpiryState(getTrashSetting("notifyExpiry")); setWeeklySummaryState(getTrashSetting("weeklySummary")); };
    window.addEventListener("nowen:trash-filter", onFilter);
    window.addEventListener("nowen:trash-settings", onSettings);
    return () => {
      window.removeEventListener("nowen:trash-filter", onFilter);
      window.removeEventListener("nowen:trash-settings", onSettings);
    };
  }, []);
  const [fileItems, setFileItems] = useState<FileItem[]>([]);
  const [fileStats, setFileStats] = useState<FileStats | null>(null);
  const [remoteSources, setRemoteSources] = useState<Array<{ id: string; name: string; type: string }>>([]);
  // 插件列表（后端 GET /plugins）
  const [plugCat, setPlugCat] = useState<"installed" | "market" | "disabled">("installed");
  const [plugins, setPlugins] = useState<Array<{ id: string; name: string; description?: string; version: string; status: string; source?: string }>>([]);
  const [joinOpen, setJoinOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
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
      api.files.stats().then((s) => setFileStats(s)).catch(() => setFileStats(null));
      api.getRemoteFileSources().then((r) => setRemoteSources(r.sources.map((src) => ({ id: src.id, name: src.name, type: src.type })))).catch(() => setRemoteSources([]));
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

  // 收藏区段数据：收藏已并入知识库面板区段（不再是独立视图），挂载与笔记变更时刷新
  const reloadStar = useCallback(() => {
    api.getNotes({ isFavorite: "1" }).then((items) => setStarDocs(items)).catch(() => undefined);
  }, []);
  useEffect(() => {
    reloadStar();
    const onKbChanged = () => reloadStar();
    // nowen:notes-changed = api.updateNote 在收藏状态变化时广播（菜单/编辑器/列表都能触发）
    const onNotesChanged = () => reloadStar();
    window.addEventListener("nowen:knowledge-tree-changed", onKbChanged);
    window.addEventListener("nowen:notes-changed", onNotesChanged);
    return () => {
      window.removeEventListener("nowen:knowledge-tree-changed", onKbChanged);
      window.removeEventListener("nowen:notes-changed", onNotesChanged);
    };
  }, [reloadStar]);

  useEffect(() => {
    const onChanged = () => setBuiltinDisabled(getDisabledBuiltinPlugins());
    window.addEventListener("nowen:builtin-plugins-changed", onChanged);
    return () => window.removeEventListener("nowen:builtin-plugins-changed", onChanged);
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
      // 根级新建的 folder 即知识库（新建菜单根级只有「新建知识库」一项），默认名不能是「新建文件夹」
      const title = kind === "folder" && parentId === null ? "新建知识库" : titles[kind];
      const created = await knowledgeTreeApi.create({ parentId, nodeType: kind, title });
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
      if (parentId) setExpanded((cur) => new Set(cur).add(parentId));
      // 创建后进入重命名（选中原标题，直接输入新名字），与行内新建体验一致。
      // isNew 标记让"取消/清空名字"能真正撤销这次创建。
      setRenaming({ kind: "kb", id: created.id, value: created.title, isNew: true });
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
  const searchRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchPopupRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const treeRootRef = useRef<HTMLDivElement>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);

  // ---- 数据加载 ----
  // 并发 reload 的序号：只认最新一次请求的结果，避免早发出的旧响应后到、
  // 把刚拖好的顺序又盖回旧顺序（拖拽后多路 nowen:knowledge-tree-changed 会同时触发 reload）。
  const reloadSeqRef = useRef(0);
  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    try {
      const response = await knowledgeTreeApi.list();
      if (seq !== reloadSeqRef.current) return;
      setNodes(Array.isArray(response?.nodes) ? response.nodes : []);
    } catch (error) {
      console.error("[SidebarDesktop] knowledge tree load failed:", error);
    } finally {
      if (seq === reloadSeqRef.current) setLoading(false);
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

  // 树默认全部折叠：不自动展开任何知识库。此前首次加载会把所有根层知识库
  // 一次性展开（v2 的「根层默认展开」），进来就是一大片展开状态，很吵；
  // 现在只在你点开某个库时展开它（单击根行/双击/深链回灌各自即时展开）。

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
    if (!spaceOpen && !rowMenu && !searchOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!spaceRef.current?.contains(target)) setSpaceOpen(false);
      if (!menuRef.current?.contains(target)) setRowMenu(null);
      // 搜索弹层（portal 挂 body）：点弹层与搜索框之外关闭
      if (!searchPopupRef.current?.contains(target) && !searchContainerRef.current?.contains(target)) setSearchOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Esc 优先退专注（brief 4.5），其次关菜单/浮层，最后清空搜索
      if (rowMenu) { setRowMenu(null); return; }
      if (spaceOpen) { setSpaceOpen(false); return; }
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
  }, [spaceOpen, rowMenu, focusRootId, query, renaming, searchOpen]);

  // ---- 重命名 input 自动聚焦 ----
  // 全选只在进入重命名时执行一次：onChange 每次按键都生成新 renaming 对象，
  // 若 effect 依赖整个 renaming，会每次输入都重跑 select()（输入一字即全选被覆盖）。
  const renameSelectKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!renaming) {
      renameSelectKeyRef.current = null;
      return;
    }
    const key = `${renaming.kind}:${renaming.id}`;
    if (renameSelectKeyRef.current === key) return;
    renameSelectKeyRef.current = key;
    requestAnimationFrame(() => renameInputRef.current?.select());
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
    // 在途请求作废标记：快速连续输入时旧响应不能覆盖新结果
    let stale = false;
    const timer = setTimeout(() => {
      api.searchNotes(keyword, 20)
        .then((items) => { if (!stale) setSearchDocs(items as NoteListItem[]); })
        .catch(() => { if (!stale) setSearchDocs([]); })
        .finally(() => { if (!stale) setSearching(false); });
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [query]);

  // ---- 搜索面板 ----
  // 面板以 absolute 悬在头部下方、四边距 6px：宽度天然等于侧栏宽，不会越过侧栏压到编辑区。
  // （之前用 absolute + 定宽/portal 测距，既溢宽又多一层 JS，已移除）

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
    // 根节点自身先登记：空库（无任何文档）也要能回灌聚焦态，否则进入空库时
    // 反查落空 → focusRootId 被清成 null → 界面自动弹回列表（无法在库内新建）。
    for (const node of nodes) {
      if (!node.isDeleted && node.resourceType === "notebook" && node.parentId === null) {
        kbNodeByResourceId.set(node.resourceId, node.id);
      }
    }
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
  // 进入/退出动作一律写 URL（openKbOverview/focusKb/exitKb），不直接 setFocusRootId。
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

  // 库内树空间（聚焦）⇄ URL：?tree=focus 叠加在当前 kb 路径上
  // （/kb/:space/:kbId[/:kbId/notes/:n]?tree=focus）。route 是唯一真相，这里只做
  // 读侧回灌：聚焦目标 = URL 里的 kbId（notebook id → 树节点 id 反查）；
  // 无参数或无 kbId = 全空间单树。树未加载时不动（等反查就绪）。
  const routeTreeFocus = state.route.tree === "focus";
  useEffect(() => {
    if (routeKbId && loading) return;
    if (!routeTreeFocus || !routeKbId) {
      setFocusRootId((cur) => (cur === null ? cur : null));
      return;
    }
    setFocusRootId(docRootMap.kbNodeByResourceId.get(routeKbId) ?? null);
  }, [routeTreeFocus, routeKbId, docRootMap, loading]);

  /** 打开库 Overview：写 URL /kb/:space/:kbId（主区渲染 KbDetailPage，侧栏树不动）。 */
  const openKbOverview = useCallback((kbResourceId: string) => {
    const ws = getCurrentWorkspace();
    const target = `/kb/${encodeURIComponent(ws)}/${encodeURIComponent(kbResourceId)}`;
    if (resolveCurrentAppPathname() === target) return;
    pushAppPathState(target);
  }, []);

  /** 聚焦知识库（库内树空间）：该库 Overview 路径叠加 ?tree=focus，侧栏只渲染该库子树。 */
  const focusKb = useCallback((kbResourceId: string) => {
    const ws = getCurrentWorkspace();
    const params = new URLSearchParams(window.location.search);
    params.set("tree", "focus");
    pushAppPathState(`/kb/${encodeURIComponent(ws)}/${encodeURIComponent(kbResourceId)}?${params.toString()}`);
  }, []);

  /** 退出库内树空间（回全空间单树）：剥离 ?tree=focus，路径与主区保持不变。 */
  const exitKb = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("tree")) return;
    params.delete("tree");
    const qs = params.toString();
    pushAppPathState(`${resolveCurrentAppPathname()}${qs ? `?${qs}` : ""}`);
  }, []);

  // 搜索范围跟随进入态：进入某库时默认库内，退出回到全空间
  useEffect(() => {
    setSearchScope(focusRootId ? "kb" : "all");
  }, [focusRootId]);

  const rows = useMemo(
    // 头部筛选（scope）只作用于搜索弹层，知识树始终展示全部节点类型
    () => buildRows(nodes, expanded, query, focusRootId),
    [nodes, expanded, query, focusRootId],
  );

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

  // 收藏区段跟随聚焦范围：聚焦某个库时只保留该库内的收藏
  const visibleStarDocs = useMemo(() => {
    if (!focusRootResourceId) return starDocs;
    return starDocs.filter((doc) => docRootMap.docRoot.get(doc.id) === focusRootResourceId);
  }, [starDocs, focusRootResourceId, docRootMap]);

  // 收藏区段的知识库条目：只在全空间（未聚焦）时显示；聚焦某库时该库自身就在眼前，
  // 再列一条"知识库"收藏是冗余，直接隐藏（文档收藏仍按聚焦范围过滤）
  const visibleStarKbs = useMemo(() => {
    if (focusRootResourceId) return [];
    return nodes.filter(
      (n) => !n.isDeleted && n.parentId === null && n.resourceType === "notebook" && n.isFavorite === 1,
    );
  }, [nodes, focusRootResourceId]);

  // 收藏模块：当前笔记不在（可见）收藏中时，自动落到第一条收藏（避免编辑器停留在无关笔记）。
  // 走协调器（缓存优先 + 意图守卫）但保持原语义：只预载 activeNote，不切视图、不开页签。
  useEffect(() => {
    if (state.viewMode !== "favorites" || visibleStarDocs.length === 0) return;
    const activeId = state.activeNote?.id;
    if (activeId && visibleStarDocs.some((d) => d.id === activeId)) return;
    const first = visibleStarDocs[0];
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
  }, [state.viewMode, state.activeNote?.id, visibleStarDocs, loadNote, cancelNoteLoad, actions]);

  // 搜索结果分类（头部筛选控制分区显隐与文档集合）：标签 / 收藏 / 知识库·文件夹 / 文档。
  // 收藏与文档互斥展示，避免同一篇文档在弹层里出现两次。
  // favorite/tag 筛选 = 只在已收藏/已加标签的文档里搜（树节点自带 isFavorite；
  // 有标签文档集合由标签面板已加载的 tagDocs 汇总）。
  const taggedDocIds = useMemo(() => {
    const set = new Set<string>();
    for (const docs of Object.values(tagDocs)) {
      for (const doc of docs) set.add(doc.id);
    }
    return set;
  }, [tagDocs]);
  const favoriteSearchDocs = useMemo(
    () => (scope === "tag" ? [] : visibleSearchDocs.filter((doc) => doc.isFavorite === 1)),
    [visibleSearchDocs, scope],
  );
  const plainSearchDocs = useMemo(() => {
    let docs = visibleSearchDocs.filter((doc) => doc.isFavorite !== 1);
    if (scope === "favorite") docs = visibleSearchDocs.filter((doc) => doc.isFavorite === 1);
    else if (scope === "tag") docs = docs.filter((doc) => taggedDocIds.has(doc.id));
    return docs;
  }, [visibleSearchDocs, scope, taggedDocIds]);
  // 知识库/文件夹：本地树节点匹配（文档走接口搜索，这里只匹配容器节点）。
  // 筛选 scope：知识库=仅根层库，文件夹=仅非根层文件夹，文档/收藏/标签=不显示容器。
  const matchedTreeNodes = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];
    if (scope === "document" || scope === "favorite" || scope === "tag") return [];
    return nodes
      .filter((n) => {
        if (n.isDeleted) return false;
        if (scope === "notebook") return n.nodeType === "folder" && n.parentId === null && n.resourceType === "notebook";
        if (scope === "folder") return n.nodeType === "folder" && !(n.parentId === null && n.resourceType === "notebook");
        return n.nodeType === "folder" || (n.parentId === null && n.resourceType === "notebook");
      })
      .filter((n) => n.title.toLowerCase().includes(keyword))
      .slice(0, 8);
  }, [nodes, query, scope]);
  // 弹层分区显隐（随筛选 scope）：全部=四类都看；单档=只看对应类
  const searchSections = useMemo(() => ({
    tags: scope === "all" || scope === "tag",
    favorite: scope === "all" || scope === "favorite",
    tree: matchedTreeNodes.length > 0,
    docs: scope !== "notebook" && scope !== "folder",
  }), [scope, matchedTreeNodes.length]);

  /** 搜索结果点文件夹：展开到该节点并关闭弹层（不改变聚焦态）。 */
  const revealTreeNode = useCallback((nodeId: string) => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ancestors: string[] = [];
    let cursor: KnowledgeTreeNode | undefined = byId.get(nodeId);
    while (cursor) {
      ancestors.push(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    setExpanded((current) => {
      const next = new Set(current);
      for (const id of ancestors) next.add(id);
      return next;
    });
    setSearchOpen(false);
    setQuery("");
  }, [nodes]);

  // 主区 Overview 目录点文件夹 → 侧栏树展开到该节点并选中（不离开 Overview）。
  const revealNodeFromOverview = useCallback((nodeId: string) => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ancestors: string[] = [];
    let cursor: KnowledgeTreeNode | undefined = byId.get(nodeId);
    while (cursor) {
      ancestors.push(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    setExpanded((current) => {
      const next = new Set(current);
      for (const id of ancestors) next.add(id);
      return next;
    });
    setSelectedNodeIds(new Set([nodeId]));
    selectionAnchorRef.current = nodeId;
  }, [nodes]);

  useEffect(() => {
    const onReveal = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
      if (nodeId) revealNodeFromOverview(nodeId);
    };
    window.addEventListener("nowen:kb-reveal-node", onReveal);
    return () => window.removeEventListener("nowen:kb-reveal-node", onReveal);
  }, [revealNodeFromOverview]);

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
    // URL 必须跟随这篇文档「自己所属的库」，而不是上一个库（否则 A 库路径 + B 库文档，
    // 切库连续点文档时 URL 错乱、聚焦态也跟着错）。?tree=focus 一并保留。
    const ws = getCurrentWorkspace();
    const rootKb = docRootMap.docRoot.get(node.resourceId) ?? null;
    if (rootKb) {
      // 聚焦态以地址栏为准：state.route 是异步回灌的，刚点完聚焦立刻点文档会读到旧值，
      // 导致写 URL 时把 ?tree=focus 丢掉（切走再回来聚焦就没了）。
      const focusedNow = new URLSearchParams(window.location.search).get("tree") === "focus";
      const target = `${kbNoteAppPath(ws, rootKb, node.resourceId)}${focusedNow ? "?tree=focus" : ""}`;
      if (`${resolveCurrentAppPathname()}${window.location.search}` !== target) pushAppPathState(target);
    }
    await openNoteFromTab(node.resourceId);
  }, [actions, openNoteFromTab, selectFolder, docRootMap]);

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
      if (node.parentId === null && node.resourceType === "notebook") {
        // 库根行：展开子树 + 主区 Overview（折叠交给双击/箭头，不跟随单击）
        setExpanded((cur) => (cur.has(node.id) ? cur : new Set(cur).add(node.id)));
        openKbOverview(node.resourceId);
        return;
      }
      // 文件夹：选中 + 展开/折叠（主区不动）
      toggleNode(node);
      return;
    }
    void openNode(node);
  }, [selectFolder, openNode, openKbOverview, toggleNode]);

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

  // 渲染兜底：顺序数组保证恰好包含全部四个区段（localStorage 脏数据/未来增删区段时不丢面板）
  const safeOrder = useMemo<SectionId[]>(() => normalizeSectionOrder(sectionOrder), [sectionOrder]);

  // ---- 区段排序（pointer 实现而非 HTML5 DnD：区段头按下拖动，松手时按当前指针位置落位） ----
  // 拖拽视觉反馈：正在拖拽的区段 id（HTML5 DnD）
  const [reorderActive, setReorderActive] = useState<SectionId | null>(null);

  // ---- 区段排序：HTML5 DnD（原生拖影），从区段头空白处启动；button 上按下不启动 ----
  const onSectionDragStart = useCallback((id: SectionId) => (event: React.DragEvent) => {
    event.dataTransfer.setData("text/plain", id);
    // 专用类型：让区段拖拽和知识树行拖拽（也用 text/plain）互相区分，
    // 否则拖一行文档经过别的区段头会被当成区段排序。
    event.dataTransfer.setData(SECTION_DRAG_TYPE, id);
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
    // 仅响应区段排序拖拽（专用 dataTransfer 类型；知识树行拖拽不带它）
    if (!event.dataTransfer.types.includes(SECTION_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setSectionDropHint({ id, after: event.clientY > rect.top + rect.height / 2 });
  }, []);

  const onSectionDrop = useCallback((id: SectionId) => (event: React.DragEvent) => {
    // drop 阶段读得到 dataTransfer 值：空值 = 不是区段排序拖拽（知识树行拖拽不带该类型）
    const from = event.dataTransfer.getData(SECTION_DRAG_TYPE) as SectionId;
    if (!SECTION_IDS.includes(from)) return;
    event.preventDefault();
    event.stopPropagation();
    setReorderActive(null);
    setSectionDropHint(null);
    if (from === id) return;
    // 落点在目标区段下半部 = 插到它后面；上半部 = 插到它前面（拖到文字下方=排到下面）
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    setSectionOrder((current) => {
      // 必须在归一化后的顺序上算下标：持久化的旧顺序可能没有 star，
      // 直接 indexOf 会拿到 -1，插入位被算成 0（表现为"拖到收藏下面却跑到最上方"）。
      const base = normalizeSectionOrder(current);
      const next = base.filter((section) => section !== from);
      const idx = next.indexOf(id);
      if (idx < 0) return base;
      next.splice(after ? idx + 1 : idx, 0, from);
      return next;
    });
  }, []);

  // 拖拽预演：不重排渲染（内容与 DOM 永不消失），只把 drop 意图存进 hint，
  // 由目标板块的"上/下半内阴影高亮"表达落点；松手时 onSectionDrop 一次性提交顺序。
  // （旧 previewOrder 重排渲染会在换位时移除被拖板块 DOM，导致原生拖影中断、面板闪没。）

  // ---- 面板高度：交给 SplitView（尺寸和恒等于容器高度，折叠份额按比例分给其它组）----
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

  // ---- kb 树拖拽：拿起 / 落点判定 / 落点视觉统一交给 useSortableDrag ----
  const treeDrag = useSortableDrag(rows, {
    getId: (row) => row.node.id,
    // 只有文件夹能接受"拖入内部"，文档行只在上下两半判定前/后。
    // 例外：根级知识库自己拖过来时只做根层前后排序，不接受"放入"（否则会从根列表消失）。
    canDropInto: (row, source) => {
      if (row.node.nodeType !== "folder") return false;
      if (source && isRootNotebookNode(source.node)) return false;
      return true;
    },
    // 禁止移入自身子树（target 在 source 子树内则整行都不接）；
    // 根级知识库只能在根层内重排：落点必须是根层节点，且不能是"放入"。
    canDrop: (source, target, position) => {
      if (isRootNotebookNode(source.node)) {
        return position !== "into" && (target.node.parentId ?? null) === null;
      }
      return !isDescendant(target.node.id, source.node.id, childrenMap);
    },
    // 行内重命名时不可拿起（知识库根也要能拖，只在落点上限制）
    canDrag: (row) => !(renaming?.kind === "kb" && renaming.id === row.node.id),
    onDrop: ({ sourceId, targetId, position }) => {
      const target = targetId ? rows.find((row) => row.node.id === targetId)?.node : undefined;
      void (async () => {
        try {
          if (target && position === "into") {
            // 移入文件夹
            await knowledgeTreeApi.move(sourceId, { parentId: target.id });
            // 折叠文件夹自动展开
            setExpanded((cur) => new Set(cur).add(target.id));
            // 本地先按同一套规则摆好（追加到该父级末尾），再交给 reload 收敛
            reloadSeqRef.current += 1;
            setNodes((cur) => applyOptimisticMove(cur, sourceId, target.id, null));
          } else if (target) {
            // 前/后插入：交给后端按锚点重排兄弟 sortOrder（只传 parentId 会被追加到末尾）
            const parentId = target.parentId ?? null;
            const anchorPosition = position === "before" ? "before" : "after";
            await knowledgeTreeApi.move(sourceId, {
              parentId,
              ...(position === "before" ? { beforeId: target.id } : { afterId: target.id }),
            });
            // 作废拖拽期间已在飞的 reload，再本地摆好新顺序（两边顺序一致，reload 回来不跳）
            reloadSeqRef.current += 1;
            setNodes((cur) => applyOptimisticMove(cur, sourceId, parentId, { id: target.id, position: anchorPosition }));
          } else {
            // 空白区 = 移到根层末尾
            await knowledgeTreeApi.move(sourceId, { parentId: null });
            reloadSeqRef.current += 1;
            setNodes((cur) => applyOptimisticMove(cur, sourceId, null, null));
          }
          window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
        } catch (error) {
          console.error("[SidebarDesktop] drop move failed:", error);
        }
      })();
    },
  });

  // ---- 行级菜单动作 ----
  const startCreateFolder = useCallback(async (parentId: string | null) => {
    try {
      const created = await knowledgeTreeApi.create({ parentId, nodeType: "folder", title: parentId === null ? "新建知识库" : "新建文件夹" });
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
    const { kind, id, value, isNew } = renaming;
    const trimmed = value.trim();
    setRenaming(null);
    if (!trimmed) {
      // 新建流程里留空 = 放弃这次创建（删掉刚建的节点）；普通重命名留空 = 保持原名
      if (isNew) {
        try {
          await knowledgeTreeApi.remove(id, "subtree");
          window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
        } catch (error) {
          console.error("[SidebarDesktop] discard new node failed:", error);
        }
      }
      return;
    }
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

  /** 取消重命名：新建流程下等同于撤销这次创建（删除刚建的节点），否则仅退出改名。 */
  const cancelRename = useCallback(() => {
    const current = renaming;
    setRenaming(null);
    if (!current?.isNew) return;
    void knowledgeTreeApi.remove(current.id, "subtree")
      .then(() => window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed")))
      .catch((error) => console.error("[SidebarDesktop] discard new node failed:", error));
  }, [renaming]);

  const deleteNode = useCallback(async (nodeId: string) => {
    try {
      await knowledgeTreeApi.remove(nodeId, "subtree");
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
      if (focusRootId === nodeId) exitKb();
    } catch (error) {
      console.error("[SidebarDesktop] delete node failed:", error);
    }
  }, [focusRootId]);

  /** 复制文档 = 连接：正文、附件、标签都不复制，只多一条指向同一份内容的路径。 */
  const duplicateNoteNode = useCallback(async (node: KnowledgeTreeNode) => {
    if (node.resourceType !== "note") return;
    try {
      const reference = await knowledgeTreeApi.createReference(node.resourceId, node.parentId || undefined);
      if (reference.parentId) setExpanded((cur) => new Set(cur).add(reference.parentId!));
      await reload();
      actions.refreshNotes();
      toast.success("已复制，副本与原文档共用同一份内容");
    } catch (error) {
      console.error("[SidebarDesktop] copy note reference failed:", error);
      toast.error(error instanceof Error ? error.message : "复制失败");
    }
  }, [actions, reload]);

  /** 复制文件夹/知识库：整棵子树（子目录、文档、附件）深拷贝到同级。 */
  const duplicateFolderNode = useCallback(async (node: KnowledgeTreeNode) => {
    if (node.resourceType !== "notebook") return;
    const toastId = toast.info(`正在复制“${node.title}”…`, 0);
    try {
      const result = await knowledgeTreeApi.duplicateFolder(node.id);
      toast.dismiss(toastId);
      const skipped = result.skippedNoteCount + result.skippedFileCount;
      toast.success(skipped > 0
        ? `已复制为“${result.title}”，跳过 ${skipped} 项无法复制的内容`
        : `已复制为“${result.title}”`);
      if (node.parentId) setExpanded((cur) => new Set(cur).add(node.parentId!));
      await reload();
      actions.refreshNotes();
      actions.refreshNotebooks();
    } catch (error) {
      toast.dismiss(toastId);
      console.error("[SidebarDesktop] duplicate folder failed:", error);
      toast.error(error instanceof Error ? error.message : "复制文件夹失败");
    }
  }, [actions, reload]);

  /** 导出单篇文档：与知识库面板同一套格式。 */
  const exportNoteNode = useCallback(async (node: KnowledgeTreeNode, actionId: string) => {
    if (node.resourceType !== "note") return;
    const toastId = toast.info(`正在导出“${node.title}”…`, 0);
    try {
      if (actionId === "export_note_md" || actionId === "export_note_md_zip") {
        const ok = await exportSingleNote(node.resourceId, { forceZip: actionId === "export_note_md_zip" });
        if (!ok) throw new Error("导出失败");
      } else if (actionId === "export_note_pdf") {
        const result = await exportSingleNoteAsPDF(node.resourceId);
        if (!result.ok && result.mode !== "canceled") {
          throw new Error((result as { error?: string }).error || "导出失败");
        }
      } else if (actionId === "export_note_png" || actionId === "export_note_jpg") {
        const fresh = await api.getNote(node.resourceId);
        const ok = await exportNoteAsImage({
          id: fresh.id,
          title: fresh.title,
          content: fresh.content,
          contentText: fresh.contentText,
          contentFormat: fresh.contentFormat,
          updatedAt: fresh.updatedAt,
        }, { format: actionId.endsWith("png") ? "png" : "jpg" });
        if (!ok) throw new Error("导出失败");
      } else if (actionId === "export_note_word") {
        const fresh = await api.getNote(node.resourceId);
        const { exportNoteAsDocx, downloadDocxBlob } = await import("@/lib/wordNoteService");
        const blob = await exportNoteAsDocx(fresh.content || "", fresh.title || "未命名笔记");
        await downloadDocxBlob(blob, fresh.title || "未命名笔记");
      }
      toast.dismiss(toastId);
      toast.success("导出完成");
    } catch (error) {
      toast.dismiss(toastId);
      console.error("[SidebarDesktop] export note failed:", error);
      toast.error(error instanceof Error ? error.message : "导出失败");
    }
  }, []);

  /** 导出目录（含子目录）：与文档一致，可选 Markdown / PDF / PNG / JPG / Word。 */
  const exportFolderNode = useCallback(async (node: KnowledgeTreeNode, format: NotebookExportFormat) => {
    if (node.resourceType !== "notebook") return;
    const { ids, names } = descendantNotebookResources(node, nodes);
    let toastId = toast.info(`正在导出“${node.title}”…`, 0);
    try {
      const ok = await exportNotebookAsFormat({
        notebookId: node.resourceId,
        notebookName: node.title,
        descendantNotebookIds: ids,
        descendantNotebookNames: names,
      }, format, (progress) => {
        // 逐篇渲染/打包时把粘性提示换成当前进度，避免长目录导出“毫无反应”。
        if (progress.phase !== "converting" && progress.phase !== "packing") return;
        toast.dismiss(toastId);
        toastId = toast.info(progress.message, 0);
      });
      toast.dismiss(toastId);
      if (ok) {
        toast.success("导出完成");
      } else {
        toast.error("导出失败");
      }
    } catch (error) {
      toast.dismiss(toastId);
      console.error("[SidebarDesktop] export folder failed:", error);
      toast.error(error instanceof Error ? error.message : "导出失败");
    }
  }, [nodes]);

  // 选中节点的键盘快捷键：F2 重命名 / Delete 删除（与行菜单右侧提示一致）。
  // 必须放在 deleteNode 声明之后——依赖数组在渲染期求值，提前引用即 TDZ。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F2" && event.key !== "Delete") return;
      if (selectedNodeIds.size !== 1) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if ((active as HTMLElement | null)?.isContentEditable) return;
      // 浮层/对话框打开时不抢键（菜单内的 Delete 属于菜单自身语义）
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      const nodeId = [...selectedNodeIds][0];
      const node = nodes.find((n) => n.id === nodeId && !n.isDeleted);
      if (!node) return;
      if (event.key === "F2") {
        event.preventDefault();
        setRenaming({ kind: "kb", id: node.id, value: node.title });
        return;
      }
      event.preventDefault();
      void (async () => {
        const ok = await confirm({
          title: `删除「${node.title}」`,
          description: node.nodeType === "folder"
            ? "该文件夹（知识库）下的子文件夹与文档会一起删除。"
            : "删除后可在回收站恢复。",
          confirmText: "删除",
          danger: true,
        });
        if (ok) await deleteNode(node.id);
      })();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedNodeIds, nodes, deleteNode]);

  const deleteTag = useCallback(async (tagId: string) => {
    try {
      await api.deleteTag(tagId);
      void reloadTags();
    } catch (error) {
      console.error("[SidebarDesktop] delete tag failed:", error);
    }
  }, [reloadTags]);

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

  /**
   * 打开的文档 → 侧栏选中同步（VS Code 式定位）：页签切换 / 命令面板 / 列表打开文档时，
   * 自动退出专注、展开祖先、选中对应节点并滚动到位，避免"编辑器显示 b、侧栏还选着 a"。
   */
  const revealNoteById = useCallback((noteId: string) => {
    const hit = nodes.find((n) => !n.isDeleted && n.nodeType !== "folder" && n.resourceId === noteId);
    if (!hit) return;
    if (focusRootId && hit.id !== focusRootId && !isDescendant(hit.id, focusRootId, childrenMap)) {
      setFocusRootId(null);
    }
    setExpanded((current) => {
      const next = new Set(current);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      let cursor: KnowledgeTreeNode | undefined = hit;
      while (cursor?.parentId) {
        next.add(cursor.parentId);
        cursor = byId.get(cursor.parentId);
      }
      return next;
    });
    setSelectedNodeIds(new Set([hit.id]));
    requestAnimationFrame(() => {
      const el = treeRootRef.current?.querySelector(`[data-next-row="${hit.id}"]`);
      el?.scrollIntoView({ block: "center" });
    });
  }, [nodes, focusRootId, childrenMap]);

  // activeNote 变化（页签切换 / 命令面板 / 侧栏打开）时把选中与滚动定位同步过去；
  // lastRevealedIdRef 防止同一文档重复触发（避免与用户手动多选打架）。
  const lastRevealedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = state.activeNote?.id ?? null;
    if (!id || lastRevealedIdRef.current === id) return;
    lastRevealedIdRef.current = id;
    revealNoteById(id);
  }, [state.activeNote?.id, revealNoteById]);

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
  // 收藏区段总数（文档 + 知识库）
  const starTotal = visibleStarDocs.length + visibleStarKbs.length;

  // ---- 区段渲染顺序 ----
  const sectionMap: Record<SectionId, React.ReactNode> = {
    kb: (
      <section key="kb" className="shrink-0" data-next-section="kb">
        {/* 区块头：全空间 = 「知识库 ＋ ⋯ N」；聚焦 = 「📘 库名 ＋ N ×」
            （点×退出库内树空间，点库名回 Overview，＋在库内新建）。 */}
        {focusRoot ? (
          <div
            draggable
            onDragStart={onSectionDragStart("kb")}
            onDragEnd={onSectionDragEnd}
            className={cn(
              "flex w-full cursor-grab select-none items-center gap-1 px-2 py-1 active:cursor-grabbing",
              reorderActive === "kb" && "opacity-40",
            )}
          >
            <span className="shrink-0 text-[13px] leading-none">{knowledgeTreeEmojiFor(focusRoot, true)}</span>
            <button
              type="button"
              onClick={() => openKbOverview(focusRoot.resourceId)}
              title="打开库概览"
              className="min-w-0 flex-1 truncate rounded px-0.5 py-0.5 text-left text-[12px] font-semibold text-accent-primary hover:bg-app-hover"
            >
              {focusRoot.title}
            </button>
            {!collapsedSections.has("kb") && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setCreateMenuState({ parentId: focusRoot.id, anchor: new DOMRect(rect.left, rect.top, rect.width, rect.height) });
                  }}
                  title={t("sidebarNext.newFolder", { defaultValue: "新建" })}
                  className="flex h-[22px] w-[22px] items-center justify-center rounded text-tx-tertiary hover:bg-app-active hover:text-tx-primary"
                >
                  <Plus size={13} />
                </button>
                <span className="rounded-full bg-app-hover px-1.5 text-[10px] tabular-nums text-tx-tertiary">{docCountMap.get(focusRoot.id) ?? 0}</span>
                <button
                  type="button"
                  onClick={exitKb}
                  title={t("sidebarNext.focusExit", { defaultValue: "退出库内树空间" })}
                  className="flex h-[22px] w-[22px] items-center justify-center rounded text-tx-tertiary hover:bg-app-active hover:text-tx-primary"
                >
                  <X size={13} />
                </button>
              </>
            )}
          </div>
        ) : (
        <div
          draggable
          onDragStart={onSectionDragStart("kb")}
          onDragEnd={onSectionDragEnd}
          className={cn(
            "flex w-full cursor-grab select-none items-center gap-1 px-2 py-1 active:cursor-grabbing",
            reorderActive === "kb" && "opacity-40",
          )}
        >
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
                <Ellipsis size={15} strokeWidth={2} />
              </button>
            </>
          )}
          <span className="ml-1 rounded-full bg-app-hover px-1.5 text-[10px] tabular-nums text-tx-tertiary">{docCount}</span>
        </div>
        )}

        {!collapsedSections.has("kb") && (
          <div className="pb-2 pl-2.5 pr-1">
            {loading ? (
              <p className="px-2 py-2 text-[11px] text-tx-tertiary">加载中…</p>
            ) : rows.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-tx-tertiary">
                <p>
                  {searching
                    ? t("sidebarNext.noMatch", { defaultValue: "无匹配的文件夹或笔记" })
                    : focusRoot
                      ? t("sidebarNext.emptyKb", { defaultValue: "这个知识库还没有内容" })
                      : t("sidebarNext.empty", { defaultValue: "暂无内容" })}
                </p>
                {!searching && focusRoot && (
                  <button
                    type="button"
                    onClick={() => void startCreateNote(focusRoot.id)}
                    className="mt-1.5 flex items-center gap-1 rounded-md border border-dashed border-app-border px-2 py-1 text-[11px] text-tx-secondary hover:border-accent-primary hover:text-accent-primary"
                  >
                    <Plus size={12} />
                    新建文档
                  </button>
                )}
              </div>
            ) : (
              // 空白区 = 根层末尾（行上的 dragOver/drop 已 stopPropagation，不会冒泡到这里）
              <div
                ref={treeRootRef}
                {...treeDrag.getContainerProps()}
              >
                {rows.map((row) => {
                  const { node, depth, hasChildren, expanded: isExpanded } = row;
                  const isFolder = node.nodeType === "folder";
                  const isKbRoot = node.parentId === null && node.resourceType === "notebook";
                  const isSelected = selectedNodeIds.has(node.id);
                  const isFlash = flashId === node.id;
                  const isRenaming = renaming?.kind === "kb" && renaming.id === node.id;
                  return (
                    <div
                      key={node.id}
                      {...treeDrag.getDragProps(row)}
                      onDoubleClick={() => {
                        // 双击库根 = 折叠/展开（Overview 导航只跟单击）
                        if (isKbRoot) toggleNode(node);
                      }}
                      className={cn(
                        "group flex h-8 items-center gap-1 rounded-md pr-1 text-xs transition-colors",
                        // 重命名时不要蓝色选中底：会和输入框边框叠成一坨蓝色
                        isSelected && !isRenaming ? "bg-accent-primary/20 font-medium text-tx-primary" : "text-tx-primary hover:bg-app-hover",
                        // 选中标（左侧内阴影）；放在落点视觉之前，让落点阴影在悬停时覆盖它
                        isSelected && "shadow-[inset_2px_0_0_var(--color-accent-primary)]",
                        isFlash && "animate-pulse bg-accent-primary/25",
                        // 拿起半透明 / 上·下内阴影 / 拖入高亮
                        treeDrag.visualFor(node.id),
                      )}
                      style={{ paddingLeft: 2 + depth * 16 }}
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
                        <>
                          <input
                            ref={renameInputRef}
                            value={renaming.value}
                            onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
                              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelRename(); }
                            }}
                            onBlur={() => void commitRename()}
                            className="no-focus-ring h-[26px] min-w-0 flex-1 rounded-lg border border-accent-primary bg-app-bg px-2 text-[12px] text-tx-primary outline-none transition-colors"
                            autoFocus
                          />
                          {/* 确认/取消按钮 onMouseDown 阻止默认，避免 input 先失焦触发 onBlur 提交 */}
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => void commitRename()}
                            title="确认"
                            aria-label="确认重命名"
                            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-accent-primary transition-colors hover:bg-app-hover"
                          >
                            <Check size={13} />
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={cancelRename}
                            title="取消"
                            aria-label="取消重命名"
                            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
                          >
                            <X size={13} />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={(event) => handleRowClick(event, node)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        >
                          {fileIconFor(node, !focusRootId && depth === 0)}
                          <span className="min-w-0 flex-1 truncate">{node.title}</span>
                          {/* 复制 = 连接：同一篇文档的额外路径带一个链标，提示正文只有一份 */}
                          {node.isReference && (
                            <span className="shrink-0 text-tx-tertiary" title="同一份内容的另一条路径">
                              <Link2 size={10} />
                            </span>
                          )}
                          {isFolder && (
                            <span className="shrink-0 text-[11px] tabular-nums text-tx-tertiary">
                              {docCountMap.get(node.id) ?? 0}
                            </span>
                          )}
                        </button>
                      )}

                      {!isRenaming && (
                        <>
                          {isKbRoot && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); focusKb(node.resourceId); }}
                              title="聚焦此知识库"
                              className={cn(
                                "h-5 w-5 shrink-0 items-center justify-center rounded text-tx-tertiary hover:bg-app-hover hover:text-accent-primary group-hover:flex",
                                isSelected && "flex",
                              )}
                            >
                              <Focus size={11} />
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
                            <Ellipsis size={15} strokeWidth={2} />
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
                <Ellipsis size={15} strokeWidth={2} />
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
                        <>
                          <input
                            ref={renameInputRef}
                            value={renaming.value}
                            onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
                              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelRename(); }
                            }}
                            onBlur={() => void commitRename()}
                            className="no-focus-ring h-[26px] min-w-0 flex-1 rounded-lg border border-accent-primary bg-app-bg px-2 text-[12px] text-tx-primary outline-none transition-colors"
                            autoFocus
                          />
                          {/* 确认/取消按钮 onMouseDown 阻止默认，避免 input 先失焦触发 onBlur 提交 */}
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => void commitRename()}
                            title="确认"
                            aria-label="确认重命名"
                            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-accent-primary transition-colors hover:bg-app-hover"
                          >
                            <Check size={13} />
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={cancelRename}
                            title="取消"
                            aria-label="取消重命名"
                            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
                          >
                            <X size={13} />
                          </button>
                        </>
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
                          <Ellipsis size={15} strokeWidth={2} />
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
                          <span className="shrink-0 text-[13px] leading-none">{docEmojiForFormat(doc.contentFormat, doc.noteType)}</span>
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
                          <Ellipsis size={15} strokeWidth={2} />
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
                    <span className="shrink-0 text-[13px] leading-none">{docEmojiForFormat(tab.contentFormat)}</span>
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
        <div
          draggable
          onDragStart={onSectionDragStart("star")}
          onDragEnd={onSectionDragEnd}
          className={cn(
            "flex w-full cursor-grab select-none items-center gap-1 px-2 py-1 active:cursor-grabbing",
            reorderActive === "star" && "opacity-40",
          )}
        >
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
                title={`取消所有收藏，共 ${starTotal} 条`}
                className="flex h-[22px] w-[22px] items-center justify-center rounded text-tx-tertiary hover:bg-app-active hover:text-accent-danger"
                onClick={async () => {
                  if (starTotal === 0) return;
                  const ok = await confirm({
                    title: "取消全部收藏",
                    description: focusRootResourceId
                      ? `将取消当前知识库内 ${starTotal} 项的收藏，文档与知识库本身不受影响。`
                      : `将取消 ${starTotal} 项的收藏，文档与知识库本身不受影响。`,
                    confirmText: "取消收藏",
                  });
                  if (!ok) return;
                  Promise.all([
                    ...visibleStarDocs.map((doc) => api.updateNote(doc.id, { isFavorite: 0 } as never)),
                    ...visibleStarKbs.map((kb) => knowledgeTreeApi.update(kb.id, { isFavorite: 0 })),
                  ])
                    .then(() => {
                      reloadStar();
                      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
                    })
                    .catch(() => undefined);
                }}
              >
                <Star size={13} />
              </button>
              <span className="pr-1 text-[11px] tabular-nums text-tx-tertiary">{starTotal}</span>
            </>
          )}
        </div>
        {!collapsedSections.has("star") && (
          <div className="pb-1">
            {starTotal === 0 ? (
              <p className="px-6 py-1 text-xs text-tx-tertiary">暂无收藏</p>
            ) : (
              <>
                {visibleStarKbs.map((kb) => (
                  <div
                    key={`kb-${kb.id}`}
                    className="sbx-row group"
                    onClick={() => openKbOverview(kb.resourceId)}
                  >
                    <span className="sbx-ico"><span className="text-[13px] leading-none">{knowledgeTreeEmojiFor(kb, true)}</span></span>
                    <span className="min-w-0 flex-1">
                      <div className="truncate text-xs text-tx-primary">{kb.title}</div>
                      <div className="sbx-sub">知识库</div>
                    </span>
                    <span className="sbx-acts">
                      <button
                        type="button"
                        title="取消收藏"
                        onClick={(e) => {
                          e.stopPropagation();
                          knowledgeTreeApi.update(kb.id, { isFavorite: 0 })
                            .then(() => window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed")))
                            .catch(() => undefined);
                        }}
                        className="sbx-btn"
                      >
                        <Star size={12} className="text-amber-400" fill="currentColor" />
                      </button>
                    </span>
                  </div>
                ))}
                {visibleStarDocs.map((doc) => (
                  <div
                    key={doc.id}
                    className="sbx-row group"
                    onClick={() => { void openNoteFromTab(doc.id); }}
                  >
                    <span className="sbx-ico"><span className="text-[13px] leading-none">{docEmojiForFormat(doc.contentFormat, doc.noteType)}</span></span>
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
              </>
            )}
          </div>
        )}
      </section>
    ),
  };

  const activeWorkspace = workspaces.find((w) => w.id === currentWs);
  const canManageActiveWorkspace = Boolean(
    activeWorkspace && (activeWorkspace.role === "owner" || activeWorkspace.role === "admin"),
  );

  return (
    <aside
      className="relative flex h-full min-w-0 flex-col overflow-hidden border-r border-app-border bg-app-surface text-tx-primary"
      style={{ width: sidebarWidth }}
      data-next-sidebar=""
    >
      {/* ===== 头部：位置 + 搜索 —— 仅知识库视图显示；模块视图有自己的面板头 ===== */}
      <header
        className="relative flex h-12 shrink-0 items-center gap-1.5 border-b border-app-border px-2.5"
        style={sidebarView === "kb" ? undefined : { display: "none" }}
      >
        <div ref={spaceRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setSpaceOpen((v) => !v)}
            aria-expanded={spaceOpen}
            title={t("sidebarNext.switchSpace", { defaultValue: "切换空间" })}
            className="flex h-8 max-w-[104px] items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-tx-primary transition-colors hover:bg-app-hover"
          >
            {activeWorkspace?.avatarUrl ? (
              <img
                key={activeWorkspace.avatarUrl}
                src={api.workspaceAvatarFileUrl(activeWorkspace.id, activeWorkspace.updatedAt)}
                alt=""
                className="h-5 w-5 shrink-0 rounded-md object-cover"
              />
            ) : (
              <Home size={14} className="shrink-0 text-tx-tertiary" />
            )}
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
                  {w.avatarUrl ? (
                    <img
                      key={w.avatarUrl}
                      src={api.workspaceAvatarFileUrl(w.id, w.updatedAt)}
                      alt=""
                      className="h-4 w-4 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <Users size={13} className="shrink-0 text-tx-tertiary" />
                  )}
                  <span className="flex-1">{w.name}</span>
                  {currentWs === w.id && <Check size={12} className="text-accent-primary" />}
                </button>
              ))}
              <button
                type="button"
                onClick={() => { setSpaceOpen(false); setCreateOpen(true); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover"
              >
                <Plus size={13} className="shrink-0 text-tx-tertiary" />
                <span className="flex-1">创建空间</span>
              </button>
              {canManageActiveWorkspace && (
                <button
                  type="button"
                  onClick={() => { setSpaceOpen(false); setManageOpen(true); }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover"
                >
                  <Users size={13} className="shrink-0 text-tx-tertiary" />
                  <span className="flex-1">空间管理</span>
                </button>
              )}
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
          ref={searchContainerRef}
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
            onFocus={() => setSearchOpen(true)}
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
        </div>

      {/* ===== 搜索结果面板：贴边悬于树之上（宽度 = 侧栏，绝不越界压编辑区）。
          类型筛选（全部/知识库/文档/文件夹/收藏/标签）内嵌在面板顶部，不占头部按钮。 ===== */}
      {sidebarView === "kb" && searchOpen && (
        <div
          ref={searchPopupRef}
          role="dialog"
          aria-label={t("sidebarNext.searchLabel", { defaultValue: "搜索知识库" })}
          className="absolute inset-x-1.5 top-full z-[60] mt-1 flex max-h-[min(460px,calc(100vh-88px))] flex-col overflow-hidden rounded-lg border border-app-border bg-app-elevated text-left shadow-[0_10px_28px_rgba(15,23,42,0.14)] dark:shadow-[0_10px_28px_rgba(0,0,0,0.5)]"
        >
          {/* 筛选条：类型 chips（三列网格，窄侧栏也全部可见、不折行错位） */}
          <div className="shrink-0 border-b border-app-border px-2 pb-2 pt-1.5">
              {focusRoot && (
                <div className="mb-1.5 flex items-center gap-1">
                  <span className="mr-0.5 text-[10px] text-tx-tertiary">范围</span>
                  <button
                    type="button"
                    onClick={() => setSearchScope("kb")}
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10.5px] leading-4 transition-colors",
                      searchScope === "kb" ? "bg-accent-primary/15 font-medium text-accent-primary" : "text-tx-tertiary hover:bg-app-hover",
                    )}
                  >
                    库内
                  </button>
                  <button
                    type="button"
                    onClick={() => setSearchScope("all")}
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10.5px] leading-4 transition-colors",
                      searchScope === "all" ? "bg-accent-primary/15 font-medium text-accent-primary" : "text-tx-tertiary hover:bg-app-hover",
                    )}
                  >
                    全空间
                  </button>
                </div>
              )}
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-app-border bg-app-surface p-1">
                {FILTER_SCOPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={scope === opt.value}
                    onClick={() => setScope(opt.value)}
                    className={cn(
                      "flex h-7 items-center justify-center rounded-md text-[11.5px] leading-none transition-colors",
                      scope === opt.value
                        ? "bg-app-elevated font-medium text-accent-primary shadow-[0_1px_2px_rgba(15,23,42,0.10)]"
                        : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
          </div>

          {/* 结果区（滚动） */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
            {!query.trim() ? (
              <div className="flex flex-col items-center gap-1.5 px-3 py-7 text-center">
                <Search size={16} className="text-tx-tertiary opacity-60" />
                <p className="text-[11.5px] leading-relaxed text-tx-tertiary">
                  输入关键词搜索标签、收藏、知识库与文档
                </p>
              </div>
            ) : (
              <>
                {(searchSections.tags && matchedTags.length > 0) === false
                  && (searchSections.favorite && favoriteSearchDocs.length > 0) === false
                  && searchSections.tree === false
                  && (searchSections.docs && plainSearchDocs.length > 0) === false && (
                  <p className="px-2 py-6 text-center text-[11px] text-tx-tertiary">
                    {searchFetching
                      ? "搜索中…"
                      : scope === "notebook" ? "无匹配的知识库"
                        : scope === "folder" ? "无匹配的文件夹"
                          : scope === "document" ? "无匹配的文档"
                            : scope === "favorite" ? "收藏中无匹配的文档"
                              : scope === "tag" ? "已加标签的文档中无匹配"
                                : "无匹配的标签、收藏、知识库或文档"}
                  </p>
                )}

              {searchSections.tags && matchedTags.length > 0 && (
                <>
                  <p className="px-2 pb-1 pt-2 text-[10.5px] font-medium text-tx-tertiary">标签</p>
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
                            <span className="shrink-0 text-[13px] leading-none">{docEmojiForFormat(doc.contentFormat, doc.noteType)}</span>
                            <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                          </button>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </>
              )}

              {searchSections.favorite && favoriteSearchDocs.length > 0 && (
                <>
                  <p className="px-2 pb-1 pt-2 text-[10.5px] font-medium text-tx-tertiary">收藏</p>
                  {favoriteSearchDocs.map((doc) => (
                    <button
                      key={`fav-${doc.id}`}
                      type="button"
                      role="option"
                      onClick={() => void openSearchDoc(doc.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-tx-primary hover:bg-app-hover"
                    >
                      <span className="shrink-0 text-[13px] leading-none">{docEmojiForFormat(doc.contentFormat, doc.noteType)}</span>
                      <span className="min-w-0 flex-1 truncate" title={doc.title}>{doc.title}</span>
                      <LiaThumbtackSolid size={10} className="shrink-0 text-amber-500" />
                    </button>
                  ))}
                </>
              )}

              {searchSections.tree && (
                <>
                  <p className="px-2 pb-1 pt-2 text-[10.5px] font-medium text-tx-tertiary">知识库 / 文件夹</p>
                  {matchedTreeNodes.map((node) => (
                    <button
                      key={`tree-${node.id}`}
                      type="button"
                      role="option"
                      onClick={() => {
                        if (node.nodeType === "folder") {
                          revealTreeNode(node.id);
                        } else {
                          // 知识库命中：展开子树 + 打开 Overview
                          setExpanded((current) => new Set(current).add(node.id));
                          openKbOverview(node.resourceId);
                          setSearchOpen(false);
                          setQuery("");
                        }
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-tx-primary hover:bg-app-hover"
                    >
                      <span className="shrink-0 text-[13px] leading-none">{knowledgeTreeEmojiFor(node, node.parentId === null)}</span>
                      <span className="min-w-0 flex-1 truncate" title={node.title}>{node.title}</span>
                    </button>
                  ))}
                </>
              )}

              {searchSections.docs && plainSearchDocs.length > 0 && (
                <>
                  <p className="px-2 pb-1 pt-2 text-[10.5px] font-medium text-tx-tertiary">
                    {focusRoot && searchScope === "kb" ? "文档 · 库内" : scope === "favorite" ? "收藏的文档" : scope === "tag" ? "带标签的文档" : "文档"}
                  </p>
                  {plainSearchDocs.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      role="option"
                      onClick={() => void openSearchDoc(doc.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-tx-primary hover:bg-app-hover"
                    >
                      <span className="shrink-0 text-[13px] leading-none">{docEmojiForFormat(doc.contentFormat, doc.noteType)}</span>
                      <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                    </button>
                  ))}
                </>
              )}
              </>
            )}
          </div>
        </div>
      )}
      </header>

      {/* ===== 三面板容器（kb 固定置顶；其余区段头 HTML5 拖拽排序；折叠在原位收起；面板高度可拖拽） ===== */}
      <div
        ref={panelScrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        onClick={(event) => {
          // 点侧栏空白（非行/按钮/面板头）= 清空选中
          const target = event.target as HTMLElement;
          if (target.closest("[data-next-row], button, input, .sbx-row, .sbx-view")) return;
          clearSelection();
          // 聚焦态（库内树空间）点空白只清选中，不退出聚焦
          if (focusRootId) return;
          // 空白点击代表「不针对任何库」：库 Overview 的 URL 要退回空间根，
          // 否则主区还显示着某个库，与"什么都没选"的状态自相矛盾。
          if (state.route.kind === "kb") {
            const ws = getCurrentWorkspace();
            pushAppPathState(moduleAppPath("notebook", ws) ?? KB_ROOT_APP_PATH);
          }
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
        {sidebarView === "kb" && !openPluginPanel && (
          <SplitView
            itemIds={safeOrder as string[]}
            sizes={sectionHeights as Record<string, number>}
            onSizesChange={(next) => setSectionHeights(next as Partial<Record<SectionId, number>>)}
            collapsedIds={collapsedSections as ReadonlySet<string>}
            renderItem={(id) => {
              const sectionId = id as SectionId;
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
                  onDragOver={onSectionDragOver(sectionId)}
                  onDrop={onSectionDrop(sectionId)}
                  className={cn("h-full min-h-0 overflow-y-auto", shadowClass, isDraggingThis && "opacity-40")}
                >
                  {sectionMap[sectionId]}
                </div>
              );
            }}
          />
        )}

        {/* ===== 回收站视图 =====
             面板头 h-10：与主区回收站页的筛选行（40px）同一节奏，横线贯通对齐。
             职责 = 浏览 + 单条恢复/删除；清空、批量、筛选只在主区完整工作区。 */}
        {sidebarView === "trash" && (
          <div className="sbx-view">
            <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-app-border pl-2.5 pr-1.5 text-xs">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-tx-tertiary"><Trash2 size={13} /></span>
              <span className="min-w-0 truncate text-xs font-medium text-tx-primary">回收站</span>
            </div>
            {/* 类型多选：与主区共享同一份筛选（localStorage + nowen:trash-filter） */}
            <PanelSection
              label="类型 · 可多选"
              extra={<button type="button" className="text-[10.5px] text-accent-primary" onClick={() => setTrashTypeFilter(["all"])}>清除</button>}
            >
              <div className="grid grid-cols-2 gap-1">
                {(["all", ...TRASH_TYPE_META.map((meta) => meta.key)] as TrashTypeFilterKey[]).map((key) => {
                  const count = key === "all"
                    ? trashItems.length
                    : trashItems.filter((item) => trashTypeKey(item.resourceType, item.contentFormat) === key).length;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={trashFilter.includes(key)}
                      onClick={() => {
                        const next = key === "all" ? ["all" as TrashTypeKey]
                          : trashFilter.includes(key) ? trashFilter.filter((k) => k !== key) : [...trashFilter.filter((k) => k !== "all"), key];
                        setTrashTypeFilter(next.length ? next : ["all"]);
                      }}
                      className={`flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] ${trashFilter.includes(key) ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                    >
                      <span>{key === "all" ? "🗂" : TRASH_TYPE_META.find((meta) => meta.key === key)?.emoji}</span>
                      <span className="min-w-0 flex-1 truncate text-left">{key === "all" ? "全部" : TRASH_TYPE_META.find((meta) => meta.key === key)?.label}</span>
                      <span className="tabular-nums text-tx-tertiary">{count}</span>
                    </button>
                  );
                })}
              </div>
            </PanelSection>
            <PanelSection
              label="删除时间"
            >
              <div className="flex flex-wrap gap-1 px-1">
                {TRASH_TIME_META.filter((meta) => meta.key !== "older" || retentionDays > 30).map((meta) => (
                  <button
                    key={meta.key}
                    type="button"
                    aria-pressed={timeFilter === meta.key}
                    onClick={() => { setTimeFilterState(meta.key); setTrashTimeFilter(meta.key); }}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${timeFilter === meta.key ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                  >
                    {meta.label}
                  </button>
                ))}
              </div>
            </PanelSection>
            <PanelSection
              label="自动清理"
            >
              <div className="flex items-center justify-between px-1 py-1 text-[11.5px] text-tx-secondary">
                <span>保留期限</span>
                <span className="flex gap-1">
                  {TRASH_RETENTION_OPTIONS.map((days) => (
                    <button
                      key={days}
                      type="button"
                      aria-pressed={retentionDays === days}
                      onClick={() => { setRetentionDaysState(days); setRetentionDays(days); }}
                      className={`rounded-md border px-2 py-0.5 text-[11px] ${retentionDays === days ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                    >
                      {days} 天
                    </button>
                  ))}
                </span>
              </div>
              <div className="flex items-center justify-between px-1 py-1 text-[11.5px] text-tx-secondary">
                <span>到期前提醒我</span>
                <button
                  type="button"
                  aria-pressed={notifyExpiry}
                  aria-label="到期前提醒我"
                  onClick={() => { const next = !notifyExpiry; setNotifyExpiryState(next); setTrashSetting("notifyExpiry", next); }}
                  className={`relative h-[17px] w-[30px] rounded-full transition-colors ${notifyExpiry ? "bg-accent-primary" : "bg-app-border"}`}
                >
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${notifyExpiry ? "left-[15px]" : "left-0.5"}`} />
                </button>
              </div>
              <div className="flex items-center justify-between px-1 py-1 text-[11.5px] text-tx-secondary">
                <span>每周清理摘要</span>
                <button
                  type="button"
                  aria-pressed={weeklySummary}
                  aria-label="每周清理摘要"
                  onClick={() => { const next = !weeklySummary; setWeeklySummaryState(next); setTrashSetting("weeklySummary", next); }}
                  className={`relative h-[17px] w-[30px] rounded-full transition-colors ${weeklySummary ? "bg-accent-primary" : "bg-app-border"}`}
                >
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${weeklySummary ? "left-[15px]" : "left-0.5"}`} />
                </button>
              </div>
              <div className="px-1 pb-1 pt-0.5 text-[10px] leading-relaxed text-tx-tertiary">到期条目自动彻底删除；提醒走应用内通知与图标徽标</div>
            </PanelSection>
          </div>
        )}

        {/* ===== 项目管理视图 ===== */}
        {sidebarView === "projects" && (
          <div>
            <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-app-border pl-2.5 pr-1.5 text-xs">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-tx-tertiary"><KanbanSquare size={13} /></span>
              <span className="min-w-0 truncate text-xs font-medium text-tx-primary">项目管理</span>
            </div>
            {!panelCollapsed.projects && <ProjectsSidePanel onOpenMain={() => actions.setViewMode("projects")} />}
          </div>
        )}

        {/* ===== 分享管理视图 ===== */}
        {sidebarView === "shares" && (
          <div>
            <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-app-border pl-2.5 pr-1.5 text-xs">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-tx-tertiary"><Link2 size={13} /></span>
              <span className="min-w-0 truncate text-xs font-medium text-tx-primary">分享管理</span>
            </div>
            {!panelCollapsed.shares && <SharesSidePanel onOpenMain={() => actions.setViewMode("shares")} />}
          </div>
        )}

        {/* ===== 文件管理视图 =====
             侧栏 = 来源选择 + 该来源的筛选/设置；列表与批量在主区。 */}
        {sidebarView === "files" && (
          <div className="sbx-view">
            <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-app-border pl-2.5 pr-1.5 text-xs">
              <Inbox size={14} className="shrink-0 text-tx-tertiary" />
              <span className="min-w-0 truncate text-xs font-medium text-tx-primary">文件管理</span>
            </div>
            {/* 来源：统一文件池（本地附件 + 原图床文件）+ 远程文件（认证模型不同，保持独立入口） */}
            <div className="border-b border-app-border px-2 py-1.5">
              <div className="px-1 pb-1 text-[10.5px] text-tx-tertiary">来源</div>
              <div className="space-y-1">
                {([["all", "📁", "文件"], ...(isBuiltinPluginEnabled("remote-files") ? [["remote", "☁️", "远程文件"]] : [])] as Array<[FilesSource, string, string]>).map(([key, emoji, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={getFilesSource() === key}
                    onClick={() => setFilesUi({ source: key })}
                    className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-[11.5px] ${getFilesSource() === key ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                  >
                    <span>{emoji}</span>
                    <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                    {/* 角标：统一文件总数（远程文件的条目数由面板自管，不在此统计） */}
                    {key === "all" && fileStats && (
                      <span className="tabular-nums text-tx-tertiary">{fileStats.total}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            {getFilesSource() !== "remote" && (<>
            <div className="border-b border-app-border px-2 py-1.5">
              <div className="px-1 pb-1 text-[10.5px] text-tx-tertiary">分类</div>
              <div className="space-y-1">
                {([["all", "🗂 全部"], ["myUploads", "📤 我的上传"], ["referenced", "📄 文档引用"], ["unreferenced", "✨ 未引用"]] as Array<[string, string]>).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={getFilesCategory() === key}
                    onClick={() => setFilesUi({ category: key })}
                    className={`flex w-full items-center rounded-md border px-2 py-1 text-[11.5px] ${getFilesCategory() === key ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                    title={key === "referenced" ? "被至少一篇笔记正文引用着的附件" : key === "unreferenced" ? "没被任何笔记正文引用的附件（手动上传的会显示盾牌，不会被自动清理）" : undefined}
                  >
                    {label}
                    {fileStats && <span className="ml-auto tabular-nums text-tx-tertiary">{
                      key === "all" ? fileStats.total
                      : key === "myUploads" ? fileStats.myUploads?.total ?? 0
                      : key === "referenced" ? fileStats.referenced?.count ?? 0
                      : fileStats.unreferenced?.count ?? 0}</span>}
                  </button>
                ))}
              </div>
            </div>
            {/* 分享状态：只看生效中（未关闭且未过期）的只读分享链接。 */}
            <div className="border-b border-app-border px-2 py-1.5">
              <div className="px-1 pb-1 text-[10.5px] text-tx-tertiary">分享状态</div>
              <div className="flex flex-wrap gap-1 px-1">
                {FILE_SHARE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={getFilesShare() === opt.value}
                    onClick={() => setFilesUi({ share: opt.value })}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${getFilesShare() === opt.value ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                    title={opt.value === "shared" ? fileStats ? `已分享 · ${fileStats.shared?.count ?? 0} 个` : undefined : undefined}
                  >{opt.label}</button>
                ))}
              </div>
            </div>
            <div className="border-b border-app-border px-2 py-1.5">
              <div className="px-1 pb-1 text-[10.5px] text-tx-tertiary">上传时间</div>
              <div className="flex flex-wrap gap-1 px-1">
                {([["all", "全部"], ["today", "今天"], ["week", "近 7 天"], ["month", "近 30 天"]] as Array<[string, string]>).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={getFilesTime() === key}
                    onClick={() => setFilesUi({ time: key })}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${getFilesTime() === key ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                  >{label}</button>
                ))}
              </div>
            </div>
            <div className="border-b border-app-border px-2 py-1.5">
              <div className="px-1 pb-1 text-[10.5px] text-tx-tertiary">排序</div>
              <div className="flex flex-wrap gap-1 px-1">
                {FILE_SORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={getFilesSort() === opt.value}
                    onClick={() => setFilesUi({ sort: opt.value })}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${getFilesSort() === opt.value ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                  >{opt.label}</button>
                ))}
              </div>
            </div>
            <div className="border-b border-app-border px-2 py-1.5">
              <div className="px-1 pb-1 text-[10.5px] text-tx-tertiary">展示</div>
              <div className="grid grid-cols-2 gap-1 px-1">
                {([["list", "📃 列表"], ["grid", "▦ 网格"]] as Array<[FilesViewMode, string]>).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={getFilesViewMode() === mode}
                    onClick={() => setFilesUi({ view: mode })}
                    className={`rounded-md border px-2 py-1 text-[11px] ${getFilesViewMode() === mode ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                  >{label}</button>
                ))}
              </div>
              <div className="mt-1 grid grid-cols-3 gap-1 px-1">
                {([["flat", "扁平"], ["notebook", "按库"], ["folder", "按文件夹"]] as Array<[FilesGroupMode, string]>).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={getFilesGroupMode() === mode}
                    onClick={() => setFilesUi({ group: mode })}
                    className={`rounded-md border px-1 py-1 text-[11px] ${getFilesGroupMode() === mode ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                  >{label}</button>
                ))}
              </div>
            </div>
            </>)}
            {getFilesSource() === "remote" && (<>
            <div className="border-b border-app-border px-2 py-1.5">
              <div className="px-1 pb-1 text-[10.5px] text-tx-tertiary">类型 <button type="button" className="text-accent-primary" onClick={() => setFilesUi({ remoteTypes: [] })}>清除</button></div>
              <div className="flex flex-wrap gap-1 px-1">
                {FILE_REMOTE_TYPE_CHIPS.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    aria-pressed={getFilesRemoteTypes().includes(chip.key)}
                    onClick={() => {
                      const current = getFilesRemoteTypes();
                      setFilesUi({ remoteTypes: current.includes(chip.key) ? current.filter((t) => t !== chip.key) : [...current, chip.key] });
                    }}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${getFilesRemoteTypes().includes(chip.key) ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                  >{chip.label}</button>
                ))}
              </div>
            </div>
            <div className="border-b border-app-border px-2 py-1.5">
              <div className="px-1 pb-1 text-[10.5px] text-tx-tertiary">排序</div>
              <div className="flex flex-wrap gap-1 px-1">
                {FILE_REMOTE_SORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={getFilesRemoteSort() === opt.value}
                    onClick={() => setFilesUi({ remoteSort: opt.value as FilesRemoteSortKey })}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${getFilesRemoteSort() === opt.value ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                  >{opt.label}</button>
                ))}
              </div>
            </div>
            <PanelSection label="修改时间">
              <div className="flex flex-wrap gap-1 px-1">
                {([["all", "全部"], ["today", "今天"], ["week", "近 7 天"], ["month", "近 30 天"], ["older", "更早"]] as Array<[string, string]>).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={getFilesRemoteTime() === key}
                    onClick={() => setFilesUi({ remoteTime: key })}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${getFilesRemoteTime() === key ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary" : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover"}`}
                  >{label}</button>
                ))}
              </div>
            </PanelSection>
            </>)}
          </div>
        )}

        {/* ===== 插件视图 ===== */}
        {sidebarView === "plugins" && (
          <div className="sbx-view">
            <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-app-border pl-2.5 pr-1.5 text-xs">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-tx-tertiary"><Puzzle size={13} /></span>
              <span className="min-w-0 truncate text-xs font-medium text-tx-primary">插件</span>
            </div>
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
          <MenuSurface
            className="fixed z-[100] w-[188px]"
            style={{ left: kbMoreOpen.x, top: kbMoreOpen.y }}
          >
            <MenuLabel>排序方式</MenuLabel>
            {KNOWLEDGE_TREE_SORT_OPTIONS.map((option) => (
              <MenuItem
                key={option.value}
                label={option.label}
                checked={sortMode === option.value}
                onClick={() => { applySortMode(option.value); setKbMoreOpen(null); }}
              />
            ))}
            <MenuSeparator />
            <MenuItem
              icon={isAnyFolderExpanded(nodes, expanded) ? ChevronsDownUp : ChevronsUpDown}
              label={isAnyFolderExpanded(nodes, expanded) ? "折叠全部" : "展开全部"}
              onClick={() => { toggleAllFolders(); setKbMoreOpen(null); }}
            />
            <MenuItem
              icon={RefreshCw}
              label="刷新"
              onClick={() => { void reload(); setKbMoreOpen(null); }}
            />
          </MenuSurface>
        </>
      )}

      {/* ===== 标签 ⋮ 更多菜单（折叠全部/刷新） ===== */}
      {tagsMoreOpen && (
        <>
          <div className="fixed inset-0 z-[95]" onPointerDown={() => setTagsMoreOpen(null)} />
          <MenuSurface
            className="fixed z-[100] w-[188px]"
            style={{ left: tagsMoreOpen.x, top: tagsMoreOpen.y }}
          >
            <MenuLabel>标签</MenuLabel>
            <MenuItem
              icon={tags.some((tg) => tagsExpanded.has(tg.id)) ? ChevronsDownUp : ChevronsUpDown}
              label={tags.some((tg) => tagsExpanded.has(tg.id)) ? "折叠全部标签文档" : "展开全部标签文档"}
              onClick={() => { toggleAllTagDocs(); setTagsMoreOpen(null); }}
            />
            <MenuItem
              icon={RefreshCw}
              label="刷新"
              onClick={() => { void reloadTags(); setTagsMoreOpen(null); }}
            />
          </MenuSurface>
        </>
      )}

      {/* ===== 创建空间对话框 ===== */}
      {createOpen && (
        <CreateWorkspaceDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(workspace) => {
            setCreateOpen(false);
            api.getWorkspaces().then((list) => setWorkspaces(list)).catch(() => undefined);
            switchSpace(workspace.id);
          }}
        />
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

      {/* ===== 当前空间管理（成员/邀请/功能） ===== */}
      {manageOpen && activeWorkspace && (
        <MembersPanel
          workspaceId={activeWorkspace.id}
          onClose={() => {
            setManageOpen(false);
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
        <MenuSurface
          ref={menuRef}
          className="fixed z-[100]"
          style={menuStyle}
        >
          {rowMenu.kind === "sec-kb" && (
            <>
              <MenuLabel>知识库</MenuLabel>
              <MenuItem icon={ChevronsUpDown} label="全部展开" onClick={() => { setRowMenu(null); expandAllFolders(); }} />
              <MenuItem icon={ChevronsDownUp} label="全部折叠" onClick={() => { setRowMenu(null); collapseAllFolders(); }} />
            </>
          )}
          {rowMenu.kind === "kb-folder" && (() => {
            const node = nodes.find((n) => n.id === rowMenu.nodeId);
            if (!node) return null;
            return (
              <>
                {/* 与区块头 ＋ 同一个菜单：列出全部新建格式（富文本/Markdown/纯文本/
                    画板/导图/模板/文件夹/表格/加密/导入），不再另写一套简化版 */}
                <MenuItem
                  icon={FilePlus2}
                  label="新建…"
                  onClick={() => {
                    const anchor = new DOMRect(rowMenu.x, rowMenu.y, 0, 0);
                    setRowMenu(null);
                    setCreateMenuState({ parentId: node.id, anchor });
                  }}
                />
                <MenuSeparator />
                {/* 与文档菜单对齐：复制 / 移动 / 导出 / 分享 都是目录的一级动作 */}
                <MenuItem icon={Copy} label="复制" onClick={() => { setRowMenu(null); void duplicateFolderNode(node); }} />
                <MenuItem icon={FolderInput} label="移动到…" onClick={() => { setRowMenu(null); setMoveNodeId(node.id); }} />
                <MenuItem
                  icon={Download}
                  label="导出"
                  children={NOTEBOOK_EXPORT_FORMAT_ITEMS.map((item) => ({
                    id: `export_folder_${item.id}`,
                    label: item.label,
                    onClick: () => { setRowMenu(null); void exportFolderNode(node, item.id); },
                  }))}
                />
                {(() => {
                  const notebook = (state.notebooks ?? []).find((nb) => nb.id === node.resourceId);
                  return notebook ? (
                    <MenuItem
                      icon={Share2}
                      label="分享与发布"
                      onClick={() => { setRowMenu(null); setShareNotebook(notebook); }}
                    />
                  ) : null;
                })()}
                <MenuSeparator />
                <MenuItem icon={Pencil} label="重命名" hint="F2" onClick={() => { setRowMenu(null); setRenaming({ kind: "kb", id: node.id, value: node.title }); }} />
                <MenuItem icon={Trash2} label="删除" hint="Del" danger onClick={() => { setRowMenu(null); void deleteNode(node.id); }} />
              </>
            );
          })()}
          {rowMenu.kind === "kb-note" && (() => {
            const node = nodes.find((n) => n.id === rowMenu.nodeId);
            if (!node) return null;
            return (
              <>
                {/* 分屏入口：从侧栏直接打开第二篇文档（等宽左右分屏，点哪栏哪栏成为主编辑栏） */}
                <MenuItem
                  icon={Columns2}
                  label="在右侧分屏打开"
                  onClick={() => {
                    setRowMenu(null);
                    actions.splitEditor({ noteId: node.resourceId, direction: "right" });
                  }}
                />
                <MenuSeparator />
                {/* 语雀式文档菜单：复制 / 移动 / 导出 / 分享 都在一级，不再埋进“更多”。
                    文件节点（resourceType=file）不参与这三类文档动作。 */}
                {node.resourceType === "note" && !node.isReference && (
                  <MenuItem icon={Copy} label="复制" onClick={() => { setRowMenu(null); void duplicateNoteNode(node); }} />
                )}
                <MenuItem icon={FolderInput} label="移动到…" onClick={() => { setRowMenu(null); setMoveNodeId(node.id); }} />
                {node.resourceType === "note" && (
                  <>
                    <MenuItem
                      icon={Download}
                      label="导出"
                      children={[
                        { id: "export_note_md", label: "Markdown", icon: FileText, onClick: () => { setRowMenu(null); void exportNoteNode(node, "export_note_md"); } },
                        { id: "export_note_md_zip", label: "Markdown + 附件 ZIP", icon: FileArchive, onClick: () => { setRowMenu(null); void exportNoteNode(node, "export_note_md_zip"); } },
                        { id: "export_note_pdf", label: "PDF", icon: Printer, onClick: () => { setRowMenu(null); void exportNoteNode(node, "export_note_pdf"); } },
                        { id: "export_note_png", label: "PNG", icon: ImageIcon, onClick: () => { setRowMenu(null); void exportNoteNode(node, "export_note_png"); } },
                        { id: "export_note_jpg", label: "JPG", icon: ImageIcon, onClick: () => { setRowMenu(null); void exportNoteNode(node, "export_note_jpg"); } },
                        { id: "export_note_word", label: "Word", icon: FileType2, onClick: () => { setRowMenu(null); void exportNoteNode(node, "export_note_word"); } },
                      ]}
                    />
                    <MenuItem icon={Share2} label="分享" onClick={() => { setRowMenu(null); setShareNote({ id: node.resourceId, title: node.title }); }} />
                  </>
                )}
                <MenuSeparator />
                <MenuItem icon={Pencil} label="重命名" hint="F2" onClick={() => { setRowMenu(null); setRenaming({ kind: "kb", id: node.id, value: node.title }); }} />
                <MenuSeparator />
                <MenuItem
                  icon={Trash2}
                  label={node.isReference ? "删除这条路径" : "删除"}
                  hint="Del"
                  danger
                  onClick={() => { setRowMenu(null); void deleteNode(node.id); }}
                />
              </>
            );
          })()}
          {rowMenu.kind === "tag-group" && (() => {
            const tag = tags.find((tg) => tg.id === rowMenu.tagId);
            if (!tag) return null;
            return (
              <>
                <MenuItem icon={Pencil} label="重命名" onClick={() => { setRowMenu(null); setRenaming({ kind: "tag", id: tag.id, value: tag.name }); }} />
                <MenuSeparator />
                <MenuItem icon={Trash2} label="删除标签" danger onClick={() => { setRowMenu(null); void deleteTag(tag.id); }} />
              </>
            );
          })()}
          {rowMenu.kind === "tag-doc" && (() => {
            const doc = (tagDocs[rowMenu.tagId ?? ""] ?? []).find((d) => d.id === rowMenu.docId);
            if (!doc) return null;
            return (
              <>
                <MenuItem icon={Locate} label="在树中定位" onClick={() => void locateDoc(doc.title)} />
                <MenuItem icon={Pencil} label="重命名" hint="F2" onClick={() => { setRowMenu(null); setRenaming({ kind: "kb", id: doc.id, value: doc.title }); }} />
                <MenuSeparator />
                <MenuItem icon={Trash2} label="删除" hint="Del" danger onClick={() => { setRowMenu(null); void deleteNode(doc.id); }} />
              </>
            );
          })()}
        </MenuSurface>
      )}

      {/* ===== 行菜单触发的移动面板（侧栏内直接选目标目录，支持文档与文件夹） ===== */}
      {moveNodeId && (() => {
        const target = nodes.find((node) => node.id === moveNodeId && !node.isDeleted);
        if (!target) return null;
        return (
          <KnowledgeTreeBatchMovePanel
            selectedNodes={[target]}
            nodes={nodes}
            targetNodes={nodes}
            onMoved={() => { setMoveNodeId(null); void reload(); }}
            onClose={() => setMoveNodeId(null)}
          />
        );
      })()}

      {/* ===== 行菜单触发的分享弹窗 ===== */}
      {shareNote && (
        <ShareModal
          noteId={shareNote.id}
          noteTitle={shareNote.title}
          onClose={() => setShareNote(null)}
        />
      )}
      {shareNotebook && (
        <NotebookShareDialog notebook={shareNotebook} onClose={() => setShareNotebook(null)} />
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
