/**
 * 分享中心共享 UI 状态：分类（状态 / 对象类型 / 风险）、快捷筛选、排序。
 *
 * 原型 share-redesign-v1 ① 的左栏与主区共用同一份筛选：侧栏面板点分类，
 * 主区列表跟着变。做法与 features/files/filesUi.ts 一致 —— localStorage 持久化 +
 * 版本号订阅（useSyncExternalStore），不依赖 DOM 事件的生命周期时机。
 */
import type {
  ShareCenterChannel,
  ShareCenterObjectKind,
  ShareCenterQuery,
  ShareCenterRisk,
  ShareCenterStatusGroup,
} from "@/lib/shareCenter";
import { shareObjectKindLabel, shareRiskLabel } from "@/lib/shareCenter";

export type ShareCenterGroup = ShareCenterStatusGroup | "all";
/** 主区工具行的快捷 chips，对标原型「全部 / 仅查看 / 可评论 / 可编辑 / 有密码 / 7 天内到期」。 */
export type ShareCenterQuick = "all" | "view" | "comment" | "edit" | "password" | "expiring";
export type ShareCenterSortKey = NonNullable<ShareCenterQuery["sort"]>;

const KEYS = {
  group: "baseforge.shareCenter.group",
  objectKind: "baseforge.shareCenter.objectKind",
  risk: "baseforge.shareCenter.risk",
  quick: "baseforge.shareCenter.quick",
  sort: "baseforge.shareCenter.sort",
} as const;

let uiVersion = 0;
const uiListeners = new Set<() => void>();

export function subscribeShareCenterUi(cb: () => void): () => void {
  uiListeners.add(cb);
  return () => { uiListeners.delete(cb); };
}

export function getShareCenterUiVersion(): number {
  return uiVersion;
}

function emit(): void {
  uiVersion++;
  uiListeners.forEach((listener) => listener());
}

export function getShareGroup(): ShareCenterGroup {
  const raw = localStorage.getItem(KEYS.group);
  return raw === "active" || raw === "attention" || raw === "disabled" ? raw : "all";
}

export function getShareObjectKind(): ShareCenterObjectKind | "all" {
  const raw = localStorage.getItem(KEYS.objectKind);
  return raw === "note" || raw === "file" || raw === "notebook" ? raw : "all";
}

export function getShareRisk(): ShareCenterRisk | "all" {
  const raw = localStorage.getItem(KEYS.risk);
  return raw === "open_ended" || raw === "orphan" || raw === "unused" || raw === "bare" ? raw : "all";
}

export function getShareQuick(): ShareCenterQuick {
  const raw = localStorage.getItem(KEYS.quick);
  return raw === "view" || raw === "comment" || raw === "edit" || raw === "password" || raw === "expiring"
    ? raw
    : "all";
}

/** 默认排序对齐原型：最近访问。 */
export function getShareSort(): ShareCenterSortKey {
  const raw = localStorage.getItem(KEYS.sort);
  return raw === "updatedAt" || raw === "createdAt" || raw === "expiresAt" || raw === "viewCount" || raw === "title"
    ? raw
    : "lastSeenAt";
}

export function setShareCenterUi(patch: {
  group?: ShareCenterGroup;
  objectKind?: ShareCenterObjectKind | "all";
  risk?: ShareCenterRisk | "all";
  quick?: ShareCenterQuick;
  sort?: ShareCenterSortKey;
}): void {
  if (patch.group !== undefined) localStorage.setItem(KEYS.group, patch.group);
  if (patch.objectKind !== undefined) localStorage.setItem(KEYS.objectKind, patch.objectKind);
  if (patch.risk !== undefined) localStorage.setItem(KEYS.risk, patch.risk);
  if (patch.quick !== undefined) localStorage.setItem(KEYS.quick, patch.quick);
  if (patch.sort !== undefined) localStorage.setItem(KEYS.sort, patch.sort);
  emit();
}

/** 主区标题用的分类名：原型「全部分享 / 生效中 …」。 */
export function shareGroupTitle(group: ShareCenterGroup): string {
  switch (group) {
    case "active":
      return "生效中";
    case "attention":
      return "需要处理";
    case "disabled":
      return "已停用";
    default:
      return "全部分享";
  }
}

/**
 * 主区标题：跟着当前分类走（风险 > 对象类型 > 状态）。
 * 以前固定写「全部分享」，带着筛选时会变成「全部分享 0 条」这种自相矛盾的标题。
 */
export function shareCenterScopeTitle(): string {
  const risk = getShareRisk();
  if (risk !== "all") return shareRiskLabel(risk);
  const objectKind = getShareObjectKind();
  if (objectKind !== "all") return shareObjectKindLabel(objectKind);
  return shareGroupTitle(getShareGroup());
}

/** 快捷 chips：与原型一致，单选（再点一次回到「全部」）。 */
export const SHARE_QUICK_CHIPS: Array<{ key: ShareCenterQuick; label: string }> = [
  { key: "all", label: "全部" },
  { key: "view", label: "仅查看" },
  { key: "comment", label: "可评论" },
  { key: "edit", label: "可编辑" },
  { key: "password", label: "有密码" },
  { key: "expiring", label: "7 天内到期" },
];

export const SHARE_SORT_OPTIONS: Array<{ value: ShareCenterSortKey; label: string }> = [
  { value: "lastSeenAt", label: "最近访问" },
  { value: "updatedAt", label: "最近更新" },
  { value: "createdAt", label: "创建时间" },
  { value: "expiresAt", label: "到期时间" },
  { value: "viewCount", label: "访问次数" },
  { value: "title", label: "标题" },
];

/**
 * 从其它页面跳到分享中心时「要直接打开哪一条」的待办。
 * 原型落地顺序第 3 条：附件列表行内的「分享」入口不能另开一套对话框，
 * 而是带着对象身份跳到这里，由 ShareManagementPage 消费后打开同一抽屉。
 */
export interface ShareCenterFocus {
  channel: ShareCenterChannel;
  objectId: string;
}

let pendingFocus: ShareCenterFocus | null = null;

export function focusShareCenter(target: ShareCenterFocus): void {
  pendingFocus = target;
  emit();
}

/** 取一次即清：抽屉只开一次，不会因为重新挂载又弹回来。 */
export function takeShareCenterFocus(): ShareCenterFocus | null {
  const target = pendingFocus;
  pendingFocus = null;
  return target;
}

/** 快捷 chip 落到后端查询参数上（后端已支持这三个独立维度）。 */
export function shareQuickQuery(quick: ShareCenterQuick): Pick<ShareCenterQuery, "permission" | "hasPassword" | "expiresWithinDays"> {
  switch (quick) {
    case "view":
      return { permission: "view" };
    case "comment":
      return { permission: "comment" };
    case "edit":
      return { permission: "edit" };
    case "password":
      return { hasPassword: true };
    case "expiring":
      return { expiresWithinDays: 7 };
    default:
      return {};
  }
}
