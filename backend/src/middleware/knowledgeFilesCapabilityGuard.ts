import type { Context, Next } from "hono";

import { getDb } from "../db/schema.js";
import { createUserAttachmentAccessUrls } from "../lib/attachment-signed-url.js";
import { scanAttachmentReferences } from "../lib/attachment-reference-scan.js";
import {
  buildMimeCategoryWhere,
  getMimeCategory,
  isMimeCategory,
  type MimeCategory,
} from "../lib/mime-category.js";
import {
  appendIdSetWhere,
  buildKeywordWhere,
  buildShareStatusWhere,
  resolveFileListOrderBy,
} from "../lib/file-list-sql.js";
import {
  hasKnowledgeCapability,
  resolveResourceKnowledgeAccess,
} from "../services/knowledgeCapabilities.js";

type FileScope = {
  scope: "personal" | "workspace";
  workspaceId: string | null;
};

type FileListDbRow = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
  noteId: string;
  folderId: string | null;
  hash: string | null;
  noteTitle: string | null;
  notebookId: string | null;
  isTrashed: number | null;
  notebookName: string | null;
  notebookIcon: string | null;
  folderName: string | null;
  /** 引用该附件的笔记数（attachment_references 倒排表计数），仅列表查询选出。 */
  refCount?: number;
};

const THUMBNAILABLE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/bmp",
  "image/gif",
]);

function replaceJsonResponse(c: Context, payload: unknown, status = c.res.status): void {
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.set("cache-control", "private, no-store");
  c.res = new Response(JSON.stringify(payload), {
    status,
    statusText: c.res.statusText,
    headers,
  });
}

async function readJsonResponse(c: Context): Promise<any | null> {
  if (!c.res.ok) return null;
  const contentType = c.res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    return await c.res.clone().json();
  } catch {
    return null;
  }
}

function attachmentNoteId(attachmentId: string): string | null {
  const row = getDb().prepare("SELECT noteId FROM attachments WHERE id = ?")
    .get(attachmentId) as { noteId: string } | undefined;
  return row?.noteId || null;
}

function noteIdFromFileRow(row: any): string | null {
  if (typeof row?.noteId === "string") return row.noteId;
  if (typeof row?.primaryNote?.id === "string") return row.primaryNote.id;
  if (typeof row?.id === "string") return attachmentNoteId(row.id);
  return null;
}

function accessForNote(noteId: string, userId: string) {
  return resolveResourceKnowledgeAccess("note", noteId, userId);
}

function canViewFileRow(row: any, userId: string): boolean {
  const noteId = noteIdFromFileRow(row);
  return Boolean(noteId && hasKnowledgeCapability(accessForNote(noteId, userId), "canView"));
}

function canDownloadAttachment(attachmentId: string, userId: string): boolean {
  const noteId = attachmentNoteId(attachmentId);
  return Boolean(noteId && hasKnowledgeCapability(accessForNote(noteId, userId), "canDownload"));
}

function filterAccessUrls(value: unknown, userId: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([attachmentId, url]) =>
      typeof url === "string" && canDownloadAttachment(attachmentId, userId),
    ),
  ) as Record<string, string>;
}

function sanitizeFileRow(row: any, userId: string): any | null {
  if (!canViewFileRow(row, userId)) return null;
  const attachmentId = typeof row?.id === "string" ? row.id : "";
  const downloadable = attachmentId ? canDownloadAttachment(attachmentId, userId) : false;
  const references = Array.isArray(row?.references)
    ? row.references.filter((reference: any) => {
        const noteId = typeof reference?.id === "string"
          ? reference.id
          : (typeof reference?.noteId === "string" ? reference.noteId : "");
        return noteId && hasKnowledgeCapability(accessForNote(noteId, userId), "canView");
      })
    : row?.references;

  if (downloadable) return { ...row, references, downloadAllowed: true };
  const sanitized = { ...row, references, downloadAllowed: false };
  delete sanitized.url;
  delete sanitized.thumbnailUrl;
  delete sanitized.downloadUrl;
  return sanitized;
}

