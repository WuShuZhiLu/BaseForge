/**
 * 文件管理中心（ViewMode=files）
 * ---------------------------------------------------------------------------
 * 定位：
 *   跨笔记的"相册 + 文件柜"。本页面**不新增存储**——直接消费后端
 *   /api/files 聚合视图，复用已有的 attachments 表 + ATTACHMENTS_DIR。
 *
 * 布局（与 TaskWorkspace 同构，沿用 flex 高度 + ScrollArea）：
 *   ┌── 顶栏：标题 / 统计徽标 / 上传按钮 / 视图切换 ──────────┐
 *   ├── 工具条：分类 Tabs / 搜索 / 排序 ─────────────────────┤
 *   ├── 主区：
 *   │    - 图片优先走 Grid（响应式 auto-fill minmax）
 *   │    - 文件 / 混合视图走紧凑列表（含 MIME 图标、大小、来源笔记）
 *   │   均支持：点击打开详情抽屉
 *   ├── 详情抽屉（右侧）：
 *   │    - 预览（图片直接 <img>、其他给下载链接）
 *   │    - 元信息（filename、mime、size、createdAt）
 *   │    - 引用列表（references[]，点"跳转"切回对应笔记）
 *   │    - 删除按钮（二次确认）
 *   └── 空态：区分"零文件"与"筛选无结果"，文案不同
 *
 * 反向跳转：
 *   点 "跳转到笔记" → api.getNote(id) → setActiveNote + setViewMode("all")；
 *   复用 AppContext，与 SidebarMobile / NoteList 的跳转路径一致。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import RemoteFilesPanel from "@/components/RemoteFilesPanel";
import type { RemoteSourcePublic } from "@/types";
import { motion, AnimatePresence } from "framer-motion";
import {
  Cloud,
  Upload,
  UploadCloud,
  X,
  Trash2,
  Search,
  LayoutGrid,
  List,
  Image as ImageIcon,
  FileText,
  FileArchive,
  FileCode,
  FileAudio,
  FileVideo,
  Play,
  FileSpreadsheet,
  ExternalLink,
  Download,
  Loader2,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Inbox,
  Copy,
  Check,
  CheckSquare,
  Square,
  Share2,
  Link2,
  MoreHorizontal,
  ArrowDownUp,
  RefreshCw,
} from "lucide-react";
import { api, resolveAttachmentUrl } from "@/lib/api";
import { useToolPageActive, type ToolPageHeaderMode } from "@/lib/toolPage";
import { navigateToolPage } from "@/components/toolTabs";

/** 页签契约：页面自带标题行（附件管理顶栏），宿主顶栏无需重复渲染。 */
export const TOOL_PAGE_HEADER_MODE: ToolPageHeaderMode = "own";

import { FileItem, FileStats } from "@/types";
import { FILE_SORT_OPTIONS, FILE_TYPE_CHIPS, MIME_CATEGORY_LABELS, getFilesCategory, getFilesGroupMode, getFilesShare, getFilesSort, getFilesSource, getFilesTime, getFilesTypes, getFilesUiVersion, getFilesViewMode, resolveMimeCategory, setFilesUi, subscribeFilesUi } from "@/features/files/filesUi";
import type { FilesTypeFilter, FilesViewMode } from "@/features/files/filesUi";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAppActions } from "@/store/AppContext";
import { toast } from "@/lib/toast";
import { confirm as confirmDialog } from "@/components/ui/confirm";
import { copyText } from "@/lib/clipboard";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { buildPublicAttachmentUrl } from "@/lib/publicAttachmentUrl";
import { downloadAttachment } from "@/lib/downloadFile";
import {
  formatFileLinkSnippet,
  fileLinkFormatLabel,
  type FileLinkFormat,
} from "@/lib/fileLinkFormats";
import AttachmentDetailDrawer from "@/components/attachmentDetail/AttachmentDetailDrawer";
import FileUploadDialog from "@/components/FileUploadDialog";
import {
  attachmentShareApi,
  buildAttachmentShareUrl,
} from "@/lib/attachmentShareApi";
import { focusShareCenter } from "@/features/shares/shareCenterUi";

// ---------------------------------------------------------------------------
// 工具：文件大小可读化 / MIME → 图标 / 时间格式化
// ---------------------------------------------------------------------------

/** 把字节数转成 "1.23 MB" / "456 KB" 等可读字符串，与 DataManager 风格一致。 */
function humanSize(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let v = bytes;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }
  return `${v.toFixed(v >= 10 || idx === 0 ? 0 : 2)} ${units[idx]}`;
}

/** 根据 MIME 返回一个合适的 lucide 图标（非图片场景）。 */
function mimeIcon(mime: string): React.ReactNode {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return <ImageIcon size={20} />;
  if (m.startsWith("audio/")) return <FileAudio size={20} />;
  if (m.startsWith("video/")) return <FileVideo size={20} />;
  if (m === "application/zip" || m === "application/x-rar-compressed" || m === "application/x-7z-compressed" || m === "application/gzip")
    return <FileArchive size={20} />;
  if (
    m === "application/vnd.ms-excel" ||
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    m === "text/csv"
  )
    return <FileSpreadsheet size={20} />;
  if (
    m === "application/json" ||
    m === "text/javascript" ||
    m === "application/javascript" ||
    m === "text/x-python" ||
    m === "text/typescript" ||
    m === "text/html" ||
    m === "text/css"
  )
    return <FileCode size={20} />;
  return <FileText size={20} />;
}

/** 按本地时区格式化 "YYYY-MM-DD HH:mm"。createdAt 是 sqlite datetime('now')——UTC naive。 */
function formatLocalTime(s: string): string {
  if (!s) return "";
  // SQLite 的 datetime('now') 返回 "YYYY-MM-DD HH:mm:ss"（UTC，不带 Z），
  // 直接 new Date() 会当本地时间解析 → 本地显示就会晚 8h。显式拼 Z 再格式化。
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/**
 * UI 侧的范围筛选（与类型维度正交）：
 *   - "all"          全部文件
 *   - "myUploads"    我的上传（用户从文件管理页直接上传的附件，
 *                    实现上 = attachments.uploadSource = 'file_manager'）
 *   - "referenced"   文档引用（正文里引用过的附件，走 filter=referenced）
 *   - "unreferenced" 未引用视图（走 filter=unreferenced；与上一项严格互补，相加=全部）
 */
type CategoryFilter = "all" | "myUploads" | "referenced" | "unreferenced";

/**
 * "我的上传"内部的二级子筛选。仅在 category="myUploads" 时生效。
 *   - "all"          ：我的上传全部
 *   - "referenced"   ：已经被任意笔记引用过的
 *   - "unreferenced" ：还没被任何笔记引用过的
 */
type MyUploadsRefFilter = "all" | "referenced" | "unreferenced";

// ---------------------------------------------------------------------------
// 分页大小（每页条数）
// ---------------------------------------------------------------------------
// - 默认 10：与笔记列表 / 任务列表的视觉密度对齐，首屏更轻；
// - 提供 10 / 20 / 50 / 100 四档，覆盖"日常翻阅"到"批量整理"的全频谱；
// - 用户选择会持久化到 localStorage（per-device），避免每次进文件管理都要重选；
// - 切档时回到第 1 页（避免在第 5 页/小档切到大档后落到一个空页）。
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_STORAGE_KEY = "nowen.fileManager.pageSize";

/** 从 localStorage 读出上次选择的 pageSize；非法/缺失时回退默认值。 */
function readStoredPageSize(): number {
  if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
  try {
    const raw = window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
    if (!raw) return DEFAULT_PAGE_SIZE;
    const n = Number.parseInt(raw, 10);
    if (PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number])) {
      return n;
    }
    return DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

// ---------------------------------------------------------------------------
// 列表缓存（v12 性能优化）
// ---------------------------------------------------------------------------
// 背景：
//   翻页 / 切分类 / 搜索后再切回来时，原本每次都打一次后端 API。在图床场景下
//   后端要做 JOIN notes/notebooks + COUNT，加上 stats 也要全表统计，单页响应
//   通常 80~250ms。一个简单的 30s TTL 缓存就能把"切回上一页"做到秒开。
//
// 策略：
//   - 模块级 Map（FileManager 实例销毁后下次进来仍然命中，体感更好）；
//   - cacheKey 是 list 的所有筛选参数（类型/范围/时间/排序/搜索/分页）+ workspace 作用域；
//   - TTL 30s：足够覆盖典型"翻页 → 看图 → 切回上一页"的窗口；
//   - 写动作（删除 / 上传 / 重命名）会调用 invalidateFileListCache() 清空，
//     避免显示陈旧数据。
//   - "孤儿"视图（filter=unreferenced）也走缓存，符合预期：30s 内一次扫描结果。
//
// 不上 react-query 的取舍：项目 api.ts 没用任何数据获取库，引入 react-query
//   要在多个组件里同时改造才一致；当前只为这一处优化引入大依赖不划算。
interface CachedListEntry {
  items: FileItem[];
  total: number;
  ts: number;
}
const fileListCache = new Map<string, CachedListEntry>();
const FILE_LIST_CACHE_TTL_MS = 30_000;

function readFileListCache(key: string): CachedListEntry | null {
  const entry = fileListCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > FILE_LIST_CACHE_TTL_MS) {
    fileListCache.delete(key);
    return null;
  }
  return entry;
}

function writeFileListCache(key: string, value: CachedListEntry): void {
  // 软上限：超过 64 个 key 时整体清空（图床场景翻页参数组合有限，
  // 64 已经远超日常操作）。LRU 不值得为这点收益引入。
  if (fileListCache.size > 64) fileListCache.clear();
  fileListCache.set(key, value);
}

/** 任何修改附件的操作（删除 / 上传 / 重命名）都应调用这个函数，避免读到陈旧列表。 */
function invalidateFileListCache(): void {
  fileListCache.clear();
}



