import type Database from "better-sqlite3";
import type { Context, Next } from "hono";

import { getDb } from "../db/schema.js";

type FilesScope =
  | { kind: "personal"; workspaceId: null }
  | { kind: "workspace"; workspaceId: string };

type ReferenceNote = {
  id: string;
  title: string;
  notebookId: string | null;
  notebookName: string | null;
  notebookIcon: string | null;
  isTrashed: number;
};

const MANUAL_UPLOAD_SOURCE = "file_manager";

function resolveScope(c: Context): FilesScope {
  const workspaceId = (c.req.query("workspaceId") || "").trim();
  return workspaceId
    ? { kind: "workspace", workspaceId }
    : { kind: "personal", workspaceId: null };
}

function appendAttachmentScope(
  where: string[],
  params: Array<string | number>,
  scope: FilesScope,
  userId: string,
  alias = "a",
): void {
  if (scope.kind === "workspace") {
    where.push(`${alias}.workspaceId = ?`);
    params.push(scope.workspaceId);
  } else {
    where.push(`${alias}.userId = ?`, `${alias}.workspaceId IS NULL`);
    params.push(userId);
  }
}

function appendNoteScope(
  where: string[],
  params: Array<string | number>,
  scope: FilesScope,
  userId: string,
  alias = "n",
): void {
  if (scope.kind === "workspace") {
    where.push(`${alias}.workspaceId = ?`);
    params.push(scope.workspaceId);
  } else {
    where.push(`${alias}.userId = ?`, `${alias}.workspaceId IS NULL`);
    params.push(userId);
  }
}

/**
 * 返回当前真正引用附件的首篇笔记。attachments.noteId 只是上传时归属，不能作为
 * “来源笔记/引用笔记”展示；删除正文图片后 attachment_references 会立即清掉。
 */
export function getCurrentReferenceNotes(
  db: Database.Database,
  attachmentIds: string[],
  scope: FilesScope,
  userId: string,
): Map<string, ReferenceNote> {
  const uniqueIds = Array.from(new Set(attachmentIds.filter(Boolean)));
  const result = new Map<string, ReferenceNote>();
  if (uniqueIds.length === 0) return result;

  const placeholders = uniqueIds.map(() => "?").join(",");
  const where = [`ar.attachmentId IN (${placeholders})`];
  const params: Array<string | number> = [...uniqueIds];
  appendNoteScope(where, params, scope, userId, "n");

  const rows = db.prepare(`
    SELECT ar.attachmentId,
           n.id,
           n.title,
           n.notebookId,
           n.isTrashed,
           n.updatedAt,
           nb.name AS notebookName,
           nb.icon AS notebookIcon
      FROM attachment_references ar
      INNER JOIN notes n ON n.id = ar.noteId
      LEFT JOIN notebooks nb ON nb.id = n.notebookId
     WHERE ${where.join(" AND ")}
     ORDER BY n.isTrashed ASC, n.updatedAt DESC, n.id ASC
  `).all(...params) as Array<{
    attachmentId: string;
    id: string;
    title: string;
    notebookId: string | null;
    isTrashed: number;
    updatedAt: string;
    notebookName: string | null;
    notebookIcon: string | null;
  }>;

  for (const row of rows) {
    if (result.has(row.attachmentId)) continue;
    result.set(row.attachmentId, {
      id: row.id,
      title: row.title || "",
      notebookId: row.notebookId,
      notebookName: row.notebookName,
      notebookIcon: row.notebookIcon,
      isTrashed: Number(row.isTrashed || 0),
    });
  }
  return result;
}

/** 返回本批附件里由文件管理手动上传、因此受自动清理保护的 id。 */
export function getProtectedManualUploadIds(
  db: Database.Database,
  attachmentIds: string[],
  scope: FilesScope,
  userId: string,
): Set<string> {
  const uniqueIds = Array.from(new Set(attachmentIds.filter(Boolean)));
  const result = new Set<string>();
  if (uniqueIds.length === 0) return result;

  const placeholders = uniqueIds.map(() => "?").join(",");
  const where = [
    `a.id IN (${placeholders})`,
    "a.uploadSource = ?",
  ];
  const params: Array<string | number> = [...uniqueIds, MANUAL_UPLOAD_SOURCE];
  appendAttachmentScope(where, params, scope, userId);

  const rows = db.prepare(`
    SELECT a.id
      FROM attachments a
     WHERE ${where.join(" AND ")}
  `).all(...params) as Array<{ id: string }>;

  for (const row of rows) result.add(row.id);
  return result;
}

