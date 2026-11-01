/**
 * 文件管理共享 UI 状态：来源、分类筛选、排序、视图、分组。
 *
 * 侧栏面板与主区 FileManager 共用：任何一端修改都持久化到 localStorage，并通过
 * subscribeFilesUi + useSyncExternalStore 通知 React 重渲染（版本号快照保证
 * 状态变化必然生效，不依赖 DOM 事件监听的生命周期时机）。
 */
import type { FileSortKey } from "@/types";

export type FilesViewMode = "grid" | "list";
/** 文件管理三大来源：本地附件 / 图床 / 插件远程文件 */
export type FilesSource = "attachments" | "imagehost" | "remote";
export type FilesGroupMode = "flat" | "notebook" | "folder";

const KEYS = {
  source: "nowen.filesUi.source",
  mimes: "nowen.filesUi.mimes",
  time: "nowen.filesUi.time",
  ihCategory: "nowen.filesUi.ihCategory",
  ihMimes: "nowen.filesUi.ihMimes",
  ihSort: "nowen.filesUi.ihSort",
  ihTime: "nowen.filesUi.ihTime",
  remoteTypes: "nowen.filesUi.remoteTypes",
  remoteTime: "nowen.filesUi.remoteTime",
  remoteSort: "nowen.filesUi.remoteSort",
  category: "nowen.filesUi.category",
  sort: "nowen.filesUi.sort",
  view: "nowen.filesUi.view",
  group: "nowen.filesUi.group",
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
  const raw = localStorage.getItem(KEYS.source) as FilesSource | null;
  return raw === "imagehost" || raw === "remote" ? raw : "attachments";
}

/** 附件来源：选中的 MIME 类型（多选，空 = 全部） */
export function getFilesMimes(): string[] {
  try { const raw = JSON.parse(localStorage.getItem(KEYS.mimes) || ""); return Array.isArray(raw) ? raw : []; } catch { return []; }
}

/** 附件来源：上传时间筛选（all/today/week/month/older） */
export function getFilesTime(): string {
  return localStorage.getItem(KEYS.time) || "all";
}

/** 图床来源：分类与排序 */
export function getFilesIhCategory(): string {
  // 图床默认只看图片（"图床"的语义就是图片直链）
  return localStorage.getItem(KEYS.ihCategory) || "image";
}

/** 图床来源：图片子类 chips（png/jpeg/webp/gif/svg，空 = 全部） */
export function getFilesIhMimes(): string[] {
  try { const raw = JSON.parse(localStorage.getItem(KEYS.ihMimes) || ""); return Array.isArray(raw) ? raw : []; } catch { return []; }
}

export function getFilesIhSort(): string {
  return localStorage.getItem(KEYS.ihSort) || "copied_desc";
}

