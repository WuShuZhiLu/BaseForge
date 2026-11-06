/**
 * 文件管理共享 UI 状态：来源、类型筛选、排序、视图、分组。
 *
 * 侧栏面板与主区 FileManager 共用：任何一端修改都持久化到 localStorage，并通过
 * subscribeFilesUi + useSyncExternalStore 通知 React 重渲染（版本号快照保证
 * 状态变化必然生效，不依赖 DOM 事件监听的生命周期时机）。
 *
 * 统一文件池（v1.0 文件管理重设计）：
 *   - 来源从三来源（附件 / 图床 / 远程）收敛为「文件 + 远程」两个；
 *   - 文件类型（图片 / 视频 / 音频 / 文档 / 其他）从"分隔容器"降级为"筛选维度"，
 *     单一选中（不像旧版那样每个来源各维护一套 chips 状态）。
 */
import type { FileShareStatus, FileSortKey, MimeCategory } from "@/types";

export type FilesViewMode = "grid" | "list";
/**
 * 文件管理视图来源：
 *   - "all"    ：统一文件池（本地附件与原图床文件混排，不再按上传方式分隔）
 *   - "remote" ：插件远程文件（WebDAV / 百度网盘 / SMB），认证模型不同，保持独立入口
 */
export type FilesSource = "all" | "remote";
export type FilesGroupMode = "flat" | "notebook" | "folder";
/** 统一类型 chips 的选中值："all" = 不按类型过滤。 */
export type FilesTypeFilter = MimeCategory | "all";

const KEYS = {
  source: "nowen.filesUi.source",
  type: "nowen.filesUi.unifiedType",
  category: "nowen.filesUi.category",
  share: "nowen.filesUi.share",
  time: "nowen.filesUi.time",
  sort: "nowen.filesUi.sort",
  view: "nowen.filesUi.view",
  group: "nowen.filesUi.group",
  remoteTypes: "nowen.filesUi.remoteTypes",
  remoteTime: "nowen.filesUi.remoteTime",
  remoteSort: "nowen.filesUi.remoteSort",
  remoteSource: "nowen.filesUi.remoteSource",
} as const;

/** 三来源时代的遗留键：只在首次读取时用于迁移，不再写入。 */
const LEGACY_KEYS = {
  ihCategory: "nowen.filesUi.ihCategory",
} as const;

// ===== useSyncExternalStore 接口：版本号 + 订阅 =====
let uiVersion = 0;
const uiListeners = new Set<() => void>();

export function subscribeFilesUi(cb: () => void): () => void {
  uiListeners.add(cb);
  return () => { uiListeners.delete(cb); };
}

export function getFilesUiVersion(): number {
  return uiVersion;
}

function emit(): void {
  uiVersion++;
  uiListeners.forEach((listener) => listener());
}

export function getFilesSource(): FilesSource {
  // 兼容旧值："attachments" / "imagehost" 一律并入统一文件池。
  return localStorage.getItem(KEYS.source) === "remote" ? "remote" : "all";
}

function isFilesTypeFilter(raw: string | null): raw is FilesTypeFilter {
  return raw === "all" || raw === "image" || raw === "video" || raw === "audio" || raw === "doc" || raw === "other";
}

/** 统一类型筛选（图片/视频/音频/文档/其他），默认"全部"。 */
export function getFilesType(): FilesTypeFilter {
  const raw = localStorage.getItem(KEYS.type);
  if (isFilesTypeFilter(raw)) return raw;
  // 首次升级：旧图床只展示图片（ihCategory 默认 "image"），迁移成"类型=图片"；
  // 其余情况保持"全部"，避免用户升级后突然看到一个被筛空的列表。
  const migrated: FilesTypeFilter = localStorage.getItem(LEGACY_KEYS.ihCategory) === "image" ? "image" : "all";
  localStorage.setItem(KEYS.type, migrated);
  return migrated;
}

/**
 * 范围筛选（与类型维度正交）：全部 / 我的上传 / 文档引用 / 未引用。
 * "referenced" 与 "unreferenced" 在后端用同一次内容扫描，严格互补。
 */
export function getFilesCategory(): string {
  const raw = localStorage.getItem(KEYS.category);
  return raw === "myUploads" || raw === "unreferenced" || raw === "referenced" ? raw : "all";
}

