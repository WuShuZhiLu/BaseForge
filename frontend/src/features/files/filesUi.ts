/**
 * 文件管理共享 UI 状态：分类筛选、排序、视图、分组。
 *
 * 侧栏面板与主区 FileManager 共用：任何一端修改都持久化到 localStorage 并广播
 * nowen:files-ui，另一端监听后跟进（与回收站 trashUi 同一套模式）。
 */
import type { FileSortKey } from "@/types";

export type FilesViewMode = "grid" | "list";
export type FilesGroupMode = "flat" | "notebook" | "folder";

const KEYS = {
  category: "nowen.filesUi.category",
  sort: "nowen.filesUi.sort",
  view: "nowen.filesUi.view",
  group: "nowen.filesUi.group",
} as const;

const EVENT = "nowen:files-ui";

function emit(): void {
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function getFilesCategory(): string {
  return localStorage.getItem(KEYS.category) || "all";
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

export function setFilesUi(patch: { category?: string; sort?: FileSortKey; view?: FilesViewMode; group?: FilesGroupMode }): void {
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