function visibleAttachmentStats(workspaceId: string | null, userId: string) {
  const db = getDb();
  const rows = workspaceId
    ? db.prepare(`
        SELECT a.id, a.noteId, a.mimeType, a.size
        FROM attachments a
        JOIN notes n ON n.id = a.noteId
        WHERE a.workspaceId = ?
      `).all(workspaceId)
    : db.prepare(`
        SELECT a.id, a.noteId, a.mimeType, a.size
        FROM attachments a
        JOIN notes n ON n.id = a.noteId
        WHERE a.workspaceId IS NULL AND a.userId = ?
      `).all(userId) as Array<{ id: string; noteId: string; mimeType: string; size: number }>;

  // 侧栏「文档引用 / 未引用」两个徽标必须跟点进去的列表同源：两者都来自
  // 同一次内容扫描（严格互补，相加就是全部），并且同样经过笔记可见性过滤。
  const scan = scanAttachmentReferences(
    db,
    { scope: workspaceId ? "workspace" : "personal", workspaceId },
    userId,
  );

  const byMime = new Map<string, { count: number; bytes: number }>();
  let total = 0;
  let totalBytes = 0;
  let imageCount = 0;
  let imageBytes = 0;
  let fileCount = 0;
  let fileBytes = 0;
  let referencedCount = 0;
  let referencedBytes = 0;
  let unreferencedCount = 0;
  let unreferencedBytes = 0;

  for (const row of rows as Array<{ id: string; noteId: string; mimeType: string; size: number }>) {
    const access = accessForNote(row.noteId, userId);
    if (!hasKnowledgeCapability(access, "canView")) continue;
    total += 1;
    totalBytes += Number(row.size || 0);
    const bytes = Number(row.size || 0);
    if (scan.referencedIds.has(row.id)) {
      referencedCount += 1;
      referencedBytes += bytes;
    } else if (scan.orphanIds.has(row.id)) {
      unreferencedCount += 1;
      unreferencedBytes += bytes;
    }
    const mime = row.mimeType || "application/octet-stream";
    const stats = byMime.get(mime) || { count: 0, bytes: 0 };
    stats.count += 1;
    stats.bytes += bytes;
    byMime.set(mime, stats);
    if (mime.toLowerCase().startsWith("image/")) {
      imageCount += 1;
      imageBytes += bytes;
    } else {
      fileCount += 1;
      fileBytes += bytes;
    }
  }

  return {
    total,
    totalBytes,
    images: { count: imageCount, bytes: imageBytes },
    files: { count: fileCount, bytes: fileBytes },
    referenced: { count: referencedCount, bytes: referencedBytes },
    unreferenced: { count: unreferencedCount, bytes: unreferencedBytes },
    byMime: [...byMime.entries()].map(([mime, value]) => ({ mime, ...value })),
  };
}

function normalizePositiveInteger(value: string | undefined, fallback: number, max?: number): number {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
  return max ? Math.min(max, normalized) : normalized;
}

function fileScope(c: Context): FileScope {
  const rawWorkspaceId = (c.req.query("workspaceId") || "").trim();
  return rawWorkspaceId && rawWorkspaceId !== "personal"
    ? { scope: "workspace", workspaceId: rawWorkspaceId }
    : { scope: "personal", workspaceId: null };
}

function toFileOut(row: FileListDbRow): Record<string, unknown> {
  const mime = (row.mimeType || "").toLowerCase();
  const image = mime.startsWith("image/");
  const output: Record<string, unknown> = {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt,
    category: image ? "image" : "file",
    mimeCategory: getMimeCategory(row.mimeType),
    url: `/api/attachments/${row.id}`,
    hash: row.hash ?? null,
    folderId: row.folderId ?? null,
    folderName: row.folderName ?? null,
    primaryNote: row.noteId
      ? {
          id: row.noteId,
          title: row.noteTitle ?? "",
          notebookId: row.notebookId,
          notebookName: row.notebookName,
          notebookIcon: row.notebookIcon,
          isTrashed: row.isTrashed ?? 0,
        }
      : null,
  };
  if (typeof row.refCount === "number") {
    // 与 routes/files.ts 一致：列表项下发引用计数，供“文档引用”视图展示。
    output.referenceCount = row.refCount;
  }
  if ((image && THUMBNAILABLE_MIMES.has(mime)) || mime.startsWith("video/")) {
    // 图片走 sharp 缩放；视频走 ffmpeg 首帧海报（与 routes/files.ts 对齐）
    output.thumbnailUrl = `/api/attachments/${row.id}?w=240`;
  }
  return output;
}