/** 分享状态筛选（all/shared/unshared），默认不筛。 */
export function getFilesShare(): FileShareStatus | "all" {
  const raw = localStorage.getItem(KEYS.share);
  return raw === "shared" || raw === "unshared" ? raw : "all";
}

/** 上传时间筛选（all/today/week/month）。 */
export function getFilesTime(): string {
  return localStorage.getItem(KEYS.time) || "all";
}

export function getFilesSort(): FileSortKey {
  return (localStorage.getItem(KEYS.sort) as FileSortKey) || "created_desc";
}

export function getFilesViewMode(): FilesViewMode {
  return (localStorage.getItem(KEYS.view) as FilesViewMode) || "list";
}

export function getFilesGroupMode(): FilesGroupMode {
  // 兼容旧键：用户此前的分组偏好迁移过来
  const legacy = (() => { try { return localStorage.getItem("nowen-file-group"); } catch { return null; } })();
  return (localStorage.getItem(KEYS.group) as FilesGroupMode) || (legacy as FilesGroupMode) || "flat";
}

/** 远程来源：类型 chips（多选，空 = 全部） */
export function getFilesRemoteTypes(): string[] {
  try { const raw = JSON.parse(localStorage.getItem(KEYS.remoteTypes) || ""); return Array.isArray(raw) ? raw : []; } catch { return []; }
}

export function getFilesRemoteTime(): string {
  return localStorage.getItem(KEYS.remoteTime) || "all";
}

export function getFilesRemoteSort(): FilesRemoteSortKey {
  return (localStorage.getItem(KEYS.remoteSort) as FilesRemoteSortKey) || "name_asc";
}

/** 远程来源：当前选中的存储（源 id）；空串 = 用第一个源。侧栏「存储」分组与主区共用。 */
export function getFilesRemoteSourceId(): string {
  return localStorage.getItem(KEYS.remoteSource) || "";
}

export function setFilesUi(patch: { source?: FilesSource; type?: FilesTypeFilter; category?: string; share?: FileShareStatus | "all"; time?: string; sort?: FileSortKey; view?: FilesViewMode; group?: FilesGroupMode; remoteTypes?: string[]; remoteSort?: FilesRemoteSortKey; remoteTime?: string; remoteSourceId?: string }): void {
  if (patch.source !== undefined) localStorage.setItem(KEYS.source, patch.source);
  if (patch.type !== undefined) localStorage.setItem(KEYS.type, patch.type);
  if (patch.category !== undefined) localStorage.setItem(KEYS.category, patch.category);
  if (patch.share !== undefined) localStorage.setItem(KEYS.share, patch.share);
  if (patch.time !== undefined) localStorage.setItem(KEYS.time, patch.time);
  if (patch.sort !== undefined) localStorage.setItem(KEYS.sort, patch.sort);
  if (patch.view !== undefined) localStorage.setItem(KEYS.view, patch.view);
  if (patch.group !== undefined) localStorage.setItem(KEYS.group, patch.group);
  if (patch.remoteTypes !== undefined) localStorage.setItem(KEYS.remoteTypes, JSON.stringify(patch.remoteTypes));
  if (patch.remoteSort !== undefined) localStorage.setItem(KEYS.remoteSort, patch.remoteSort);
  if (patch.remoteTime !== undefined) localStorage.setItem(KEYS.remoteTime, patch.remoteTime);
  if (patch.remoteSourceId !== undefined) localStorage.setItem(KEYS.remoteSource, patch.remoteSourceId);
  emit();
}

export const FILE_SORT_OPTIONS: Array<{ value: FileSortKey; label: string }> = [
  { value: "created_desc", label: "最新上传" },
  { value: "created_asc", label: "最早上传" },
  { value: "size_desc", label: "大小 ↓" },
  { value: "size_asc", label: "大小 ↑" },
  { value: "name_asc", label: "名称 A→Z" },
  { value: "name_desc", label: "名称 Z→A" },
  { value: "referenced_desc", label: "最近引用" },
];

/** 分享状态 chips（侧栏「分享状态」分组）。 */
export const FILE_SHARE_OPTIONS: Array<{ value: FileShareStatus | "all"; label: string }> = [
  { value: "all", label: "全部" },
  { value: "shared", label: "已分享" },
  { value: "unshared", label: "未分享" },
];

