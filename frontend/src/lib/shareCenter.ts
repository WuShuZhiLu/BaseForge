// 分享中心客户端（五通道聚合列表 + 批量处置）
// ---------------------------------------------------------------------------
// 请求模式仿 attachmentShareApi.ts：getBaseUrl + fetchWithAuthRefresh，
// 独立成文件避免触碰 api.impl.ts。文案翻译也收在这里，页面只用语义码。
import { getBaseUrl } from "./api.impl";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";

export type ShareCenterChannel =
  | "note_share"
  | "attachment_share"
  | "file_share"
  | "notebook_invite"
  | "notebook_publication"
  /** 附件原件自带的免登录直链：不是分享记录，不能停用/删除。 */
  | "attachment_bare";

export type ShareCenterObjectKind = "note" | "file" | "notebook";
export type ShareCenterStatus = "active" | "disabled" | "expired" | "exhausted" | "orphan";
export type ShareCenterStatusGroup = "active" | "attention" | "disabled";
export type ShareCenterRisk = "open_ended" | "orphan" | "unused" | "bare";
export type ShareCenterAccess = "link" | "password" | "code" | "public" | "members";
export type ShareCenterPermission =
  | "view"
  | "comment"
  | "edit"
  | "edit_auth"
  | "download"
  | "preview"
  | "member_viewer"
  | "member_editor";

export type ShareCenterBatchAction = "disable" | "delete" | "expire";

export interface ShareCenterItem {
  id: string;
  channel: ShareCenterChannel;
  objectKind: ShareCenterObjectKind;
  objectId: string;
  title: string | null;
  objectPath: string;
  token: string;
  urlPath: string;
  access: ShareCenterAccess;
  permission: ShareCenterPermission;
  hasPassword: boolean;
  isActive: boolean;
  /** file_shares / 公开出版不计数，为 null。 */
  viewCount: number | null;
  maxViews: number | null;
  lastSeenAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  objectMissing: boolean;
  objectTrashed: boolean;
  status: ShareCenterStatus;
  risks: ShareCenterRisk[];
  capabilities: { download: boolean; comment: boolean; edit: boolean; reshare: boolean } | null;
}

export interface ShareCenterCounts {
  total: number;
  groups: Record<ShareCenterStatusGroup, number>;
  statuses: Record<ShareCenterStatus, number>;
  objects: Record<ShareCenterObjectKind, number>;
  risks: Record<ShareCenterRisk, number>;
}

export interface ShareCenterResponse {
  items: ShareCenterItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: ShareCenterCounts;
  /** 附件免登录直链（/api/attachments/:id）：不是分享记录，既不计数也无法撤销。 */
  bareAttachmentUrls: { count: number; revocable: boolean };
}

export interface ShareCenterQuery {
  q?: string;
  group?: ShareCenterStatusGroup;
  objectKind?: ShareCenterObjectKind;
  permission?: ShareCenterPermission;
  hasPassword?: boolean;
  risk?: ShareCenterRisk;
  expiresWithinDays?: number;
  sort?: "lastSeenAt" | "updatedAt" | "createdAt" | "expiresAt" | "viewCount" | "title";
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface ShareCenterVisit {
  session: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  ipPrefix: string | null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const response = await fetchWithAuthRefresh(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init.headers || {}),
    },
  }, getBaseUrl());
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), {
    code: payload.code,
    status: response.status,
  });
  return payload as T;
}

function buildQuery(query: ShareCenterQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "" || value === "all") continue;
    params.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export const shareCenterApi = {
  list: (query: ShareCenterQuery = {}) => request<ShareCenterResponse>(`/share-center${buildQuery(query)}`),
  batch: (
    action: ShareCenterBatchAction,
    items: Array<{ channel: ShareCenterChannel; id: string }>,
    expiresAt?: string,
  ) => request<{ succeeded: number; failed: number; requested: number }>("/share-center/batch", {
    method: "POST",
    body: JSON.stringify({ action, items, ...(expiresAt ? { expiresAt } : {}) }),
  }),
  /** 抽屉「访问记录」：只有笔记分享有会话表，其余通道返回 supported=false。 */
  visits: (channel: ShareCenterChannel, id: string, limit = 5) =>
    request<{ total: number; visits: ShareCenterVisit[]; supported: boolean; failedAttempts: number }>(
      `/share-center/${channel}/${encodeURIComponent(id)}/visits?limit=${limit}`,
    ),
  /** 按被分享对象定位单条：附件/文件列表里的「分享」入口跳中心抽屉时用。 */
  item: (channel: ShareCenterChannel, objectId: string) =>
    request<{ item: ShareCenterItem | null }>(
      `/share-center/item?channel=${channel}&objectId=${encodeURIComponent(objectId)}`,
    ),
};

/** 新建分享的默认有效期，与后端 lib/share-defaults.ts 的 SHARE_DEFAULT_EXPIRY_DAYS 同一个值。 */
export const SHARE_DEFAULT_EXPIRY_DAYS = 7;

export function shareExpiresInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function shareStatusMeta(status: ShareCenterStatus): { label: string; className: string } {
  switch (status) {
    case "disabled":
      return { label: "已停用", className: "border-zinc-400/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300" };
    case "expired":
      return { label: "已过期", className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" };
    case "exhausted":
      return { label: "次数耗尽", className: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300" };
    case "orphan":
      return { label: "原对象已失效", className: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300" };
    default:
      return { label: "生效中", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" };
  }
}

export function shareObjectKindLabel(kind: ShareCenterObjectKind): string {
  if (kind === "note") return "笔记";
  return kind === "file" ? "文件" : "目录";
}

export function shareRiskLabel(risk: ShareCenterRisk): string {
  if (risk === "open_ended") return "无密码且永久";
  if (risk === "orphan") return "原对象已删";
  if (risk === "bare") return "附件裸直链";
  return "从未被访问";
}

export function shareAccessLabel(access: ShareCenterAccess): string {
  switch (access) {
    case "password":
      return "知道链接并输入密码的人";
    case "code":
      return "持有访问码的人";
    case "public":
      return "公开可浏览";
    case "members":
      return "登录后持链接加入";
    default:
      return "知道链接的人";
  }
}

export function sharePermissionLabel(permission: ShareCenterPermission): string {
  switch (permission) {
    case "comment":
      return "可评论";
    case "edit":
      return "访客可编辑";
    case "edit_auth":
      return "登录后可编辑";
    case "download":
      return "可下载";
    case "preview":
      return "仅预览";
    case "member_viewer":
      return "只读协作";
    case "member_editor":
      return "可编辑协作";
    default:
      return "仅查看";
  }
}

/** 访问列：不计数的通道显示「—」，不能谎报成 0 次。 */
export function formatShareViews(item: ShareCenterItem): string {
  if (item.viewCount === null) return "—";
  return item.maxViews === null ? `${item.viewCount} 次` : `${item.viewCount} / ${item.maxViews}`;
}

export function formatShareExpiry(expiresAt: string | null): string {
  if (!expiresAt) return "永久";
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return "—";
  const diffDays = Math.round((at - Date.now()) / 86_400_000);
  if (at <= Date.now()) return diffDays <= 0 ? `已过期 ${Math.abs(diffDays) || 1} 天` : "已过期";
  if (diffDays <= 0) return "今天到期";
  return `${diffDays} 天后到期`;
}

export function formatShareLastSeen(lastSeenAt: string | null): string | null {
  if (!lastSeenAt) return null;
  const at = Date.parse(lastSeenAt);
  if (!Number.isFinite(at)) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}