/**
 * Rebuild the root file list from the complete candidate set. The legacy route applies
 * LIMIT/OFFSET before the knowledge-tree guard runs, so filtering only payload.items can
 * produce empty pages and a false total. Access must be resolved before pagination.
 *
 * 参数口径必须跟 routes/files.ts 对齐——这一层会整体重建响应，这里没认得的
 * query 参数就等于在应用里不存在（实测：mimeCategory / shareStatus / filter=referenced
 * / sort=referenced_desc 曾在此被静默丢弃）。mime-category / file-list-sql /
 * attachment-reference-scan 三个 lib 就是为了让两层不会再次各自漂移。
 */
function visibleFileList(c: Context, userId: string) {
  const db = getDb();
  const scope = fileScope(c);
  const category = (c.req.query("category") || "all").toLowerCase();
  // 统一文件池的类型筛选；mimeCategory 优先于已弃用的 category（两者不叠加）。
  const mimeCategoryRaw = (c.req.query("mimeCategory") || "").toLowerCase();
  const mimeCategory: MimeCategory | null = isMimeCategory(mimeCategoryRaw)
    ? mimeCategoryRaw
    : null;
  const filter = (c.req.query("filter") || "").toLowerCase();
  const mime = (c.req.query("mime") || "").toLowerCase();
  const shareStatusRaw = (c.req.query("shareStatus") || "").toLowerCase();
  const shareStatus = shareStatusRaw === "shared" || shareStatusRaw === "unshared"
    ? shareStatusRaw
    : null;
  const uploadedWithin = Number(c.req.query("uploadedWithin") || 0);
  const notebookId = c.req.query("notebookId") || "";
  const noteId = c.req.query("noteId") || "";
  const folderId = c.req.query("folderId") || "";
  const q = (c.req.query("q") || "").trim();
  const page = normalizePositiveInteger(c.req.query("page"), 1);
  const pageSize = normalizePositiveInteger(c.req.query("pageSize"), 50, 200);
  const whereParts: string[] = [];
  const params: Array<string | number> = [];

  if (scope.scope === "workspace") {
    whereParts.push("a.workspaceId = ?");
    params.push(scope.workspaceId!);
  } else {
    whereParts.push("a.userId = ?", "a.workspaceId IS NULL");
    params.push(userId);
  }

  if (mimeCategory) {
    const cond = buildMimeCategoryWhere(mimeCategory);
    whereParts.push(cond.sql);
    params.push(...cond.params);
  } else if (category === "image") {
    whereParts.push("a.mimeType LIKE 'image/%'");
  } else if (category === "file") {
    whereParts.push("(a.mimeType IS NULL OR a.mimeType NOT LIKE 'image/%')");
  }
  if (mime) {
    whereParts.push("a.mimeType = ?");
    params.push(mime);
  }
  if (notebookId) {
    whereParts.push("n.notebookId = ?");
    params.push(notebookId);
  }
  if (q) {
    // 搜索框同时命中文件名和 MIME 类型（输 "pdf" / "video/" 也能找到）
    whereParts.push(buildKeywordWhere());
    params.push(`%${q}%`, `%${q}%`);
  }
  if (Number.isFinite(uploadedWithin) && uploadedWithin > 0) {
    whereParts.push("a.createdAt >= datetime('now', ?)");
    params.push(`-${Math.floor(uploadedWithin)} days`);
  }
  if (noteId) {
    whereParts.push(
      "(a.noteId = ? OR EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id AND ar.noteId = ?))",
    );
    params.push(noteId, noteId);
  }
  if (folderId === "__unarchived") {
    whereParts.push("a.folderId IS NULL");
  } else if (folderId) {
    whereParts.push("a.folderId = ?");
    params.push(folderId);
  }
  // 「文档引用 / 未引用」两个分类来自同一次内容扫描，严格互补；空集也必须
  // 落成 `1 = 0`，不能省略条件（否则退化成返回全部附件）。
  if (filter === "unreferenced" || filter === "referenced") {
    const scan = scanAttachmentReferences(db, scope, userId);
    appendIdSetWhere(whereParts, params, filter === "unreferenced" ? scan.orphanIds : scan.referencedIds);
  }
  if (shareStatus) {
    whereParts.push(buildShareStatusWhere(shareStatus));
  }
  if (filter === "myuploads") {
    whereParts.push("a.uploadSource = ?");
    params.push("file_manager");
    const referenceFilter = (c.req.query("myUploadsRef") || "").toLowerCase();
    if (referenceFilter === "referenced") {
      whereParts.push("EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id)");
    } else if (referenceFilter === "unreferenced") {
      whereParts.push("NOT EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id)");
    }
  }

  const rows = db.prepare(`
    SELECT a.id, a.filename, a.mimeType, a.size, a.path, a.createdAt, a.hash,
           a.noteId, a.folderId,
           n.title AS noteTitle, n.notebookId, n.isTrashed,
           nb.name AS notebookName, nb.icon AS notebookIcon,
           af.name AS folderName,
           (SELECT COUNT(*) FROM attachment_references ar
                WHERE ar.attachmentId = a.id) AS refCount
    FROM attachments a
    LEFT JOIN notes n ON n.id = a.noteId
    LEFT JOIN notebooks nb ON nb.id = n.notebookId
    LEFT JOIN attachment_folders af ON af.id = a.folderId
    WHERE ${whereParts.join(" AND ")}
    ORDER BY ${resolveFileListOrderBy(c.req.query("sort"))}
  `).all(...params) as FileListDbRow[];

  const accessCache = new Map<string, { canView: boolean; canDownload: boolean }>();
  const permissions = (noteIdValue: string) => {
    const cached = accessCache.get(noteIdValue);
    if (cached) return cached;
    const access = accessForNote(noteIdValue, userId);
    const resolved = {
      canView: hasKnowledgeCapability(access, "canView"),
      canDownload: hasKnowledgeCapability(access, "canDownload"),
    };
    accessCache.set(noteIdValue, resolved);
    return resolved;
  };

  const visibleRows = rows.filter((row) => row.noteId && permissions(row.noteId).canView);
  const start = (page - 1) * pageSize;
  const pageRows = visibleRows.slice(start, start + pageSize);
  const items = pageRows.map((row) => {
    const output = toFileOut(row);
    if (permissions(row.noteId).canDownload) return { ...output, downloadAllowed: true };
    delete output.url;
    delete output.thumbnailUrl;
    return { ...output, downloadAllowed: false };
  });
  const downloadableRows = pageRows.filter((row) => permissions(row.noteId).canDownload);

  return {
    items,
    accessUrls: createUserAttachmentAccessUrls(userId, downloadableRows),
    total: visibleRows.length,
    page,
    pageSize,
  };
}