/** 统一类型 chips（作用于整个文件池，不再按来源区分）。 */
export const FILE_TYPE_CHIPS: Array<{ key: FilesTypeFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "image", label: "图片" },
  { key: "video", label: "视频" },
  { key: "audio", label: "音频" },
  { key: "doc", label: "文档" },
  { key: "other", label: "其他" },
];

/** 类型大类的展示文案（列表"类型"列 / 卡片类型标签共用）。 */
export const MIME_CATEGORY_LABELS: Record<MimeCategory, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  doc: "文档",
  other: "其他",
};

/**
 * 取文件记录的类型大类：后端 /api/files 已下发 mimeCategory，
 * 老服务端缺席时按 MIME 前缀粗判兜底（与后端 getMimeCategory 的主干一致）。
 */
export function resolveMimeCategory(item: { mimeCategory?: MimeCategory; mimeType?: string }): MimeCategory {
  if (item.mimeCategory) return item.mimeCategory;
  const mime = (item.mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/")) return "doc";
  return "other";
}

export type FilesRemoteSortKey = "name_asc" | "name_desc" | "modified_desc" | "size_desc";

/** 远程来源排序选项（前端对 entries 排序）。 */
export const FILE_REMOTE_SORT_OPTIONS: Array<{ value: FilesRemoteSortKey; label: string }> = [
  { value: "name_asc", label: "名称 A→Z" },
  { value: "name_desc", label: "名称 Z→A" },
  { value: "modified_desc", label: "修改时间 ↓" },
  { value: "size_desc", label: "大小 ↓" },
];

export type FilesRemoteTypeKey = "doc" | "image" | "archive" | "other";

/** 远程来源类型 chips（按文件名后缀归类；空选 = 全部）。 */
export const FILE_REMOTE_TYPE_CHIPS: Array<{ key: FilesRemoteTypeKey; label: string }> = [
  { key: "doc", label: "文档" },
  { key: "image", label: "图片" },
  { key: "archive", label: "压缩包" },
  { key: "other", label: "其他" },
];

/** 按文件名后缀归类远程文件（文件夹不参与类型过滤）。 */
export function remoteTypeOf(name: string): FilesRemoteTypeKey {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["md", "markdown", "txt", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "rtf", "html", "htm"].includes(ext)) return "doc";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico", "avif"].includes(ext)) return "image";
  if (["zip", "gz", "tgz", "tar", "rar", "7z", "bz2", "xz"].includes(ext)) return "archive";
  return "other";
}

/** 远程来源的客户端过滤（类型 chips + 搜索 + 修改时间）与排序；文件夹始终置顶。 */
export function filterSortRemoteEntries<T extends { name: string; isFolder: boolean; size: number; modifiedAt: string | null }>(
  entries: T[],
  query: string,
  types: string[],
  sort: FilesRemoteSortKey,
  timeFilter = "all",
): T[] {
  const q = query.trim().toLowerCase();
  const typeSet = new Set(types);
  const timeMatch = (modifiedAt: string | null): boolean => {
    if (timeFilter === "all") return true;
    if (!modifiedAt) return false;
    const modified = Date.parse(modifiedAt);
    if (Number.isNaN(modified)) return false;
    const days = (Date.now() - modified) / 86400000;
    if (timeFilter === "today") return days < 1;
    if (timeFilter === "week") return days < 7;
    if (timeFilter === "month") return days < 30;
    return days >= 30;
  };
  const folders = entries.filter((e) => e.isFolder);
  const files = entries.filter((e) => !e.isFolder)
    .filter((e) => (typeSet.size ? typeSet.has(remoteTypeOf(e.name)) : true))
    .filter((e) => timeMatch(e.modifiedAt))
    .filter((e) => (q ? e.name.toLowerCase().includes(q) : true));
  const timeOf = (e: { modifiedAt: string | null }) => (e.modifiedAt ? Date.parse(e.modifiedAt) || 0 : 0);
  files.sort((a, b) => {
    if (sort === "name_asc") return a.name.localeCompare(b.name);
    if (sort === "name_desc") return b.name.localeCompare(a.name);
    if (sort === "size_desc") return b.size - a.size;
    return timeOf(b) - timeOf(a); // modified_desc
  });
  return [...folders, ...files];
}
