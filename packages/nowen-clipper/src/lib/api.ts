import { normalizeBaseUrl, setConfig, type NowenClipperConfig } from "./storage";

export interface ImportNotePayload {
  title: string;
  content: string;
  contentText: string;
  contentFormat?: "markdown" | "tiptap-json";
  notebookPath?: string[];
  notebookName?: string;
  notebookId?: string;
  workspaceId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ImportResponse {
  success: boolean;
  count: number;
  notebookId: string;
  notebookIds: string[];
  notes: { id: string; title: string; notebookId: string }[];
  workspaceId?: string | null;
}

export interface LoginResponse {
  token: string;
  refreshToken?: string;
  user: {
    id: string;
    username: string;
    email: string | null;
    avatarUrl: string | null;
    displayName: string | null;
    role: string;
    createdAt: string;
    mustChangePassword?: boolean;
  };
  requires2FA?: boolean;
  ticket?: string;
  username?: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  icon?: string;
  role: "owner" | "admin" | "editor" | "viewer";
  memberCount?: number;
  notebookCount?: number;
}

export interface NotebookSummary {
  id: string;
  name: string;
  parentId: string | null;
  workspaceId?: string | null;
  userId?: string;
  isDeleted?: number;
}

export interface TagSummary {
  id: string;
  name: string;
  color?: string;
  workspaceId?: string | null;
}

export class NowenApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "NowenApiError";
  }
}

function authHeaders(cfg: NowenClipperConfig): HeadersInit {
  return {
    Authorization: `Bearer ${cfg.token}`,
    "Content-Type": "application/json",
  };
}

async function parseErr(res: Response): Promise<NowenApiError> {
  let code: string | undefined;
  let message = res.statusText;
  try {
    const data = (await res.json()) as { error?: string; code?: string };
    code = data.code;
    if (data.error) message = data.error;
  } catch {
    try {
      message = (await res.text()) || message;
    } catch {
      /* ignore */
    }
  }
  return new NowenApiError(res.status, code, `[${res.status}] ${message}`);
}

async function requestJson<T>(
  cfg: NowenClipperConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const base = normalizeBaseUrl(cfg.serverUrl);
  const send = () => fetch(`${base}/api${path}`, {
    ...init,
    headers: {
      ...authHeaders(cfg),
      ...(init.headers || {}),
    },
  });

  let res = await send();
  if (res.status === 401 && cfg.refreshToken) {
    await refreshAccessToken(cfg);
    res = await send();
  }
  if (!res.ok) throw await parseErr(res);
  return (await res.json()) as T;
}

const refreshInFlight = new Map<string, Promise<string>>();