/** Filter file-manager metadata and signed URLs through the owning note's access. */
export async function enforceKnowledgeFilesVisibility(c: Context, next: Next): Promise<void> {
  if (c.req.method.toUpperCase() !== "GET") {
    await next();
    return;
  }

  await next();
  const payload = await readJsonResponse(c);
  if (!payload || typeof payload !== "object") return;
  const userId = c.req.header("X-User-Id") || "";
  const path = c.req.path.replace(/\/+$/, "");

  if (path === "/api/files") {
    replaceJsonResponse(c, visibleFileList(c, userId));
    return;
  }

  if (path.endsWith("/stats")) {
    const rawWorkspaceId = (c.req.query("workspaceId") || "").trim();
    const workspaceId = rawWorkspaceId && rawWorkspaceId !== "personal" ? rawWorkspaceId : null;
    // referenced / unreferenced 现在由本层按可见性算出（旧写法把它们写死为 0，
    // 侧栏「未引用」徽标会永远是 0，点进去却有文件）。
    replaceJsonResponse(c, {
      ...payload,
      ...visibleAttachmentStats(workspaceId, userId),
    });
    return;
  }

  if (Array.isArray(payload.items)) {
    const items = payload.items
      .map((row: any) => sanitizeFileRow(row, userId))
      .filter(Boolean);
    replaceJsonResponse(c, {
      ...payload,
      items,
      accessUrls: filterAccessUrls(payload.accessUrls, userId),
      total: items.length,
    });
    return;
  }

  if (typeof payload.id === "string") {
    const sanitized = sanitizeFileRow(payload, userId);
    if (!sanitized) {
      replaceJsonResponse(c, { error: "文件不存在", code: "FILE_NOT_FOUND" }, 404);
      return;
    }
    replaceJsonResponse(c, {
      ...sanitized,
      accessUrls: filterAccessUrls(payload.accessUrls, userId),
    });
  }
}