export default function FileManager() {
  const { t } = useTranslation();
  const actions = useAppActions();

  // 列表状态
  // 远程文件是内核能力（WebDAV / SMB / 百度网盘），经侧栏「来源」切换，
  // 主区不再重复提供入口，也没有启用/停用开关。
  const [items, setItems] = useState<FileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<FileStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  // 每页条数：默认 10，从 localStorage 恢复上次选择，跨会话保留。
  const [pageSize, setPageSize] = useState<number>(() => readStoredPageSize());

  // 筛选 / 搜索：分类/排序/视图/分组由侧栏 filesUi 驱动（useSyncExternalStore 派生，见下方）
  // "我的上传"内部的二级子筛选；仅在 category === "myUploads" 时参与请求。
  const [myUploadsRef, setMyUploadsRef] = useState<MyUploadsRefFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState(""); // debounced
  // 工具行右端排序下拉（对齐分享页「排序：xxx ▾」，选项复用 FILE_SORT_OPTIONS）
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  // 「⋯ 更多」菜单：收纳低频操作（清理/刷新/视图/分组），单行工具栏的一部分
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  // 排序菜单的外部点击关闭
  useEffect(() => {
    if (!sortMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) setSortMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [sortMenuOpen]);

  // 更多菜单的外部点击关闭
  useEffect(() => {
    if (!moreMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) setMoreMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [moreMenuOpen]);


  // 附件文件夹列表（groupMode === "folder" 时使用）
  const [attachmentFolders, setAttachmentFolders] = useState<Array<{ id: string; name: string; fileCount: number }>>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("nowen-file-collapsed-groups");
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem("nowen-file-collapsed-groups", JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // 来源/分类/排序/视图/分组：全部由侧栏 filesUi 驱动，useSyncExternalStore 保证
  // 任何一端修改必然触发本组件重渲染（版本号变化）。
  const filesUiVersion = useSyncExternalStore(subscribeFilesUi, getFilesUiVersion);
  void filesUiVersion; // 仅为订阅；实际值在渲染期从 getter 读取
  const source = getFilesSource();
  const isRemoteSource = source === "remote";
  const sourceTab = isRemoteSource ? "remote" : "local";
  // 统一文件池：类型（图片/视频/音频/文档/其他）是筛选维度而非分隔容器；
  // 范围（全部/我的上传/未引用）与它正交，两者可叠加。
  const typeFilter = getFilesTypes();
  /** "all" 或空 = 不筛；多选时逗号串传后端（后端支持列表 OR）。 */
  const typeFilterActive = !typeFilter.includes("all");
  const mimeCategoryParam = typeFilterActive ? typeFilter.join(",") : undefined;
  const category = getFilesCategory() as CategoryFilter;
  /** 分享状态（侧栏「分享状态」chips）：all = 不筛。 */
  const shareFilter = getFilesShare();
  const sort = getFilesSort();
  const viewMode: FilesViewMode = getFilesViewMode();
  const groupMode = getFilesGroupMode();

  // 详情抽屉
  // detailId 为 null 时抽屉关闭；非 null 由 AttachmentDetailDrawer 自己加载详情。
  const [detailId, setDetailId] = useState<string | null>(null);
  // 已开启分享（isActive）的附件 id 集合：卡片"已分享"角标的数据源。
  // 注：公开直链对所有附件都可用，这里的"已分享"指用户主动建过分享链接。
  const [sharedIds, setSharedIds] = useState<Set<string>>(new Set());
  // 已建过分享记录的附件 id（含已关闭的）：行内「分享」据此判断要不要先建一条。
  const [shareRecordIds, setShareRecordIds] = useState<Set<string>>(new Set());
  const loadShares = useCallback(async () => {
    try {
      const rows = await attachmentShareApi.list();
      setSharedIds(new Set(rows.filter((row) => row.isActive).map((row) => row.attachmentId)));
      setShareRecordIds(new Set(rows.map((row) => row.attachmentId)));
    } catch {
      // 角标不是关键路径，失败静默，不打扰用户
    }
  }, []);
  useEffect(() => { void loadShares(); }, [loadShares]);

  /**
   * 行内「分享」入口：跳到分享中心并打开同一抽屉（原型落地顺序第 3 条），
   * 不再另开一套对话框。没有分享记录时先用统一默认值（7 天）建一条，
   * 等价于旧对话框里的「开启分享」；已存在记录则绝不能调 open()——
   * 空 body 会把密码、有效期、次数上限全部覆盖。
   */
  const openShare = useCallback(async (attachmentId: string) => {
    if (!shareRecordIds.has(attachmentId)) {
      try {
        await attachmentShareApi.open(attachmentId, {});
        void loadShares();
      } catch (error) {
        toast.error(errMsg(error, "开启分享失败"));
        return;
      }
    }
    focusShareCenter({ channel: "attachment_share", objectId: attachmentId });
    actions.setActiveToolTab("shares");
  }, [actions, loadShares, shareRecordIds]);

  // 上传
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);

  // 批量选择
  // - selectionMode 决定 UI 是否进入"多选"形态：卡片左上出现 checkbox、
  //   工具条上方显示选择栏、点击卡片不再打开详情而是切换勾选。
  // - selectedIds 用 Set 维护，便于 O(1) 增删；切分类/换页/退出选择模式
  //   会自动清空。
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchMoving, setBatchMoving] = useState(false);
  const [batchSharing, setBatchSharing] = useState(false);

  // 可回收空间（dryRun 扫出的"孤儿附件"汇总）：
  //   顶部清理按钮始终可见；有可回收项时附带展示数量与空间。
  //   挂载/上传/删除/清空回收站之后都会刷新。
  //   不做轮询——只在明显会改变占用的操作后刷，避免 N+1 请求。
  const [reclaimable, setReclaimable] = useState<{ items: number; bytes: number } | null>(null);
  const [cleaningUp, setCleaningUp] = useState(false);

  // ---- 搜索防抖（300ms，避免每个字都打接口）----
  useEffect(() => {
    const h = setTimeout(() => {
      setSearchQuery(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(h);
  }, [searchInput]);

  // ---- 拉统计（只在挂载 + 上传/删除后刷新，成本较小）----
  const loadStats = useCallback(async () => {
    try {
      const s = await api.files.stats();
      setStats(s);
    } catch (err) {
      console.error("[FileManager] stats failed:", err);
    }
  }, []);

  // ---- 扫描可回收空间（dryRun，不真改 DB/磁盘）----
  // 走后端新增的 cleanup-orphans?dryRun=1，一次返回 DB 孤儿 + 内容孤儿 +
  // 磁盘孤儿的合计字节数与数量。成本可接受（只扫 content，不写磁盘）。
  const loadReclaimable = useCallback(async () => {
    try {
      const res = await api.dataFile.cleanupOrphans({ dryRun: true });
      setReclaimable({ items: res.totalRemovedItems, bytes: res.totalFreedBytes });
    } catch (err) {
      // 扫描失败不打扰用户——徽标就不出现
      console.warn("[FileManager] reclaimable scan failed:", err);
      setReclaimable(null);
    }
  }, []);

  useEffect(() => {
    loadStats();
    loadReclaimable();
  }, [loadStats, loadReclaimable]);

  // ---- 加载附件文件夹列表 ----
  const loadFolders = useCallback(async () => {
    try {
      const res = await api.attachmentFolders.list();
      setAttachmentFolders(res.folders || []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => { loadFolders(); }, [loadFolders]);

  // ---- 拉列表（受 category / sort / searchQuery / page 驱动）----
  const loadList = useCallback(async () => {
    // v12：客户端 30s TTL 缓存。命中即跳过 API 调用，秒开翻页。
    // cacheKey 包含全部筛选维度 + workspace，保证不同场景互不串台。
    const cacheKey = JSON.stringify({
      c: category,
      // 仅在 myUploads 范围下子筛选才有意义；其他范围固定写空串避免污染 key
      mur: category === "myUploads" ? myUploadsRef : "",
      t: typeFilter.join(","),
      sh: shareFilter,
      tf: getFilesTime(),
      s: sort,
      q: searchQuery,
      p: page,
      ps: pageSize,
      // 工作区切换会重新 mount FileManager，理论上 cache 跟着销毁，
      // 但模块级 Map 跨实例存活——把当前 workspace 加进 key 防误命中。
      // 直接读取 store 在这里不方便，简单起见用 location 作为代理（已包含 workspace 路径）。
      // 如果路由没把 workspace 放进 path 也没关系，30s TTL 自然降级。
      ws: typeof window !== "undefined" ? window.location.pathname : "",
    });
    const cached = readFileListCache(cacheKey);
    if (cached) {
      setItems(cached.items);
      setTotal(cached.total);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      // 统一文件池：类型走 mimeCategory（"全部"时不传），范围走 filter=...，
      // 分享状态走 shareStatus。三者正交可叠加（例如"未引用的视频"、
      // "已分享的图片"），后端一个 WHERE 子句同时收口。
      const apiFilter: "unreferenced" | "referenced" | "myUploads" | undefined =
        category === "unreferenced" || category === "referenced" || category === "myUploads"
          ? category
          : undefined;
      const res = await api.files.list({
        mimeCategory: mimeCategoryParam,
        filter: apiFilter,
        shareStatus: shareFilter === "all" ? undefined : shareFilter,
        uploadedWithin: getFilesTime() !== "all"
          ? ({ today: 1, week: 7, month: 30 } as Record<string, number>)[getFilesTime()] || undefined
          : undefined,
        myUploadsRef:
          category === "myUploads" && myUploadsRef !== "all" ? myUploadsRef : undefined,
        q: searchQuery || undefined,
        sort,
        page,
        pageSize,
      });
      setItems(res.items);
      setTotal(res.total);
      writeFileListCache(cacheKey, {
        items: res.items,
        total: res.total,
        ts: Date.now(),
      });
    } catch (err) {
      console.error("[FileManager] list failed:", err);
      toast.error(err instanceof Error ? err.message : "加载文件列表失败");
    } finally {
      setLoading(false);
    }
  }, [typeFilter, category, shareFilter, myUploadsRef, sort, searchQuery, page, pageSize, filesUiVersion]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // 隐藏态治理：keepAlive 非激活页签期间数据可能过期，重新激活时补一次列表刷新。
  const pageRootRef = useRef<HTMLDivElement>(null);
  const pageActive = useToolPageActive(pageRootRef);
  const previousPageActiveRef = useRef(true);
  useEffect(() => {
    if (previousPageActiveRef.current === pageActive) return;
    previousPageActiveRef.current = pageActive;
    if (pageActive) loadList();
  }, [pageActive, loadList]);

  // ---- 一键清理孤儿附件（走真 cleanup）----
  // 放在 loadList 之后声明，避免"使用前声明"的 TS 错误。
  const handleCleanupOrphans = useCallback(async () => {
    if (cleaningUp) return;
    setCleaningUp(true);
    try {
      // 点击后重新扫描，不依赖挂载时可能已过期的统计。
      const preview = await api.dataFile.cleanupOrphans({ dryRun: true });
      setReclaimable({ items: preview.totalRemovedItems, bytes: preview.totalFreedBytes });
      if (preview.totalRemovedItems === 0) {
        toast.success("当前没有可清理的未引用附件（最近 24 小时上传的附件会暂时保留）");
        return;
      }

      const ok = await confirmDialog({
        title: "确定清理未引用内容？",
        description: `本次将删除所有未被引用的内容：共 ${preview.totalRemovedItems} 个，预计释放约 ${humanSize(preview.totalFreedBytes)}。最近 24 小时上传的内容不会被清理。该操作不可撤销。`,
        confirmText: "立即清理",
        danger: true,
      });
      if (!ok) return;

      const res = await api.dataFile.cleanupOrphans({ dryRun: false });
      toast.success(
        `已清理 ${res.totalRemovedItems} 个附件，释放 ${humanSize(res.totalFreedBytes)}`,
      );
      // v12：清列表缓存（孤儿被删了，缓存里还在的话翻页会出现裂图）
      invalidateFileListCache();
      // 清理后刷新：列表 + 统计 + 可回收徽标
      setPage(1);
      loadList();
      loadStats();
      loadReclaimable();
      // 广播：可能有别的视图（DataManager 的存储面板）也要同步
      try {
        window.dispatchEvent(new CustomEvent("nowen:storage-changed", { detail: { reason: "cleanup-orphans" } }));
      } catch { /* ignore */ }
    } catch (err) {
      console.error("[FileManager] cleanup failed:", err);
      toast.error(err instanceof Error ? err.message : "清理失败");
    } finally {
      setCleaningUp(false);
    }
  }, [cleaningUp, loadList, loadStats, loadReclaimable]);

  // 工作区切换：清空多选 + 回到第 1 页，effect 链会自然触发 loadList/loadStats 重拉
  useEffect(() => {
    const onWs = () => {
      setSelectedIds(new Set());
      setPage(1);
      loadStats();
      loadReclaimable();
      loadList();
    };
    // 跨组件的"空间占用变了"通知（清空回收站 / 数据库维护 等场景发）
    const onStorage = () => {
      // v12：外部事件可能伴随附件被删，必须清缓存避免拿到陈旧条目
      invalidateFileListCache();
      loadStats();
      loadReclaimable();
      notifyStorageChanged();
      loadList();
    };
    window.addEventListener("nowen:workspace-changed", onWs);
    window.addEventListener("nowen:storage-changed", onStorage);
    return () => {
      window.removeEventListener("nowen:workspace-changed", onWs);
      window.removeEventListener("nowen:storage-changed", onStorage);
    };
  }, [loadStats, loadList, loadReclaimable]);

  // ---- 分类切换时重置到第 1 页 + 调整默认视图 ----


  // ---- 详情抽屉控制 ----
  // 加载逻辑下沉到 AttachmentDetailDrawer 内部，这里只负责打开/关闭。
  const openDetail = useCallback((id: string) => {
    setDetailId(id);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailId(null);
  }, []);

  // ---- 删除：列表层面同步（剔除 / 翻页 / 缓存 / 统计） ----
  // 抽屉删除走 onAfterDelete 路径；ListView 行内删除按钮先二次确认 → 调 api.files.remove
  // → 再走 afterDelete。两条路径共用同一份「列表后处理」。
  // 附件数量/存储变化 → 通知侧栏文件面板刷新计数
  const notifyStorageChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent("nowen:storage-changed", { detail: { reason: "file-manager" } }));
  }, []);

  const afterDelete = useCallback(
    (id: string) => {
      // 本地列表即时剔除（让 UI 立刻有反馈，不等接口往返）
      setItems((prev) => prev.filter((it) => it.id !== id));
      setTotal((t) => Math.max(0, t - 1));
      // v12：清缓存，避免 loadList 命中陈旧条目
      invalidateFileListCache();
      loadStats();
      loadReclaimable();
      notifyStorageChanged();
      // 关键：删除后必须重新拉当前页，把"被删项后面的"那一项从第 N+1 项
      // 顶上来，否则用户会看到当前页只剩 PAGE_SIZE-1 项，要切页才能看到
      // 后面被顶上来的文件。当前页若被删空且不在第 1 页 → 回退一页
      // （page 变化会自动触发 useEffect → loadList，这里不必手动调）。
      const willBeEmpty = items.length <= 1;
      if (willBeEmpty && page > 1) {
        setPage((p) => Math.max(1, p - 1));
      } else {
        loadList();
      }
    },
    [loadStats, loadReclaimable, loadList, items.length, page, notifyStorageChanged],
  );

  // ---- 附件另存到远程（内核能力：WebDAV / SMB / 百度网盘）----
  const [remoteSaveDlg, setRemoteSaveDlg] = useState<{ attachmentId: string; filename: string } | null>(null);
  const [remoteSaveSources, setRemoteSaveSources] = useState<RemoteSourcePublic[]>([]);
  const [remoteSaveSourceId, setRemoteSaveSourceId] = useState("");
  const [remoteSavePath, setRemoteSavePath] = useState("");
  const [remoteSaving, setRemoteSaving] = useState(false);
  const [remoteSaveMsg, setRemoteSaveMsg] = useState("");

  const openRemoteSave = useCallback(async (it: FileItem) => {
    setRemoteSaveDlg({ attachmentId: it.id, filename: it.filename });
    setRemoteSavePath(`/from-files/${it.filename}`);
    setRemoteSaveMsg("");
    try {
      const res = await api.getRemoteFileSources();
      setRemoteSaveSources(res.sources);
      setRemoteSaveSourceId((prev) => (prev && res.sources.some((s) => s.id === prev) ? prev : res.sources[0]?.id || ""));
    } catch {
      setRemoteSaveSources([]);
    }
  }, []);

  const submitRemoteSave = useCallback(async () => {
    if (!remoteSaveDlg || !remoteSaveSourceId) return;
    setRemoteSaving(true);
    setRemoteSaveMsg("");
    try {
      await api.saveAttachmentToRemote(remoteSaveSourceId, remoteSaveDlg.attachmentId, remoteSavePath);
      setRemoteSaveDlg(null);
      toast.success("已保存到远程源");
    } catch (err) {
      setRemoteSaveMsg(err instanceof Error ? err.message : "保存到远程失败");
    } finally {
      setRemoteSaving(false);
    }
  }, [remoteSaveDlg, remoteSaveSourceId, remoteSavePath]);

  // ListView 行内删除按钮入口：自带二次确认 + 网络请求 + afterDelete。
  const handleDelete = useCallback(
    async (id: string) => {
      const ok = await confirmDialog({
        title: "确定要删除此文件吗？",
        description:
          "删除后，引用该文件的笔记里将显示为破图 / 失效链接。该操作不可撤销。",
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.files.remove(id);
        toast.success("已删除");
        // 如果当前打开的就是这个详情，顺手关掉
        setDetailId((cur) => (cur === id ? null : cur));
        afterDelete(id);
      } catch (err) {
        console.error("[FileManager] delete failed:", err);
        toast.error(err instanceof Error ? err.message : "删除失败");
      }
    },
    [afterDelete],
  );

  // ---- 重命名：列表层面同步（更新 items 里对应行的 filename） ----
  // 网络请求 + toast 由 AttachmentDetailDrawer 内部完成，这里只在成功后被通知。
  const afterRename = useCallback((id: string, newFilename: string) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, filename: newFilename } : it)),
    );
    // v12：清列表缓存——文件名变了，缓存里仍是老名字会与 UI 不一致
    invalidateFileListCache();
  }, []);

  // ---- 批量选择 ----
  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((m) => {
      const next = !m;
      if (!next) setSelectedIds(new Set()); // 退出选择模式自动清空
      return next;
    });
  }, []);
  // Esc 退出多选
  useEffect(() => {
    if (!selectionMode) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSelectedIds(new Set()); setSelectionMode(false); }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [selectionMode]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 全选 / 反全选：仅作用于"当前页面已加载"的 items；不会越过分页边界。
  const allSelectedOnPage =
    items.length > 0 && items.every((it) => selectedIds.has(it.id));
  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (items.length === 0) return prev;
      const allOn = items.every((it) => prev.has(it.id));
      if (allOn) {
        // 仅取消"当前页"的勾选；保留其它页已勾选的（如果有）
        const next = new Set(prev);
        for (const it of items) next.delete(it.id);
        return next;
      }
      const next = new Set(prev);
      for (const it of items) next.add(it.id);
      return next;
    });
  }, [items]);

  // ---- 批量删除 ----
  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    const ok = await confirmDialog({
      title: `确定要删除选中的 ${count} 个文件吗？`,
      description:
        "删除后，引用这些文件的笔记里将显示为破图 / 失效链接。该操作不可撤销。",
      confirmText: `删除 ${count} 个`,
      danger: true,
    });
    if (!ok) {
      return;
    }
    setBatchDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await api.files.batchRemove(ids);
      // 本地列表即时剔除（按"实际删除成功的 id"——失败项不剔除，便于用户看到）
      const failedIdSet = new Set(res.failed.map((f) => f.id));
      const succeededIds = new Set(ids.filter((id) => !failedIdSet.has(id)));
      setItems((prev) => prev.filter((it) => !succeededIds.has(it.id)));
      setTotal((t) => Math.max(0, t - succeededIds.size));
      // 选择集合：移除已成功删除的，保留失败项让用户再处理
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of succeededIds) next.delete(id);
        return next;
      });
      // 详情抽屉里若是已删项，关掉
      if (detailId && succeededIds.has(detailId)) closeDetail();

      if (res.failed.length === 0) {
        toast.success(`已删除 ${res.deleted} 个文件`);
        // 全部成功 → 退出选择模式
        setSelectionMode(false);
      } else {
        toast.error(
          `已删除 ${res.deleted} 个，${res.failed.length} 个失败：${res.failed[0].reason}${res.failed.length > 1 ? " 等" : ""}`,
        );
      }
      // v12：清列表缓存，避免下一次 loadList 命中陈旧（含已删项）的列表
      invalidateFileListCache();
      loadStats();
      loadReclaimable();
      notifyStorageChanged();
      // 关键：与单删一致——删除后必须重新拉当前页，把后续页的项顶上来，
      // 否则当前页会剩不足 PAGE_SIZE 项，要切页才能看到完整的剩余文件。
      // 当前页全删空且不在第 1 页 → 回退一页（page 变化会触发 loadList）。
      const remainingOnPage = items.length - succeededIds.size;
      if (remainingOnPage <= 0 && page > 1) {
        setPage((p) => Math.max(1, p - 1));
      } else {
        loadList();
      }
    } catch (err) {
      console.error("[FileManager] batch delete failed:", err);
      toast.error(err instanceof Error ? err.message : "批量删除失败");
    } finally {
      setBatchDeleting(false);
    }
  }, [selectedIds, detailId, closeDetail, loadStats, loadReclaimable, loadList, items.length, page]);

  // ---- 批量归档到文件夹 ----
  // folderId = null 表示移出到"未归档"。后端只改 attachments.folderId，
  // 所以改完直接刷列表（当前筛选如果是按文件夹分组，用户能立刻看到变化）。
  const handleBatchMove = useCallback(
    async (folderId: string | null) => {
      if (selectedIds.size === 0 || batchMoving) return;
      const ids = Array.from(selectedIds);
      setBatchMoving(true);
      try {
        const res = await api.files.batchMove(ids, folderId);
        const label = folderId
          ? attachmentFolders.find((f) => f.id === folderId)?.name || "文件夹"
          : "未归档";
        if (res.failed.length === 0) {
          toast.success(`已移动 ${res.moved} 个文件到“${label}”`);
          setSelectionMode(false);
        } else {
          toast.error(
            `已移动 ${res.moved} 个，${res.failed.length} 个失败：${res.failed[0]?.reason || ""}${res.failed.length > 1 ? " 等" : ""}`,
          );
        }
        invalidateFileListCache();
        loadStats();
        loadList();
      } catch (err) {
        console.error("[FileManager] batch move failed:", err);
        toast.error(err instanceof Error ? err.message : "批量移动失败");
      } finally {
        setBatchMoving(false);
      }
    },
    [selectedIds, batchMoving, attachmentFolders, loadStats, loadList],
  );

  // ---- 批量生成公开链接 ----
  // 一个附件一条分享记录（后端语义），因此逐个 POST；拿到链接后整体拷到
  // 剪贴板（一行一个），与单文件“复制链接”同一个 copyText 通道。
  const handleBatchShareLinks = useCallback(async () => {
    if (selectedIds.size === 0 || batchSharing) return;
    const ids = Array.from(selectedIds);
    setBatchSharing(true);
    try {
      const links: string[] = [];
      let failed = 0;
      for (const id of ids) {
        try {
          const share = await attachmentShareApi.open(id, {});
          links.push(buildAttachmentShareUrl(share.shareToken));
        } catch {
          failed += 1;
        }
      }
      if (links.length === 0) {
        toast.error("生成公开链接失败");
        return;
      }
      const copied = await copyText(links.join("\n"));
      toast.success(
        copied
          ? `已生成 ${links.length} 个公开链接并复制到剪贴板，默认 7 天后失效${failed ? `（${failed} 个失败）` : ""}`
          : `已生成 ${links.length} 个公开链接，但复制失败：当前环境不允许访问剪贴板`,
      );
      // 刷新"已分享"角标 + 分享状态筛选徽标（stats.shared）
      loadShares();
      loadStats();
    } finally {
      setBatchSharing(false);
    }
  }, [selectedIds, batchSharing, loadShares, loadStats]);

  // 切换分类 / 搜索 / 排序 / 翻页时，已勾选的 id 可能不再在当前 items 里，
  // 体验上保留集合也容易让用户产生"幽灵勾选"。统一在这些维度变化时清空。
  useEffect(() => {
    setSelectedIds(new Set());
  }, [category, shareFilter, myUploadsRef, sort, searchQuery, page]);

  // ---- 上传 ----
  const handleUpload = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (arr.length === 0) return;
      setUploading(true);
      let ok = 0;
      let fail = 0;
      for (const f of arr) {
        try {
          await api.files.upload(f);
          ok++;
        } catch (err) {
          console.error("[FileManager] upload failed:", err);
          fail++;
          toast.error(`${f.name}: ${err instanceof Error ? err.message : "上传失败"}`);
        }
      }
      setUploading(false);
      if (ok > 0) {
        toast.success(`已上传 ${ok} 个文件${fail > 0 ? `，失败 ${fail}` : ""}`);
        // v12：清列表缓存，确保新上传的文件能立刻出现
        invalidateFileListCache();
        // 重新拉首屏 + 刷统计 + 刷可回收徽标（刚上传可能让旧孤儿的"宽限期"外延）
        setPage(1);
        loadList();
        loadStats();
        loadReclaimable();
      }
    },
    [loadList, loadStats, loadReclaimable, notifyStorageChanged],
  );

  const onPickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // 统一上传入口：文件池不再区分来源，任何类型都直接进池子（服务端不再做 MIME 分流）。
  const routeUpload = useCallback(
    (files: File[]) => {
      if (files.length > 0) handleUpload(files);
    },
    [handleUpload],
  );


  // ---- 粘贴板上传（图床高频用法：截图 → Ctrl+V）----
  //
  // 监听整个文档的 paste 事件，从 clipboardData.items 抓出文件类型条目。
  // 限制：
  //   - 只在 FileManager 处于焦点态时响应（用 isMounted ref 兜底）；
  //   - 当焦点在 input/textarea/contenteditable 内时跳过，避免抢用户的粘贴文本。
  //   - 粘贴的图片浏览器一般给 image/png + 文件名 "image.png"，无法保留原始名称——
  //     交给后端按 hash + ext 自动生成 filename，前端无需介入。
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        const editable = (target as HTMLElement).isContentEditable;
        if (tag === "INPUT" || tag === "TEXTAREA" || editable) return;
      }
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        routeUpload(files);
      }
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [routeUpload]);

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        routeUpload(Array.from(e.target.files));
      }
      // 清空 input value，允许再次选相同文件
      e.target.value = "";
    },
    [routeUpload],
  );

  // ---- 拖拽上传整区 ----
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounter.current++;
    setDragOver(true);
  }, []);
  const onDragLeave = useCallback(() => {
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        routeUpload(Array.from(e.dataTransfer.files));
      }
    },
    [routeUpload],
  );

  // ---- 跳转到引用笔记 ----
  // 页签契约（P3）：不调 actions.setViewMode，改派发 nowen:tool-page-navigate
  // 由 ToolPageHost 翻译为「关闭工具页签 + 打开笔记」。
  const jumpToNote = useCallback(
    async (noteId: string) => {
      try {
        const note = await api.getNote(noteId);
        if (!note) {
          toast.error("笔记不存在或已被删除");
          return;
        }
        // 宿主不处理侧栏选中态，这里保留（非视图切换动作）。
        actions.setSelectedNotebook(note.notebookId);
        navigateToolPage({ kind: "note", noteId });
      } catch (err) {
        console.error("[FileManager] jumpToNote failed:", err);
        toast.error(err instanceof Error ? err.message : "跳转失败");
      }
    },
    [actions],
  );

  // ---- 复制 URL / Markdown / HTML ----
  //
  // copiedId 只是一个"乐观反馈"——卡片上的复制图标变 ✓ 1.2s 让用户知道点中了。
  // 实际复制走 lib/clipboard.copyText（含 secureContext + textarea 双路降级），
  // 比之前直接 navigator.clipboard.writeText 兼容性更好。
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { siteConfig } = useSiteSettings();
  // 分享链接应指向公开文件源（若已配置），否则回退到当前 API 源——避免把内网/临时地址发出去。
  const publicAttachmentOptions = useMemo(() => ({
    filePublicOrigin: siteConfig.filePublicOrigin,
    publicWebOrigin: siteConfig.publicWebOrigin,
  }), [siteConfig.filePublicOrigin, siteConfig.publicWebOrigin]);

  /** 把附件信息按指定格式（URL / Markdown / HTML）复制到剪贴板。 */
  const copySnippet = useCallback(
    async (item: { id: string; filename: string; url: string; mimeType?: string }, format: FileLinkFormat = "url") => {
      const full = buildPublicAttachmentUrl(resolveAttachmentUrl(item.url), publicAttachmentOptions);
      // 片段形态由 MIME 决定：图片 <img>/![]()、视频 <video>、音频 <audio>、其他 <a>/[]()
      const snippet = formatFileLinkSnippet(format, full, item.filename, item.mimeType);
      const ok = await copyText(snippet);
      if (ok) {
        setCopiedId(item.id);
        toast.success(`已复制 ${fileLinkFormatLabel(format)}`);
        setTimeout(() => setCopiedId((id) => (id === item.id ? null : id)), 1200);
      } else {
        toast.error("复制失败，请检查浏览器剪贴板权限");
      }
    },
    [publicAttachmentOptions],
  );

  /** 旧 API 兼容：默认复制纯 URL（GridCard 主按钮 / ListView 都还在用这个名字）。 */
  const copyUrl = useCallback(
    (item: FileItem) => {
      void copySnippet(item, "url");
    },
    [copySnippet],
  );

  // ---- 下载 ----
  //
  // 下载策略：同源走原生 <a download>（同步、零手势丢失），跨源回退 fetch+blob。
  // 由 downloadAttachment 统一实现，避免编辑器 / 文件管理 / 详情抽屉三处各写一份。
  // 详见 frontend/src/lib/downloadFile.ts。
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // 用 ref 同步 downloadingId 的最新值，避免 downloadItem useCallback 依赖
  // downloadingId 状态——否则每次开始/结束下载 downloadItem 引用都会变，
  // 进而打穿 GridCard 的 React.memo，触发 60+ 张卡全部重渲。
  const downloadingIdRef = useRef<string | null>(null);
  useEffect(() => {
    downloadingIdRef.current = downloadingId;
  }, [downloadingId]);
  const downloadItem = useCallback(async (item: { id: string; filename: string; url: string }) => {
    if (downloadingIdRef.current === item.id) return;
    setDownloadingId(item.id);
    try {
      await downloadAttachment(resolveAttachmentUrl(item.url), item.filename || `file-${item.id}`);
    } catch (err) {
      console.error("[FileManager] download failed:", err);
      toast.error(`下载失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setDownloadingId((id) => (id === item.id ? null : id));
    }
  }, []);




  // 分页控件相关
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // 切换每页条数：
  //   - 持久化到 localStorage（per-device 偏好）
  //   - 回到第 1 页：避免在第 N 页（小档）切到大档后页码越界落到空页
  //   - 不清空多选：保留用户已有勾选 id（即便它们落到不同页也能在选择栏看到计数）
  const handlePageSizeChange = useCallback((next: number) => {
    setPageSize(next);
    setPage(1);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next));
      } catch {
        /* 隐私模式下 setItem 可能抛异常——忽略，仅本会话生效 */
      }
    }
  }, []);

  // 空态文案：区分"一张没有" vs "当前筛选无结果"
  const isFirstPageNoResults = !loading && items.length === 0 && page === 1;
  // 空态文案分叉依据：类型 / 范围 / 时间 / 搜索 任一非默认即视为"筛选中"
  const hasAnyFilter =
    Boolean(searchQuery) || category !== "all" || typeFilterActive || shareFilter !== "all" || getFilesTime() !== "all";

  // 扁平视图也按 id 去重，防止重复渲染
  const displayItems = useMemo(() => {
    const seen = new Set<string>();
    return items.filter((it) => {
      if (seen.has(it.id)) return false;
      seen.add(it.id);
      return true;
    });
  }, [items]);

  // 按笔记本分组 或 按附件文件夹分组
  const groupedItems = useMemo(() => {
    if (groupMode !== "notebook" && groupMode !== "folder") return null;
    // 先按 attachment.id 去重，防止接口返回重复数据导致分组重复渲染
    const seen = new Set<string>();
    const deduped = items.filter((it) => {
      if (seen.has(it.id)) return false;
      seen.add(it.id);
      return true;
    });
    const groups = new Map<string, { label: string; icon: string | null; items: typeof deduped }>();

    if (groupMode === "folder") {
      // 以 attachmentFolders 为基准创建分组（包含空文件夹）
      for (const folder of attachmentFolders) {
        groups.set(folder.id, { label: folder.name, icon: null, items: [] });
      }
      // 添加"未归档文件"固定分组
      groups.set("__unarchived__", { label: "未归档文件", icon: null, items: [] });
      // 遍历当前页 items，分配到对应文件夹分组
      for (const it of deduped) {
        const fId = it.folderId || null;
        const key = fId || "__unarchived__";
        // 如果该 folderId 不在 attachmentFolders 中（可能是刚删除的文件夹），跳过
        if (!groups.has(key)) continue;
        groups.get(key)!.items.push(it);
      }
      // 排序："未归档文件"放最后，其他按名称
      return [...groups.entries()].sort(([aKey, a], [bKey, b]) => {
        if (aKey === "__unarchived__" && bKey !== "__unarchived__") return 1;
        if (aKey !== "__unarchived__" && bKey === "__unarchived__") return -1;
        return a.label.localeCompare(b.label);
      });
    }

    // 按笔记本分组
    for (const it of deduped) {
      const nbId = it.primaryNote?.notebookId || null;
      const nbName = it.primaryNote?.notebookName || null;
      const nbIcon = it.primaryNote?.notebookIcon || null;
      const key = nbId || (it.primaryNote ? "__unarchived__" : "__orphan__");
      const label = nbId ? (nbName || "未命名笔记本") : (it.primaryNote ? "未归档附件" : "孤儿附件");
      const icon = nbId ? nbIcon : null;
      if (!groups.has(key)) groups.set(key, { label, icon, items: [] });
      groups.get(key)!.items.push(it);
    }
    // 排序：有笔记本的按名称，孤儿/未归档放最后
    return [...groups.entries()].sort(([aKey, a], [bKey, b]) => {
      if (aKey.startsWith("__") && !bKey.startsWith("__")) return 1;
      if (!aKey.startsWith("__") && bKey.startsWith("__")) return -1;
      return a.label.localeCompare(b.label);
    });
  }, [groupMode, items, attachmentFolders]);

  // 方便状态栏展示
  const statsLine = useMemo(() => {
    if (!stats) return "";
    // 统一文件池：统计口径 = 全类型文件（图片 / 视频 / 音频 / 文档 / 其他）
    return `共 ${stats.total} 个文件 · ${humanSize(stats.totalBytes)}`;
  }, [stats]);

  // 类型 chips 的统计（个数 + 占用）：来自 /api/files/stats 的大类分桶。
  // 个数直接画在 chip 上（首屏就能看到"图片 128 / 视频 6"这类分布），
  // 字节数放 title：避免工具条被五个数字挤满。
  const typeStatOf = useCallback(
    (key: FilesTypeFilter): { count: number; bytes: number } => {
      if (!stats) return { count: 0, bytes: 0 };
      switch (key) {
        case "image":
          return stats.images;
        case "video":
          return stats.videos ?? { count: 0, bytes: 0 };
        case "audio":
          return stats.audios ?? { count: 0, bytes: 0 };
        case "doc":
          return stats.documents ?? { count: 0, bytes: 0 };
        case "other":
          return stats.others ?? { count: 0, bytes: 0 };
        default:
          return { count: stats.total, bytes: stats.totalBytes };
      }
    },
    [stats],
  );

  const storageBadge = useMemo(() => {
    const storage = stats?.storage;
    if (!storage) return null;
    const detail = [storage.bucket, storage.prefix ? `/${storage.prefix}` : ""].filter(Boolean).join(" · ");
    if (storage.mode === "object") {
      return {
        label: t("files.storage.objectEnabled", { defaultValue: "Object storage enabled" }),
        detail,
        className: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        dotClassName: "bg-emerald-500",
      };
    }
    if (storage.mode === "fallback") {
      return {
        label: t("files.storage.objectFallback", { defaultValue: "Incomplete config, using local storage" }),
        detail,
        className: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        dotClassName: "bg-amber-500",
      };
    }
    return {
      label: t("files.storage.local", { defaultValue: "Local storage" }),
      detail: "",
      className: "border-app-border bg-app-bg text-tx-secondary",
      dotClassName: "bg-zinc-400",
    };
  }, [stats?.storage, t]);

  return (
    <div
      ref={pageRootRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col h-full bg-app-bg overflow-hidden relative"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* 保存到远程：把本地附件另存到远程源（内核能力，无启停开关） */}
      {remoteSaveDlg && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/30"
          onMouseDown={() => setRemoteSaveDlg(null)}
        >
          <div
            className="w-80 rounded-xl border border-app-border bg-app-elevated p-4 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="text-xs font-semibold text-tx-primary">保存到远程</p>
            <p className="mt-0.5 truncate text-[11px] text-tx-tertiary">{remoteSaveDlg.filename}</p>
            <select
              className="mt-2 h-7 w-full rounded border border-app-border bg-transparent px-1.5 text-xs"
              value={remoteSaveSourceId}
              onChange={(e) => setRemoteSaveSourceId(e.target.value)}
            >
              {remoteSaveSources.length === 0 ? <option value="">（无远程源，请先在远程文件页添加）</option> : null}
              {remoteSaveSources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{s.type}）
                </option>
              ))}
            </select>
            <input
              className="mt-2 h-7 w-full rounded border border-app-border bg-transparent px-2 text-xs"
              placeholder="远程目标路径，如 /from-files/xx.png"
              value={remoteSavePath}
              onChange={(e) => setRemoteSavePath(e.target.value)}
            />
            {remoteSaveMsg ? <p className="mt-1 text-[11px] text-red-500">{remoteSaveMsg}</p> : null}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-app-border px-3 py-1 text-xs text-tx-secondary"
                onClick={() => setRemoteSaveDlg(null)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={remoteSaving || !remoteSaveSourceId}
                className="rounded-md bg-accent-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                onClick={() => void submitRemoteSave()}
              >
                {remoteSaving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
      {sourceTab !== "remote" && (
      <>
      {/* 顶栏单行（原型 toolbar-single-row-v1）：标题+徽章(左)；搜索/排序/选择/更多/上传(右)。
          多选时右端原地切换为批量操作，不再另起一层。 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-app-border bg-app-surface/40 px-4">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-accent-primary/10 text-accent-primary">
          <FolderOpen size={18} />
        </div>
        <h2 className="text-[15px] font-semibold text-tx-primary whitespace-nowrap">本地文件</h2>
        {storageBadge && (
          <div
            className={cn(
              "hidden sm:flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] shrink-0",
              storageBadge.className,
            )}
            title={storageBadge.detail ? `${storageBadge.label} · ${storageBadge.detail}` : storageBadge.label}
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", storageBadge.dotClassName)} />
            <span className="whitespace-nowrap font-medium">{storageBadge.label}</span>
          </div>
        )}
        {/* 侧栏筛选生效中的可摘除标签（保留自旧工具条） */}
        {getFilesTime() !== "all" && (
          <span className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-accent-primary/10 px-2.5 text-[11.5px] text-accent-primary">
            {{ today: "今天", week: "近 7 天", month: "近 30 天" }[getFilesTime()] || getFilesTime()}
            <button type="button" className="cursor-pointer" onClick={() => setFilesUi({ time: "all" })}>✕</button>
          </span>
        )}
        {shareFilter !== "all" && (
          <span className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-accent-primary/10 px-2.5 text-[11.5px] text-accent-primary">
            {shareFilter === "shared" ? "已分享" : "未分享"}
            <button type="button" className="cursor-pointer" onClick={() => setFilesUi({ share: "all" })}>✕</button>
          </span>
        )}
        <div className="flex-1" />

        <>
            {/* ── 常驻态：搜索 / 排序 / 选择 / 更多 / 上传 ── */}
            <label className="relative block w-[190px] shrink-0">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-2 text-tx-tertiary" />
              <Input
                placeholder={t("common.search")}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="h-[30px] pl-7 pr-7 text-[11.5px]"
              />
              {searchInput && (
                <button
                  className="absolute right-2 top-1.5 text-tx-tertiary hover:text-tx-primary"
                  onClick={() => setSearchInput("")}
                >
                  <X size={12} />
                </button>
              )}
            </label>
            {/* 排序：图标化（悬停提示），选项菜单不变 */}
            <div ref={sortMenuRef} className="relative shrink-0">
              <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={sortMenuOpen}
                title={`排序：${FILE_SORT_OPTIONS.find((option) => option.value === sort)?.label ?? ""}`}
                onClick={() => setSortMenuOpen((value) => !value)}
                className="inline-flex h-[30px] w-10 items-center justify-center rounded-md border border-app-border bg-app-bg p-0 text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
              >
                <ArrowDownUp size={13} />
              </button>
              {sortMenuOpen && (
                <div role="listbox" className="absolute right-0 z-40 mt-1 w-36 overflow-hidden rounded-lg border border-app-border bg-app-elevated py-1 shadow-xl">
                  {FILE_SORT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={sort === option.value}
                      onClick={() => { setFilesUi({ sort: option.value }); setSortMenuOpen(false); }}
                      className={cn(
                        "flex w-full items-center px-2.5 py-1.5 text-left text-[11.5px] hover:bg-app-hover",
                        sort === option.value ? "text-accent-primary" : "text-tx-secondary",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* 选择：图标化 */}
            <Button
              size="sm"
              variant="outline"
              onClick={toggleSelectionMode}
              className="h-[30px] w-10 shrink-0 justify-center px-0"
              title={selectionMode ? "退出多选（Esc）" : "进入多选"}
            >
              {selectionMode ? <X size={14} /> : <CheckSquare size={14} />}
            </Button>
            {/* 更多：低频操作收纳 */}
            <div ref={moreMenuRef} className="relative shrink-0">
              <button
                type="button"
                title="更多操作"
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                onClick={() => setMoreMenuOpen((v) => !v)}
                className="inline-flex h-7 w-10 items-center justify-center rounded-md border border-app-border bg-app-bg text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
              >
                <MoreHorizontal size={14} />
              </button>
              {moreMenuOpen && (
                <div role="menu" className="absolute right-0 z-40 mt-1 w-52 overflow-hidden rounded-lg border border-app-border bg-app-elevated py-1 shadow-xl">
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                    onClick={() => { setMoreMenuOpen(false); void handleCleanupOrphans(); }}
                  >
                    <Trash2 size={13} className="shrink-0" />
                    清理未引用附件
                    {reclaimable && reclaimable.items > 0 && (
                      <span className="ml-auto text-[10px] text-tx-tertiary">{reclaimable.items} 项</span>
                    )}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                    onClick={() => { setMoreMenuOpen(false); void loadList(); }}
                  >
                    <RefreshCw size={13} className="shrink-0" /> 刷新
                  </button>
                  <div className="my-1 h-px bg-app-border" />
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                    onClick={() => { setMoreMenuOpen(false); setFilesUi({ view: viewMode === "list" ? "grid" : "list" }); }}
                  >
                    {viewMode === "list" ? <LayoutGrid size={13} className="shrink-0" /> : <List size={13} className="shrink-0" />}
                    {viewMode === "list" ? "网格视图" : "列表视图"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                    onClick={() => { setMoreMenuOpen(false); setFilesUi({ group: groupMode === "flat" ? "folder" : "flat" }); }}
                  >
                    <FolderOpen size={13} className="shrink-0" />
                    {groupMode === "flat" ? "按文件夹分组" : "取消分组"}
                  </button>
                </div>
              )}
            </div>
            <span className="hidden lg:block w-px h-4 bg-app-border shrink-0" />
            <Button size="sm" onClick={() => setUploadDialogOpen(true)} disabled={uploading} className="h-[30px] w-[98px] shrink-0 justify-center px-0">
              {uploading ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Upload size={14} className="mr-1" />}
              {uploading ? "上传中" : "上传文件"}
            </Button>
            {/* 统一文件池：不限制上传类型（图片 / 视频 / 音频 / 文档一律进池子） */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={onFileInputChange}
            />
        </>
      </div>

      {/* 批量操作栏：选择模式下出现在顶栏下方 */}
      {selectionMode && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border bg-accent-primary/5 px-4 py-1.5">
          <button
            onClick={toggleSelectAll}
            className="flex items-center gap-1.5 text-xs text-tx-secondary hover:text-tx-primary transition-colors"
            disabled={items.length === 0}
            title={allSelectedOnPage ? "取消选择本页全部" : "选择本页全部"}
          >
            {allSelectedOnPage ? <CheckSquare size={14} className="text-accent-primary" /> : <Square size={14} />}
            {allSelectedOnPage ? "取消全选" : "全选本页"}
          </button>
          <span className="text-xs text-tx-tertiary whitespace-nowrap">
            已选 <b className="text-accent-primary">{selectedIds.size}</b> 个
            {displayItems.length > 0 && (
              <span className="ml-1 opacity-60">（本页 {displayItems.length} / 全部 {total}）</span>
            )}
          </span>
          <div className="flex-1" />
          <select
            value=""
            disabled={selectedIds.size === 0 || batchMoving}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              void handleBatchMove(v === "__unarchived__" ? null : v);
            }}
            className="h-7 max-w-[150px] rounded-md border border-app-border bg-app-bg px-1.5 text-xs text-tx-secondary disabled:opacity-50"
            title="把选中文件归档到附件文件夹"
          >
            <option value="">{batchMoving ? "移动中…" : "移动到文件夹…"}</option>
            <option value="__unarchived__">未归档</option>
            {attachmentFolders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={handleBatchShareLinks}
            disabled={selectedIds.size === 0 || batchSharing}
            title="为选中附件开启只读分享链接，并全部复制到剪贴板"
          >
            {batchSharing ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Link2 size={14} className="mr-1" />}
            生成公开链接
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSelectedIds(new Set())}
            disabled={selectedIds.size === 0}
          >
            清空选择
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleBatchDelete}
            disabled={selectedIds.size === 0 || batchDeleting}
            className="text-red-500 border-red-500/40 hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/60 disabled:opacity-50"
          >
            {batchDeleting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Trash2 size={14} className="mr-1" />}
            删除选中
          </Button>
        </div>
      )}

      {/* "我的上传"二级子筛选条：仅在该主 tab 选中时出现。
          三选一：全部 / 已引用 / 未引用。徽标计数来自 stats.myUploads。
          视觉上与主工具条同款 padding，淡背景区分层级。 */}
      {category === "myUploads" && (
        <div className="flex flex-wrap items-center gap-1 px-4 md:px-6 py-1.5 border-b border-app-border bg-app-surface/10 text-xs">
          <span className="text-tx-tertiary mr-1">引用状态:</span>
          {(
            [
              {
                key: "all" as const,
                label: "全部",
                count: stats?.myUploads?.total ?? 0,
              },
              {
                key: "referenced" as const,
                label: "已引用",
                count: stats?.myUploads?.referenced ?? 0,
              },
              {
                key: "unreferenced" as const,
                label: "未引用",
                count: stats?.myUploads?.unreferenced ?? 0,
              },
            ] as const
          ).map((sub) => (
            <button
              key={sub.key}
              onClick={() => {
                setMyUploadsRef(sub.key);
                setPage(1);
              }}
              className={cn(
                "px-2 py-0.5 rounded-md flex items-center gap-1 transition-colors",
                myUploadsRef === sub.key
                  ? "bg-accent-primary/15 text-accent-primary"
                  : "text-tx-secondary hover:bg-app-hover",
              )}
              title={
                sub.key === "referenced"
                  ? "已经被某条笔记引用过的"
                  : sub.key === "unreferenced"
                    ? "还没插到任何笔记里的"
                    : undefined
              }
            >
              <span>{sub.label}</span>
              <span className="text-[10px] text-tx-tertiary">{sub.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* 主区 */}
      <div className="flex-1 min-h-0 relative">
        <ScrollArea className="h-full">
          <div className="px-4 md:px-6 py-4">
            {loading && items.length === 0 ? (
              <div className="flex items-center justify-center py-20 text-tx-tertiary">
                <Loader2 size={18} className="animate-spin mr-2" />
                加载中…
              </div>
            ) : isFirstPageNoResults ? (
              <EmptyState hasFilter={!!hasAnyFilter} onUpload={onPickFiles} />
            ) : (groupMode === "notebook" || groupMode === "folder") && groupedItems ? (
              // 按笔记本/文件夹分组视图
              <div className="space-y-4">
                {groupedItems.map(([groupKey, group]) => {
                  const isCollapsed = collapsedGroups.has(groupKey);
                  return (
                    <div key={groupKey}>
                      <button
                        type="button"
                        onClick={() => toggleGroup(groupKey)}
                        className="flex items-center gap-2 w-full px-1 py-1.5 text-xs font-medium text-tx-secondary hover:text-tx-primary transition-colors"
                      >
                        {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        {group.icon && <span>{group.icon}</span>}
                        <span>{group.label}</span>
                        <span className="text-tx-tertiary font-normal">({group.items.length})</span>
                      </button>
                      {!isCollapsed && (
                        group.items.length === 0 ? (
                          <div className="py-4 text-center text-xs text-tx-tertiary">暂无文件</div>
                        ) : viewMode === "grid" ? (
                          <GridView
                            items={group.items}
                            onOpen={openDetail}
                            onCopyUrl={copyUrl}
                            onCopySnippet={copySnippet}
                            onDownload={downloadItem}
                            copiedId={copiedId}
                            downloadingId={downloadingId}
                            selectionMode={selectionMode}
                            selectedIds={selectedIds}
                            onToggleSelect={toggleSelect}
                            sharedIds={sharedIds}
                          />
                        ) : (
                          <ListView
                            items={group.items}
                            onOpen={openDetail}
                            onCopyUrl={copyUrl}
                            onJumpToNote={jumpToNote}
                            onDownload={downloadItem}
                            onDelete={afterDelete}
                            onSaveRemote={openRemoteSave}
                            onShare={(item) => void openShare(item.id)}
                            copiedId={copiedId}
                            downloadingId={downloadingId}
                            selectionMode={selectionMode}
                            selectedIds={selectedIds}
                            onToggleSelect={toggleSelect}
                            sharedIds={sharedIds}
                          />
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            ) : viewMode === "grid" ? (
              <GridView
                items={displayItems}
                onOpen={openDetail}
                onCopyUrl={copyUrl}
                onCopySnippet={copySnippet}
                onDownload={downloadItem}
                copiedId={copiedId}
                downloadingId={downloadingId}
                selectionMode={selectionMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                sharedIds={sharedIds}
              />
            ) : (
              <ListView
                items={displayItems}
                onOpen={openDetail}
                onCopyUrl={copyUrl}
                 onJumpToNote={jumpToNote}
                 onDownload={downloadItem}
                 onDelete={handleDelete}
                 onSaveRemote={openRemoteSave}
                onShare={(item) => void openShare(item.id)}
                copiedId={copiedId}
                downloadingId={downloadingId}
                selectionMode={selectionMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                sharedIds={sharedIds}
              />
            )}

            {/* 分页 */}
            {(pageCount > 1 || total > PAGE_SIZE_OPTIONS[0]) && (
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 mt-6 text-xs text-tx-secondary">
                <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  上一页
                </Button>
                <span>
                  第 {page} / {pageCount} 页（共 {total} 个）
                </span>
                <Button size="sm" variant="outline" disabled={page >= pageCount || loading} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>
                  下一页
                </Button>
                {/* 每页条数：放在分页器右侧。
                    选择后立即回到第 1 页，避免页码越界落到空页。
                    样式与工具条排序下拉保持一致，视觉熟悉度更高。 */}
                <div className="flex items-center gap-1">
                  <span className="text-tx-tertiary">每页</span>
                  <select
                    className="h-7 px-1.5 rounded-md border border-app-border bg-app-bg text-tx-primary text-xs outline-none"
                    value={pageSize}
                    onChange={(e) => handlePageSizeChange(Number.parseInt(e.target.value, 10))}
                    disabled={loading}
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n} 条
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* 拖拽蒙层 */}
        <AnimatePresence>
          {dragOver && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-30 bg-accent-primary/10 border-2 border-dashed border-accent-primary flex items-center justify-center pointer-events-none"
            >
              <div className="text-accent-primary text-sm font-medium flex items-center gap-2">
                <Upload size={20} />
                松开鼠标以上传
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 详情抽屉：复用型 AttachmentDetailDrawer（编辑器场景同款）。
          - 加载/下载/复制外链/重命名/删除 全部组件内部自管；
          - 列表层只接 onAfterDelete / onAfterRename 做本地同步。
          - extraHeaderActions 注入"分享"入口（抽屉组件文件不在本模块改动范围）。 */}
      <AnimatePresence>
        {detailId && (
          <AttachmentDetailDrawer
            attachmentId={detailId}
            onClose={closeDetail}
            onJumpToNote={jumpToNote}
            onAfterDelete={afterDelete}
            onAfterRename={afterRename}
            showDelete
            extraHeaderActions={(
              <button
                className="p-1.5 rounded-md text-tx-tertiary hover:text-tx-primary hover:bg-app-hover"
                onClick={() => void openShare(detailId)}
                title="分享"
              >
                <Share2 size={14} />
              </button>
            )}
          />
        )}
      </AnimatePresence>

      {/* 附件分享：行内「分享」跳到分享中心并打开同一抽屉（不再另开对话框） */}

      {/* 上传弹窗 */}
      <FileUploadDialog
        open={uploadDialogOpen}
        onClose={() => setUploadDialogOpen(false)}
        onUploaded={() => { invalidateFileListCache(); loadList(); loadStats(); loadReclaimable(); loadFolders(); notifyStorageChanged(); }}
        defaultFolderId={null}
      />
        </>
      )}

      {/* 远程来源：整块交给 RemoteFilesPanel（自带单行顶栏） */}
      {sourceTab === "remote" && (
        <div className="min-h-0 flex-1 min-w-0">
          <RemoteFilesPanel />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件：空态
// ---------------------------------------------------------------------------
function EmptyState({ hasFilter, onUpload }: { hasFilter: boolean; onUpload: () => void }) {
  if (hasFilter) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-tx-tertiary text-sm">
        <Search size={32} className="mb-3 opacity-40" />
        当前筛选条件下没有文件
        <span className="text-xs mt-1">试试切换分类或清空搜索关键字</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center py-16 text-tx-tertiary">
      <Inbox size={40} className="mb-3 opacity-40" />
      <p className="text-sm">还没有任何文件</p>
      <p className="text-xs mt-1 mb-4">上传文件开始使用 · 支持图片 / 视频 / 音频 / 文档等任意类型</p>
      <Button size="sm" onClick={onUpload}>
        <Upload size={14} className="mr-1" />
        上传文件
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件：网格视图（图片优先）
// ---------------------------------------------------------------------------
function GridView({
  items,
  onOpen,
  onCopyUrl,
  onCopySnippet,
  onDownload,
  copiedId,
  downloadingId,
  selectionMode,
  selectedIds,
  onToggleSelect,
  sharedIds,
}: {
  items: FileItem[];
  onOpen: (id: string) => void;
  onCopyUrl: (item: FileItem) => void;
  onCopySnippet: (item: FileItem, format: FileLinkFormat) => void;
  onDownload: (item: FileItem) => void;
  copiedId: string | null;
  downloadingId: string | null;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  /** 已开启分享（isActive）的附件 id 集合——卡片"已分享"角标的数据源 */
  sharedIds: Set<string>;
}) {
  // 性能优化（v12）：
  //   GridCard 用 React.memo 浅比较 props。为了让 memo 真正生效，
  //   父级把"全局态 → 单卡 boolean"的派生在 GridView 里完成，
  //   只把当前卡需要的 isCopied / isDownloading / isSelected 三个 bool 传下去。
  //   这样：当 copiedId 从 null → "id-A" 时，只有 A、和（可能的）原命中卡两张
  //   会因为 isCopied prop 变化重渲，其余 58 张全部跳过 render。
  //   下载、选择同理。
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
    >
      {items.map((it) => (
        <GridCard
          key={it.id}
          item={it}
          onOpen={onOpen}
          onCopyUrl={onCopyUrl}
          onCopySnippet={onCopySnippet}
          onDownload={onDownload}
          isCopied={copiedId === it.id}
          isDownloading={downloadingId === it.id}
          selectionMode={selectionMode}
          selected={selectedIds.has(it.id)}
          onToggleSelect={onToggleSelect}
          isShared={sharedIds.has(it.id)}
        />
      ))}
    </div>
  );
}

interface GridCardProps {
  item: FileItem;
  onOpen: (id: string) => void;
  onCopyUrl: (item: FileItem) => void;
  onCopySnippet: (item: FileItem, format: FileLinkFormat) => void;
  onDownload: (item: FileItem) => void;
  /** 当前卡片是否处于"刚刚复制成功"高亮态（替代 copiedId === item.id 全局比较） */
  isCopied: boolean;
  /** 当前卡片是否正在下载 */
  isDownloading: boolean;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  /** 是否已开启只读分享链接（角标数据来自 attachment_shares） */
  isShared: boolean;
}

/**
 * 单张文件卡片。
 *
 * 性能要点（v12 优化）：
 *   1. 用 React.memo 包裹，浅比较 props 命中即跳过 render。
 *   2. 所有回调（onOpen / onCopyUrl / onCopySnippet / onDownload / onToggleSelect）
 *      都在父组件用 useCallback 稳定引用——见 FileManager 主体。
 *   3. 父级派生 isCopied / isDownloading / selected 三个 boolean，
 *      避免传 copiedId / downloadingId / selectedIds 这种"全局对象，引用稳定但
 *      字段值跨卡耦合"的 props 让 memo 失效。
 *   4. 图片优先用 thumbnailUrl（后端 webp 缩略图），原图作为 fallback。
 *      thumbnailUrl 仅在 raster 图片下发；svg / ico / 老服务端会自动回退到原图。
 */
const GridCard = React.memo(function GridCard({
  item,
  onOpen,
  onCopyUrl,
  onCopySnippet,
  onDownload,
  isCopied,
  isDownloading,
  selectionMode,
  selected,
  onToggleSelect,
  isShared,
}: GridCardProps) {
  const isImage = item.category === "image";
  // 视频卡片用后端 ffmpeg 首帧海报当缩略图；拿不到 thumbnailUrl（老服务端）
  // 就仍然用类型图标占位。
  const isVideo = resolveMimeCategory(item) === "video";
  const hasThumbnail = isImage || (isVideo && Boolean(item.thumbnailUrl));
  // "复制格式"下拉菜单是否展开。每张卡独立维护——同时只能展开一个比较自然，
  // 但实现上让外层点击就关掉即可，无需引入全局状态。
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
  // 点卡片其他位置时关掉菜单（避免菜单悬空残留）
  useEffect(() => {
    if (!formatMenuOpen) return;
    const close = () => setFormatMenuOpen(false);
    // 用 setTimeout 延后挂载，避免触发当前 click 立即被关
    const t = setTimeout(() => window.addEventListener("click", close, { once: true }), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("click", close);
    };
  }, [formatMenuOpen]);

  const handleCardClick = () => {
    if (selectionMode) onToggleSelect(item.id);
    else onOpen(item.id);
  };

  // 缩略图 src：
  //   - 优先 thumbnailUrl（后端 webp，体积通常 ~10-30KB，相比 3MB 原图缩 100x）；
  //   - 不存在则回退原图 url（svg / ico / 老服务端兼容）。
  // 注意：DetailDrawer / Markdown 复制等场景仍然用原图 url，不受此影响。
  const thumbSrc = resolveAttachmentUrl(item.thumbnailUrl || item.url);

  return (
    <div
      className={cn(
        "group relative rounded-lg border bg-app-surface overflow-hidden hover:shadow-sm transition-all cursor-pointer",
        selected
          ? "border-accent-primary ring-2 ring-accent-primary/40"
          : "border-app-border hover:border-accent-primary/50",
      )}
      onClick={handleCardClick}
      title={item.filename}
    >
      <div className="aspect-square w-full bg-app-bg flex items-center justify-center overflow-hidden">
        {hasThumbnail ? (
          <img
            src={thumbSrc}
            alt={item.filename}
            loading="lazy"
            // decoding="async"：让浏览器在 worker 里解码，不阻塞主线程
            decoding="async"
            // fetchpriority="low"：缩略图非首屏关键资源，给主线程腾带宽
            // （未在 React 类型里声明时用 lowercase 属性透传到 DOM）
            // @ts-expect-error fetchPriority 是 HTML 标准属性，TS 类型在某些版本未收录
            fetchpriority="low"
            className="w-full h-full object-cover"
            onError={(e) => {
              // 破图兜底：图片先尝试退回原图（缩略图生成失败时尤其有用）；
              // 视频不能回退——那会把整个视频文件当图片下回来，直接走占位。
              const el = e.currentTarget;
              if (!isVideo) {
                const fallbackUrl = resolveAttachmentUrl(item.url);
                if (el.src !== fallbackUrl) {
                  el.src = fallbackUrl;
                  return;
                }
              }
              el.style.display = "none";
              const fallback = el.nextElementSibling as HTMLElement | null;
              if (fallback) fallback.style.display = "flex";
            }}
          />
        ) : null}
        {!hasThumbnail && (
          <div className="w-full h-full flex flex-col items-center justify-center text-tx-tertiary">
            <div className="text-accent-primary/70 mb-1">{mimeIcon(item.mimeType)}</div>
            <span className="text-[10px] uppercase tracking-wide">{MIME_CATEGORY_LABELS[resolveMimeCategory(item)]}</span>
          </div>
        )}
        {hasThumbnail && (
          <div className="w-full h-full hidden flex-col items-center justify-center text-tx-tertiary bg-app-bg">
            {mimeIcon(item.mimeType)}
            <span className="text-[10px] mt-1">无法加载</span>
          </div>
        )}

        {/* 视频海报上的播放角标：区分“这是一段视频”与普通图片 */}
        {isVideo && hasThumbnail && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-8 h-8 rounded-full bg-black/45 flex items-center justify-center">
              <Play size={14} className="text-white" />
            </div>
          </div>
        )}

        {/* 已分享角标：存在生效中的只读分享链接（attachment_shares.isActive）。
            注：公开直链对所有附件都可用，这里的"已分享"指用户主动建过分享。 */}
        {isShared && (
          <div
            className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-indigo-500/85 text-white text-[9px] flex items-center gap-1 pointer-events-none"
            title="已开启只读分享链接"
          >
            <Share2 size={9} />
            <span>已分享</span>
          </div>
        )}
      </div>
      <div className="px-2 py-1.5">
        <div className="text-[11px] text-tx-primary truncate">{item.filename}</div>
        <div className="text-[10px] text-tx-tertiary">{humanSize(item.size)}</div>
      </div>

      {/* 选择 checkbox：选择模式下常驻显示，非选择模式下隐藏 */}
      {selectionMode && (
        <div className="absolute top-1.5 left-1.5 z-10">
          <button
            className={cn(
              "w-6 h-6 rounded-md flex items-center justify-center transition-colors shadow-sm",
              selected
                ? "bg-accent-primary text-white"
                : "bg-white/85 text-tx-secondary hover:bg-white",
            )}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(item.id);
            }}
            title={selected ? "取消选择" : "选择"}
          >
            {selected ? <Check size={14} /> : <Square size={14} />}
          </button>
        </div>
      )}

      {/* hover 工具条（选择模式下隐藏，避免误操作）。
          统一文件池：所有类型都有公开直链，工具栏统一为"下载 + 分裂式复制"
          （左半 URL，右半下拉 Markdown / HTML）。
          复制常驻可见而不是仅 hover 才出现——手机端（无 hover）也得能点到。 */}
      {!selectionMode && (
        <div className="absolute top-1.5 right-1.5 flex gap-1 transition-opacity opacity-100">
          <button
            className="w-6 h-6 rounded-md bg-black/50 hover:bg-black/70 text-white flex items-center justify-center disabled:opacity-50"
            onClick={(e) => {
              e.stopPropagation();
              onDownload(item);
            }}
            disabled={isDownloading}
            title="下载"
          >
            {isDownloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          </button>

          {/* 分裂按钮：左半 URL，右半下拉 MD/HTML */}
          <div className="relative flex items-stretch rounded-md overflow-hidden">
            <button
              className="px-1.5 bg-black/50 hover:bg-black/70 text-white flex items-center"
              onClick={(e) => {
                e.stopPropagation();
                onCopyUrl(item);
              }}
              title="复制 URL"
            >
              {isCopied ? <Check size={12} /> : <Copy size={12} />}
            </button>
            <button
              className="px-0.5 bg-black/50 hover:bg-black/70 text-white flex items-center border-l border-white/15"
              onClick={(e) => {
                e.stopPropagation();
                setFormatMenuOpen((v) => !v);
              }}
              title="选择复制格式"
            >
              <ChevronDown size={11} />
            </button>
            {formatMenuOpen && (
              <div
                className="absolute right-0 top-full mt-1 z-20 min-w-[120px] rounded-md border border-app-border bg-app-surface shadow-md py-1 text-xs"
                onClick={(e) => e.stopPropagation()}
              >
                {(["url", "markdown", "html"] as FileLinkFormat[]).map((fmt) => (
                  <button
                    key={fmt}
                    className="w-full px-2.5 py-1.5 text-left text-tx-primary hover:bg-app-hover flex items-center gap-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFormatMenuOpen(false);
                      onCopySnippet(item, fmt);
                    }}
                  >
                    <Copy size={11} className="text-tx-tertiary" />
                    <span>{fileLinkFormatLabel(fmt)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// 子组件：列表视图（文件为主）
// ---------------------------------------------------------------------------
function ListView({
  items,
  onOpen,
  onCopyUrl,
  onJumpToNote,
  onDownload,
  onDelete,
  onSaveRemote,
  onShare,
  copiedId,
  downloadingId,
  selectionMode,
  selectedIds,
  onToggleSelect,
  sharedIds,
}: {
  items: FileItem[];
  onOpen: (id: string) => void;
  onCopyUrl: (item: FileItem) => void;
  onJumpToNote: (noteId: string) => void;
  onDownload: (item: FileItem) => void;
  onDelete: (id: string) => void;
  /** 未传时不渲染「保存到远程」按钮 */
  onSaveRemote?: (item: FileItem) => void;
  onShare: (item: FileItem) => void;
  copiedId: string | null;
  downloadingId: string | null;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  /** 已开启分享（isActive）的附件 id 集合——“已分享”标记的数据源 */
  sharedIds: Set<string>;
}) {
  return (
    <div className="rounded-lg border border-app-border bg-app-surface overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-app-bg/60 text-tx-tertiary">
          <tr>
            {selectionMode && <th className="text-center font-normal px-2 py-2 w-8"></th>}
            <th className="text-left font-normal px-3 py-2 w-10"></th>
            <th className="text-left font-normal px-3 py-2">文件名</th>
            <th className="text-left font-normal px-3 py-2 hidden md:table-cell w-32">类型</th>
            <th className="text-right font-normal px-3 py-2 w-20">大小</th>
            <th className="text-left font-normal px-3 py-2 hidden lg:table-cell w-40">来源笔记</th>
            <th className="text-left font-normal px-3 py-2 hidden sm:table-cell w-36">上传时间</th>
            <th className="text-right font-normal px-3 py-2 w-28"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const isSelected = selectedIds.has(it.id);
            return (
              <tr
                key={it.id}
                className={cn(
                  "border-t border-app-border cursor-pointer transition-colors",
                  isSelected ? "bg-accent-primary/10 hover:bg-accent-primary/15" : "hover:bg-app-hover/50",
                )}
                onClick={() => {
                  if (selectionMode) onToggleSelect(it.id);
                  else onOpen(it.id);
                }}
              >
                {selectionMode && (
                  <td className="px-2 py-2 w-8 text-center">
                    <button
                      className={cn(
                        "w-5 h-5 rounded flex items-center justify-center transition-colors",
                        isSelected
                          ? "bg-accent-primary text-white"
                          : "border border-app-border bg-app-bg text-tx-tertiary hover:border-accent-primary",
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleSelect(it.id);
                      }}
                    >
                      {isSelected && <Check size={12} />}
                    </button>
                  </td>
                )}
                <td className="px-3 py-2 w-10">
                  <div className="w-8 h-8 rounded-md bg-app-bg flex items-center justify-center overflow-hidden">
                    {it.category === "image" ? (
                      // 列表小缩略图：32×32，优先用后端 webp 缩略（240w 显示在 32px 上完全够），
                      // 没有 thumbnailUrl 时回退原图（svg / ico / 老服务端兼容）
                      <img
                        src={resolveAttachmentUrl(it.thumbnailUrl || it.url)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-accent-primary/70">{mimeIcon(it.mimeType)}</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-tx-primary max-w-[240px]">
                  <div className="truncate" title={it.filename}>{it.filename}</div>
                </td>
                <td className="px-3 py-2 text-tx-tertiary hidden md:table-cell">
                  <span className="inline-flex items-center gap-1">
                    <span title={it.mimeType || undefined}>{MIME_CATEGORY_LABELS[resolveMimeCategory(it)]}</span>
                    {sharedIds.has(it.id) && (
                      <span
                        className="inline-flex items-center gap-0.5 rounded bg-accent-primary/10 px-1 text-[10px] text-accent-primary"
                        title="已开启只读分享链接"
                      >
                        <Share2 size={9} />
                        已分享
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-tx-secondary tabular-nums">{humanSize(it.size)}</td>
                <td className="px-3 py-2 hidden lg:table-cell text-tx-secondary">
                  {it.primaryNote ? (
                    <button
                      className="inline-flex items-center gap-1 hover:text-accent-primary transition-colors max-w-full"
                      onClick={(e) => {
                        e.stopPropagation();
                        onJumpToNote(it.primaryNote!.id);
                      }}
                      title={it.primaryNote.title}
                    >
                      {it.primaryNote.notebookIcon && <span>{it.primaryNote.notebookIcon}</span>}
                      <span className="truncate max-w-[150px]">{it.primaryNote.title || "(无标题)"}</span>
                      <ExternalLink size={10} className="shrink-0" />
                    </button>
                  ) : (
                    <span className="text-tx-tertiary">-</span>
                  )}
                </td>
                <td className="px-3 py-2 text-tx-tertiary hidden sm:table-cell">{formatLocalTime(it.createdAt)}</td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-0.5">
                    <button
                      className="p-1 rounded hover:bg-app-hover text-tx-tertiary hover:text-tx-primary disabled:opacity-50"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDownload(it);
                      }}
                      disabled={downloadingId === it.id}
                      title="下载"
                    >
                      {downloadingId === it.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    </button>
                    {onSaveRemote && (
                      <button
                        className="p-1 rounded hover:bg-app-hover text-tx-tertiary hover:text-tx-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onSaveRemote(it);
                        }}
                        title="保存到远程（WebDAV / 百度网盘）"
                      >
                        <Cloud size={12} />
                      </button>
                    )}
                    <button
                      className="p-1 rounded hover:bg-app-hover text-tx-tertiary hover:text-tx-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCopyUrl(it);
                      }}
                      title="复制链接"
                    >
                      {copiedId === it.id ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                    <button
                      className="p-1 rounded hover:bg-app-hover text-tx-tertiary hover:text-tx-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        onShare(it);
                      }}
                      title="分享"
                    >
                      <Share2 size={12} />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-red-500/10 text-tx-tertiary hover:text-red-500 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(it.id);
                      }}
                      title="删除"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 工具：提取异常文案（避免 any，风格与文件内 toast 用法一致）
// ---------------------------------------------------------------------------
/** 提取 unknown 异常的可读信息。 */
function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}
