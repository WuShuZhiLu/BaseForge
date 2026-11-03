/**
 * 回收站共享 UI 逻辑：类型映射、emoji、保留期倒计时、类型筛选的跨组件同步。
 *
 * 侧栏面板与主区 TrashPage 共用：类型筛选多选状态存 localStorage，
 * 变更时广播 nowen:trash-filter；保留期设置同理（nowen:trash-settings）。
 */

export type TrashTypeKey = "rich" | "markdown" | "mindmap" | "plain" | "board" | "sheet" | "word" | "pdf" | "attach";
/** 侧栏/主区共享的类型筛选值：类型键 + "all"。 */
export type TrashTypeFilterKey = "all" | TrashTypeKey;

export const TRASH_TYPE_META: Array<{ key: TrashTypeKey; emoji: string; label: string }> = [
  { key: "rich", emoji: "📄", label: "富文本" },
  { key: "markdown", emoji: "📝", label: "Markdown" },
  { key: "mindmap", emoji: "🧠", label: "脑图" },
  { key: "plain", emoji: "🗒️", label: "纯文本" },
  { key: "board", emoji: "🎨", label: "画板" },
  { key: "sheet", emoji: "📊", label: "表格" },
  { key: "word", emoji: "📘", label: "Word" },
  { key: "pdf", emoji: "📕", label: "PDF" },
  { key: "attach", emoji: "📎", label: "附件" },
];

/** 按内容格式归类；附件（resourceType=attachment/file）单独一类，未知格式回落富文本。 */
export function trashTypeKey(resourceType: string, contentFormat: string | null): TrashTypeKey {
  if (resourceType === "attachment" || resourceType === "file") return "attach";
  switch (contentFormat) {
    case "markdown": return "markdown";
    case "mindmap": return "mindmap";
    case "plain": return "plain";
    case "board": return "board";
    case "pdf": return "pdf";
    case "docx": return "word";
    default: return resourceType === "notebook" ? "rich" : resourceType === "mindmap" ? "mindmap" : "rich";
  }
}

export function trashTypeEmoji(key: TrashTypeKey): string {
  return TRASH_TYPE_META.find((meta) => meta.key === key)?.emoji || "📄";
}

export function trashTypeLabel(key: TrashTypeKey): string {
  return TRASH_TYPE_META.find((meta) => meta.key === key)?.label || "富文本";
}

// ===== 保留期 =====

const RETENTION_KEY = "trash.retentionDays";
export const TRASH_RETENTION_DEFAULT = 30;
export const TRASH_RETENTION_OPTIONS = [30, 60, 90] as const;

export function getRetentionDays(): number {
  const raw = Number(localStorage.getItem(RETENTION_KEY));
  return TRASH_RETENTION_OPTIONS.includes(raw as never) || raw === 365 ? raw : TRASH_RETENTION_DEFAULT;
}

export function setRetentionDays(days: number): void {
  localStorage.setItem(RETENTION_KEY, String(days));
  window.dispatchEvent(new CustomEvent("nowen:trash-settings"));
}

/** 剩余保留天数：按删除时间 + 保留期推算，至少 0。 */
export function retentionDaysLeft(deletedAt: string | null, retentionDays: number): number {
  if (!deletedAt) return retentionDays;
  const deleted = new Date(deletedAt).getTime();
  if (Number.isNaN(deleted)) return retentionDays;
  return Math.max(0, retentionDays - Math.floor((Date.now() - deleted) / 86400000));
}

/** 倒计时颜色：红=≤3 天、黄=≤8 天、绿=其它。 */
export function retentionColor(daysLeft: number): string {
  return daysLeft <= 3 ? "#d83931" : daysLeft <= 8 ? "#b7791f" : "#2e9e5b";
}

// ===== 类型筛选同步（侧栏 ⇄ 主区） =====

const FILTER_KEY = "trash.typeFilter";

export function getTrashTypeFilter(): TrashTypeFilterKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) || "");
    return Array.isArray(raw) && raw.length ? raw : ["all"];
  } catch {
    return ["all"];
  }
}

export function setTrashTypeFilter(keys: TrashTypeFilterKey[]): void {
  localStorage.setItem(FILTER_KEY, JSON.stringify(keys.length ? keys : ["all"]));
  window.dispatchEvent(new CustomEvent("nowen:trash-filter"));
}