function replaceJsonResponse(c: Context, payload: unknown): void {
  const original = c.res;
  const headers = new Headers(original.headers);
  headers.set("Content-Type", "application/json; charset=UTF-8");
  headers.delete("Content-Length");
  c.res = new Response(JSON.stringify(payload), {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

function isFilesRoot(pathname: string): boolean {
  return /\/api\/files\/?$/.test(pathname);
}

function isFilesStats(pathname: string): boolean {
  return /\/api\/files\/stats\/?$/.test(pathname);
}

function isFilesDetail(pathname: string): boolean {
  return /\/api\/files\/[^/]+\/?$/.test(pathname) && !isFilesStats(pathname);
}

/**
 * 该中间件在原 filesRouter（及知识树收口层）完成鉴权后修正响应：
 * - 列表“来源笔记”：改成当前真实引用（attachments.noteId 只是上传归属）；
 * - 列表和详情：为文件管理手动上传下发受保护标记，供 UI 展示绿色盾牌。
 *
 * 这里不再重建“未引用”列表或统计。历史上它用过一套“倒排表 NOT EXISTS 且
 * uploadSource<>file_manager”的孤儿口径覆盖收口层结果，结果是：侧栏「文档引用」
 * 走内容扫描、「未引用」走倒排表且排除手动上传——从文件管理上传的文件永远不进
 * 「未引用」（实测返回空），两个分类也不再互补。清理口径（含 24h 宽限与手动
 * 上传保护）只属于 `/api/data-file/cleanup-orphans`。
 */
export async function fileOrphanVisibilityMiddleware(c: Context, next: Next): Promise<void> {
  await next();

  if (c.req.method !== "GET" || !c.res.ok) return;
  const pathname = new URL(c.req.url).pathname;
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return;

  const db = getDb();
  const scope = resolveScope(c);

  if (isFilesRoot(pathname)) {
    let payload: any;
    try {
      payload = await c.res.clone().json();
    } catch {
      return;
    }
    if (!Array.isArray(payload?.items) || payload.items.length === 0) return;

    const ids = payload.items
      .map((item: any) => typeof item?.id === "string" ? item.id : "")
      .filter(Boolean);
    const references = getCurrentReferenceNotes(db, ids, scope, userId);
    const protectedIds = getProtectedManualUploadIds(db, ids, scope, userId);
    payload.items = payload.items.map((item: any) => {
      const protectedManualUpload = protectedIds.has(item.id);
      return {
        ...item,
        primaryNote: references.get(item.id) || null,
        isManualUpload: protectedManualUpload,
        isAutoCleanupProtected: protectedManualUpload,
      };
    });
    replaceJsonResponse(c, payload);
    return;
  }

  if (isFilesDetail(pathname)) {
    let payload: any;
    try {
      payload = await c.res.clone().json();
    } catch {
      return;
    }
    const id = typeof payload?.id === "string" ? payload.id : "";
    if (!id) return;

    // 详情接口已经由原 filesRouter 完成用户/工作区可见性校验。这里直接读取该行的
    // 保留策略，避免工作区详情请求没有携带 workspaceId 时被误按个人空间判断。
    const retentionRow = db.prepare(
      "SELECT uploadSource FROM attachments WHERE id = ?",
    ).get(id) as { uploadSource: string | null } | undefined;
    const protectedManualUpload = retentionRow?.uploadSource === MANUAL_UPLOAD_SOURCE;

    payload.isManualUpload = protectedManualUpload;
    payload.isAutoCleanupProtected = protectedManualUpload;
    replaceJsonResponse(c, payload);
  }
}