/** 图床来源：上传时间筛选（all/today/week/month） */
export function getFilesIhTime(): string {
  return localStorage.getItem(KEYS.ihTime) || "all";
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

export function getFilesCategory(): string {
  // 清洗历史遗留：附件来源的分类不含 image/file（图片归图床）
  const raw = localStorage.getItem(KEYS.category);
  return raw === "myUploads" || raw === "unreferenced" ? raw : "all";
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

export function setFilesUi(patch: { source?: FilesSource; mimes?: string[]; time?: string; ihCategory?: string; ihMimes?: string[]; ihSort?: string; ihTime?: string; remoteTypes?: string[]; remoteSort?: FilesRemoteSortKey; remoteTime?: string; category?: string; sort?: FileSortKey; view?: FilesViewMode; group?: FilesGroupMode }): void {
  if (patch.source !== undefined) localStorage.setItem(KEYS.source, patch.source);
  if (patch.mimes !== undefined) localStorage.setItem(KEYS.mimes, JSON.stringify(patch.mimes));
  if (patch.time !== undefined) localStorage.setItem(KEYS.time, patch.time);
  if (patch.ihCategory !== undefined) localStorage.setItem(KEYS.ihCategory, patch.ihCategory);
  if (patch.ihMimes !== undefined) localStorage.setItem(KEYS.ihMimes, JSON.stringify(patch.ihMimes));
  if (patch.ihSort !== undefined) localStorage.setItem(KEYS.ihSort, patch.ihSort);
  if (patch.ihMimes !== undefined) localStorage.setItem(KEYS.ihMimes, JSON.stringify(patch.ihMimes));
  if (patch.ihTime !== undefined) localStorage.setItem(KEYS.ihTime, patch.ihTime);
  if (patch.remoteTypes !== undefined) localStorage.setItem(KEYS.remoteTypes, JSON.stringify(patch.remoteTypes));
  if (patch.remoteSort !== undefined) localStorage.setItem(KEYS.remoteSort, patch.remoteSort);
  if (patch.remoteTime !== undefined) localStorage.setItem(KEYS.remoteTime, patch.remoteTime);
  if (patch.category !== undefined) localStorage.setItem(KEYS.category, patch.category);
  if (patch.sort !== undefined) localStorage.setItem(KEYS.sort, patch.sort);
  if (patch.view !== undefined) localStorage.setItem(KEYS.view, patch.view);
  if (patch.group !== undefined) localStorage.setItem(KEYS.group, patch.group);
  emit();
}

export const FILE_SORT_OPTIONS: Array<{ value: FileSortKey; label: string }> = [
  { value: "created_desc", label: "最新上传" },
  { value: "created_asc", label: "最早上传" },
  { value: "size_desc", label: "大小 ↓" },
  { value: "size_asc", label: "大小 ↑" },
  { value: "name_asc", label: "名称 A→Z" },
  { value: "name_desc", label: "名称 Z→A" },
];

/** 附件来源的类型 chips：非图片（图片归图床）。 */
export const FILE_DOC_MIME_CHIPS: Array<{ key: string; label: string; mimes: string[] }> = [
  { key: "pdf", label: "PDF", mimes: ["application/pdf"] },
  { key: "word", label: "Word", mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword"] },
  { key: "md", label: "Markdown", mimes: ["text/markdown", "text/plain"] },
  { key: "zip", label: "压缩包", mimes: ["application/zip", "application/x-zip-compressed", "application/gzip"] },
  { key: "audio", label: "音频", mimes: ["audio/"] },
  { key: "video", label: "视频", mimes: ["video/"] },
];

/** 图床来源的类型 chips：图片子类。 */
export const FILE_IMAGE_MIME_CHIPS: Array<{ key: string; label: string; mimes: string[] }> = [
  { key: "png", label: "PNG", mimes: ["image/png"] },
  { key: "jpeg", label: "JPG", mimes: ["image/jpeg"] },
  { key: "webp", label: "WebP", mimes: ["image/webp"] },
  { key: "gif", label: "GIF", mimes: ["image/gif"] },
  { key: "svg", label: "SVG", mimes: ["image/svg+xml"] },
];

/** 把选中的 chip keys 展开成 mime 列表（audio/ video/ 前缀形式由后端 LIKE 匹配）。 */
export function expandMimeChips(chips: Array<{ key: string; label: string; mimes: string[] }>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const chip = chips.find((entry) => entry.key === key);
    if (chip) out.push(...chip.mimes);
  }
  return out;
}

/** 图床类型 chips：图片子类（FILE_IMAGE_MIME_CHIPS 的子集）。 */
export const FILE_IH_MIME_CHIPS = FILE_IMAGE_MIME_CHIPS.filter((chip) =>
  ["png", "jpeg", "webp", "gif", "svg"].includes(chip.key),
);

/** 图床排序选项（与既有 ihSort 值保持兼容）。 */
export const FILE_IH_SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "copied_desc", label: "最近复制" },
  { value: "created_desc", label: "最近上传" },
  { value: "size_desc", label: "大小 ↓" },
  { value: "name_asc", label: "名称 A→Z" },
];

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
