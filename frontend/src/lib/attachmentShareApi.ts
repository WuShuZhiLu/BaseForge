// 附件分享链接客户端（FileManager 专用，独立成文件避免触碰 api.impl.ts）
// 请求模式仿 pluginApi.ts：getBaseUrl + fetchWithAuthRefresh
import { getBaseUrl } from "./api.impl";
import { buildPublicWebUrl } from "./publicWebOrigin";
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

/**
 * 附件分享链接：指向访客落地页 `/fs/:token`（密码门 / 预览下载 / 失效三态）。
 * 历史上这里直接给 content 端点，无密码分享是裸下载流、带密码分享只能看到一段 JSON。
 */
export function buildAttachmentShareUrl(token: string): string {
  return buildPublicWebUrl(`/fs/${encodeURIComponent(token)}`);
}

async function publicRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  // 访客落地页是无登录场景：不附带用户 JWT，也不走 token 刷新（否则会把访客引到登录页）。
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), {
      code: payload.code,
      status: response.status,
    });
  }
  return payload as T;
}

export interface AttachmentShareMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  needPassword: boolean;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * 匿名公开端点（`/fs/:token` 访客落地页专用）：
 * meta / verify 走 JSON，content 需要返回二进制，所以单独用 fetchContent 拿 blob。
 */
export const attachmentSharePublicApi = {
  meta: (token: string) =>
    publicRequest<AttachmentShareMeta>(`/attachment-shares/${encodeURIComponent(token)}/meta`),
  verify: (token: string, password?: string) =>
    publicRequest<{ success: boolean; accessToken: string }>(
      `/attachment-shares/${encodeURIComponent(token)}/verify`,
      { method: "POST", body: JSON.stringify(password ? { password } : {}) },
    ),
  contentUrl: (token: string, download = false) =>
    `${getBaseUrl()}/attachment-shares/${encodeURIComponent(token)}/content${download ? "?download=1" : ""}`,
  fetchContent: async (token: string, accessToken: string | null, download = false): Promise<Blob> => {
    const response = await fetch(attachmentSharePublicApi.contentUrl(token, download), {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    }
    return response.blob();
  },
};

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