async function refreshAccessToken(cfg: NowenClipperConfig): Promise<string> {
  const base = normalizeBaseUrl(cfg.serverUrl);
  const key = `${base}\n${cfg.refreshToken}`;
  let pending = refreshInFlight.get(key);

  if (!pending) {
    pending = (async () => {
      const res = await fetch(`${base}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: cfg.refreshToken }),
      });
      if (!res.ok) {
        const error = await parseErr(res);
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          (error as NowenApiError & { terminal?: boolean }).terminal = true;
          await setConfig({ token: "", refreshToken: "" });
        }
        throw error;
      }

      const payload = (await res.json()) as { token?: string };
      if (!payload.token) throw new Error("登录续期响应缺少访问令牌");
      cfg.token = payload.token;
      await setConfig({ token: payload.token });
      return payload.token;
    })().finally(() => refreshInFlight.delete(key));
    refreshInFlight.set(key, pending);
  }

  try {
    const token = await pending;
    cfg.token = token;
    return token;
  } catch (error) {
    if ((error as { terminal?: boolean })?.terminal) {
      cfg.token = "";
      cfg.refreshToken = "";
    }
    throw error;
  }
}

export async function login(
  serverUrl: string,
  username: string,
  password: string,
): Promise<LoginResponse> {
  const base = normalizeBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await parseErr(res);
  return (await res.json()) as LoginResponse;
}

export async function verify2FA(
  serverUrl: string,
  ticket: string,
  code: string,
): Promise<LoginResponse> {
  const base = normalizeBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/auth/2fa/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, code }),
  });
  if (!res.ok) throw await parseErr(res);
  return (await res.json()) as LoginResponse;
}

export async function ping(
  cfg: NowenClipperConfig,
): Promise<{ id?: string; username: string; role: string; displayName?: string | null }> {
  return requestJson(cfg, "/me");
}

export async function listWorkspaces(cfg: NowenClipperConfig): Promise<WorkspaceSummary[]> {
  return requestJson(cfg, "/workspaces");
}

export async function listNotebooks(
  cfg: NowenClipperConfig,
  workspaceId: string | null = null,
): Promise<NotebookSummary[]> {
  const scope = workspaceId ? encodeURIComponent(workspaceId) : "personal";
  return requestJson(cfg, `/notebooks?workspaceId=${scope}`);
}

export async function importNote(
  cfg: NowenClipperConfig,
  payload: ImportNotePayload,
): Promise<ImportResponse> {
  const body: Record<string, unknown> = {
    notes: [
      {
        title: payload.title,
        content: payload.content,
        contentText: payload.contentText,
        contentFormat: payload.contentFormat,
        notebookName: payload.notebookName,
        notebookPath: payload.notebookPath,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      },
    ],
  };
  if (payload.notebookId) body.notebookId = payload.notebookId;
  else if (payload.notebookName && !payload.notebookPath) body.notebookName = payload.notebookName;

  const scope = payload.workspaceId ? encodeURIComponent(payload.workspaceId) : "personal";
  return requestJson(cfg, `/export/import?workspaceId=${scope}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function setNotePinned(
  cfg: NowenClipperConfig,
  noteId: string,
  pinned: boolean,
): Promise<void> {
  await requestJson(cfg, `/notes/${encodeURIComponent(noteId)}`, {
    method: "PUT",
    body: JSON.stringify({ isPinned: pinned ? 1 : 0 }),
  });
}

export async function listTags(
  cfg: NowenClipperConfig,
  workspaceId: string | null,
): Promise<TagSummary[]> {
  const scope = workspaceId ? encodeURIComponent(workspaceId) : "personal";
  return requestJson(cfg, `/tags?workspaceId=${scope}&includeEmpty=true`);
}

export async function createTag(
  cfg: NowenClipperConfig,
  name: string,
  workspaceId: string | null,
): Promise<TagSummary> {
  return requestJson(cfg, "/tags", {
    method: "POST",
    body: JSON.stringify({ name, workspaceId }),
  });
}

export async function attachTag(
  cfg: NowenClipperConfig,
  noteId: string,
  tagId: string,
): Promise<void> {
  await requestJson(cfg, `/tags/note/${encodeURIComponent(noteId)}/tag/${encodeURIComponent(tagId)}`, {
    method: "POST",
    body: "{}",
  });
}

/**
 * 将标签名称落成真实 tags + note_tags。单个标签失败由调用方记录，不回滚已保存笔记。
 */
export async function ensureNoteTags(
  cfg: NowenClipperConfig,
  noteId: string,
  names: string[],
  workspaceId: string | null,
): Promise<string[]> {
  const unique = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, 20);
  if (unique.length === 0) return [];

  const failures: string[] = [];
  let existing = await listTags(cfg, workspaceId).catch(() => [] as TagSummary[]);
  for (const name of unique) {
    let tag = existing.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      try {
        tag = await createTag(cfg, name, workspaceId);
        existing = [...existing, tag];
      } catch (error: any) {
        failures.push(`${name}：${String(error?.message || error)}`);
        continue;
      }
    }
    try {
      await attachTag(cfg, noteId, tag.id);
    } catch (error: any) {
      failures.push(`${name}：${String(error?.message || error)}`);
    }
  }
  return failures;
}

export function buildNoteUrl(cfg: NowenClipperConfig, noteId: string): string {
  return `${normalizeBaseUrl(cfg.serverUrl)}/?noteId=${encodeURIComponent(noteId)}`;
}

export interface AIEnhanceRequest {
  title?: string;
  url?: string;
  siteName?: string;
  contentText: string;
  tasks: {
    summary?: boolean;
    outline?: boolean;
    tags?: boolean;
    title?: boolean;
    highlight?: boolean;
    translation?: boolean;
  };
  language?: "zh-CN" | "en";
  customInstruction?: string;
  maxInputChars?: number;
}

export interface AIEnhanceResult {
  ok: boolean;
  error?: string;
  enhanced?: {
    title?: string;
    summary?: string;
    outline?: string;
    tags?: string[];
    highlights?: string[];
    translation?: string;
  };
  model?: string;
  truncated?: boolean;
}

export async function enhanceClip(
  cfg: NowenClipperConfig,
  payload: AIEnhanceRequest,
): Promise<AIEnhanceResult> {
  return requestJson(cfg, "/ai/clip-enhance", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