// ===== 删除时间筛选（单选，侧栏 ⇄ 主区同步） =====

export type TrashTimeFilter = "all" | "today" | "week" | "month" | "older";
export const TRASH_TIME_META: Array<{ key: TrashTimeFilter; label: string }> = [
  { key: "today", label: "今天" },
  { key: "week", label: "近 7 天" },
  { key: "month", label: "近 30 天" },
  { key: "older", label: "更早" },
];
const TIME_KEY = "trash.timeFilter";

export function getTrashTimeFilter(): TrashTimeFilter {
  const raw = localStorage.getItem(TIME_KEY) as TrashTimeFilter | null;
  return raw && TRASH_TIME_META.some((meta) => meta.key === raw) ? raw : "all";
}

export function setTrashTimeFilter(value: TrashTimeFilter): void {
  localStorage.setItem(TIME_KEY, value);
  window.dispatchEvent(new CustomEvent("nowen:trash-filter"));
}

export function trashTimeMatches(deletedAt: string | null, timeFilter: TrashTimeFilter): boolean {
  if (timeFilter === "all" || !deletedAt) return timeFilter === "all" ? true : !deletedAt;
  const deleted = new Date(deletedAt).getTime();
  if (Number.isNaN(deleted)) return false;
  const days = (Date.now() - deleted) / 86400000;
  if (timeFilter === "today") return days < 1;
  if (timeFilter === "week") return days < 7;
  if (timeFilter === "month") return days < 30;
  return days >= 30;
}

// ===== 自动清理设置开关 =====

const SETTINGS_KEY = "trash.settings";

export function getTrashSetting(key: "notifyExpiry" | "weeklySummary"): boolean {
  try {
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Record<string, boolean>;
    return settings[key] ?? key === "notifyExpiry";
  } catch {
    return key === "notifyExpiry";
  }
}

export function setTrashSetting(key: "notifyExpiry" | "weeklySummary", value: boolean): void {
  let settings: Record<string, boolean> = {};
  try { settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Record<string, boolean>; } catch { /* 首次使用 */ }
  settings[key] = value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent("nowen:trash-settings"));
}

/** 排序（对齐文件管理的排序 chips；TrashItem 无 size 字段，先只做时间/名称两维） */
export type TrashSortFilter = "deletedDesc" | "deletedAsc" | "nameAsc" | "nameDesc" | "sizeDesc" | "sizeAsc";
export const TRASH_SORT_META: Array<{ key: TrashSortFilter; label: string }> = [
  { key: "deletedDesc", label: "最近删除" },
  { key: "deletedAsc", label: "最早删除" },
  { key: "nameAsc", label: "名称 A-Z" },
  { key: "nameDesc", label: "名称 Z-A" },
  { key: "sizeDesc", label: "大小 ↓" },
  { key: "sizeAsc", label: "大小 ↑" },
];
const SORT_KEY = "trash.sortFilter";

export function getTrashSortFilter(): TrashSortFilter {
  const raw = localStorage.getItem(SORT_KEY) as TrashSortFilter | null;
  return raw && TRASH_SORT_META.some((meta) => meta.key === raw) ? raw : "deletedDesc";
}

export function setTrashSortFilter(value: TrashSortFilter): void {
  localStorage.setItem(SORT_KEY, value);
  window.dispatchEvent(new CustomEvent("nowen:trash-filter"));
}

export function sortTrashItems<T extends { title: string; deletedAt: string | null; size?: number | null }>(items: T[], sort: TrashSortFilter): T[] {
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (sort === "nameAsc" || sort === "nameDesc") {
      const cmp = a.title.localeCompare(b.title, "zh-Hans-CN");
      return sort === "nameAsc" ? cmp : -cmp;
    }
    if (sort === "sizeDesc" || sort === "sizeAsc") {
      const as = a.size ?? -1;
      const bs = b.size ?? -1;
      const cmp = as - bs || a.title.localeCompare(b.title, "zh-Hans-CN");
      return sort === "sizeDesc" ? -cmp : cmp;
    }
    const at = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
    const bt = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
    return sort === "deletedDesc" ? bt - at : at - bt;
  });
  return sorted;
}
