// 附件分享链接客户端（FileManager 专用，独立成文件避免触碰 api.impl.ts）
// 请求模式仿 pluginApi.ts：getBaseUrl + fetchWithAuthRefresh
import { getBaseUrl } from "./api.impl";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";

export interface AttachmentShare {
  id: string;
  attachmentId: string;
  ownerId: string;
  shareToken: string;
  hasPassword: boolean;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

export interface AttachmentShareOpenInput {
  password?: string;
  /** ISO 时间字符串；null 表示永久有效 */
  expiresAt?: string | null;
  maxViews?: number | null;
}

export interface AttachmentShareUpdateInput {
  password?: string | null;
  expiresAt?: string | null;
  maxViews?: number | null;
  isActive?: boolean;
  resetViews?: boolean;
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

/** 分享下载直链：匿名可访问，接收方点击即下载（受密码/过期/次数约束）。 */
export function buildAttachmentShareUrl(token: string): string {
  const base = getBaseUrl();
  const path = `/attachment-shares/${encodeURIComponent(token)}/content`;
  return base.startsWith("/") ? `${window.location.origin}${base}${path}` : `${base}${path}`;
}

export const attachmentShareApi = {
  list: () => request<AttachmentShare[]>("/attachment-shares"),
  open: (attachmentId: string, input: AttachmentShareOpenInput = {}) =>
    request<AttachmentShare>("/attachment-shares", {
      method: "POST",
      body: JSON.stringify({ attachmentId, ...input }),
    }),
  update: (id: string, patch: AttachmentShareUpdateInput) =>
    request<AttachmentShare>(`/attachment-shares/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    request<{ success: boolean }>(`/attachment-shares/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
