import type { DatabaseSync } from "node:sqlite";

import { getDb } from "../db/schema.js";
import { syncReferences } from "../lib/attachmentRefs.js";
import { readAuthoritativeNoteContent, rebuildBlockAuthorityStore } from "../lib/blockAuthorityStore.js";
import { syncNoteBlocks } from "../lib/noteBlocks.js";
import { syncNoteLinks } from "../lib/noteLinks.js";
import { hasPermission, resolveNotePermission } from "../middleware/acl.js";
import { enqueueAttachment } from "./embedding-worker.js";
import { createKnowledgeChild, KnowledgeTreeError, type KnowledgeTreeNode } from "./knowledgeTree.js";
import {
  cleanupCopiedAttachmentObjects,
  copyReferencedNoteAttachments,
  NoteAttachmentCopyError,
  rewriteSourceAttachmentUrl,
} from "./noteAttachmentCopy.js";
import { yFlush } from "./yjs.js";
import { rebuildYjsSubdocumentsIfEnabled } from "./yjs-subdocuments.js";

/** 可复制的正文格式：文档类（含导图、画板）按原格式复制；加密/纯文本/PDF 等暂不支持。 */
const COPYABLE_FORMATS = new Set(["markdown", "tiptap-json", "mindmap", "board"]);

function assertCopyableFormat(format: string): void {
  if (COPYABLE_FORMATS.has(format)) return;
  throw new DuplicateNoteError("NOTE_DUPLICATE_FORMAT_UNSUPPORTED", 400, "暂不支持复制该格式的文档");
}

/** 副本的树节点类型必须跟着正文格式走，否则侧栏图标与打开的编辑器会错位。 */
function resolveCopyNodeType(
  contentFormat: string,
  noteType: string,
): "note" | "markdown" | "word" | "mindmap" | "board" | "sheet" {
  if (noteType === "sheet") return "sheet";
  if (noteType === "word") return "word";
  if (contentFormat === "markdown") return "markdown";
  if (contentFormat === "mindmap") return "mindmap";
  if (contentFormat === "board") return "board";
  return "note";
}

/** 新建后从未编辑的富文本正文是 `{}`，没有 Block 结构，原样写入即可。 */
function isEmptyDocumentContent(contentFormat: string, content: string): boolean {
  const trimmed = (content || "").trim();
  if (!trimmed) return true;
  if (contentFormat !== "tiptap-json") return false;
  try {
    const doc = JSON.parse(trimmed) as { type?: string };
    return doc.type !== "doc";
  } catch {
    return false;
  }
}

interface SourceNoteRow {
  id: string;
  workspaceId: string | null;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  noteType: string;
  isLocked: number;
  isTrashed: number;
  version: number;
  treeParentId: string | null;
  treeScopeKey: string;
}

export interface DuplicatedNoteResult {
  note: Record<string, unknown>;
  tags: Array<Record<string, unknown>>;
  node: KnowledgeTreeNode;
}

export class DuplicateNoteError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 403 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = "DuplicateNoteError";
  }
}

function readSourceNote(db: DatabaseSync, noteId: string): SourceNoteRow | null {
  return (db.prepare(`
    SELECT note.id, note.workspaceId, note.title,
           note.content, note.contentText, note.contentFormat,
           note.note_type AS noteType, note.isLocked,
           note.isTrashed, note.version, tree.parentId AS treeParentId,
           tree.scopeKey AS treeScopeKey
    FROM notes note
    JOIN knowledge_tree_nodes tree
      ON tree.resourceType = 'note' AND tree.resourceId = note.id AND tree.isDeleted = 0
    WHERE note.id = ?
    LIMIT 1
  `).get(noteId) as SourceNoteRow | undefined) || null;
}

function duplicateTitleBase(title: string): string {
  const normalized = title.trim() || "无标题笔记";
  return normalized.replace(/（副本(?: \d+)?）$/u, "") || normalized;
}

function nextDuplicateTitle(
  db: DatabaseSync,
  scopeKey: string,
  parentId: string | null,
  title: string,
  /** 复制到另一个目录时，目标里没有重名就保留原标题（目录深拷贝用）。 */
  keepWhenFree = false,
): string {
  const siblingTitles = db.prepare(`
    SELECT note.title
    FROM knowledge_tree_nodes tree
    JOIN notes note ON tree.resourceType = 'note' AND tree.resourceId = note.id
    WHERE tree.scopeKey = ? AND tree.isDeleted = 0 AND note.isTrashed = 0
      AND ((? IS NULL AND tree.parentId IS NULL) OR tree.parentId = ?)
  `).all(scopeKey, parentId, parentId) as Array<{ title: string }>;
  const used = new Set(siblingTitles.map((item) => item.title));
  const base = duplicateTitleBase(title);
  if (keepWhenFree && !used.has(base)) return base;
  const first = `${base}（副本）`;
  if (!used.has(first)) return first;
  let index = 2;
  while (used.has(`${base}（副本 ${index}）`)) index += 1;
  return `${base}（副本 ${index}）`;
}

/** 副本落点：默认与源笔记同级；目录深拷贝时由调用方显式指定目标目录。 */
function resolveCopyContainer(
  db: DatabaseSync,
  source: SourceNoteRow,
  targetParentId: string | null,
): { parentId: string | null; scopeKey: string } {
  if (targetParentId === null) {
    return { parentId: source.treeParentId, scopeKey: source.treeScopeKey };
  }
  const parent = db.prepare("SELECT scopeKey FROM knowledge_tree_nodes WHERE id = ? AND isDeleted = 0")
    .get(targetParentId) as { scopeKey: string } | undefined;
  if (!parent) {
    throw new DuplicateNoteError("NOTE_DUPLICATE_TARGET_NOT_FOUND", 404, "目标目录不存在");
  }
  if (parent.scopeKey !== source.treeScopeKey) {
    throw new DuplicateNoteError("NOTE_DUPLICATE_TARGET_SCOPE_MISMATCH", 409, "目标目录与源笔记不在同一空间");
  }
  return { parentId: targetParentId, scopeKey: parent.scopeKey };
}

function ensureSourceParentCanBeReused(source: SourceNoteRow, userId: string): void {
  if (source.treeParentId !== null) return;
  const actorRootScope = source.workspaceId
    ? `workspace:${source.workspaceId}`
    : `personal:${userId}`;
  if (source.treeScopeKey !== actorRootScope) {
    throw new DuplicateNoteError(
      "NOTE_DUPLICATE_PARENT_FORBIDDEN",
      403,
      "没有在源笔记所在根目录创建内容的权限",
    );
  }
}

function mapKnownError(error: unknown): never {
  if (error instanceof DuplicateNoteError) throw error;
  if (error instanceof NoteAttachmentCopyError) {
    throw new DuplicateNoteError(`NOTE_DUPLICATE_${error.code}`, error.status, error.message);
  }
  if (error instanceof KnowledgeTreeError) {
    throw new DuplicateNoteError(error.code, error.status, error.message);
  }
  throw error;
}

export async function duplicateNote(input: {
  userId: string;
  noteId: string;
  /** 指定副本落点（目录深拷贝用）。缺省时复制到源笔记同级。 */
  targetParentId?: string | null;
}): Promise<DuplicatedNoteResult> {
  const db = getDb();
  let source = readSourceNote(db, input.noteId);
  if (!source || source.isTrashed === 1) {
    throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_NOT_FOUND", 404, "源笔记不存在或已进入回收站");
  }
  const { permission } = resolveNotePermission(source.id, input.userId);
  if (!hasPermission(permission, "read")) {
    throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_FORBIDDEN", 403, "没有读取源笔记的权限");
  }
  if (source.isLocked === 1) {
    throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_LOCKED", 403, "请先解锁笔记再创建副本");
  }
  assertCopyableFormat(source.contentFormat);
  const requestedParentId = input.targetParentId ?? null;
  if (requestedParentId === null) ensureSourceParentCanBeReused(source, input.userId);

  yFlush(source.id);
  source = readSourceNote(db, input.noteId);
  if (!source || source.isTrashed === 1 || source.isLocked === 1) {
    throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_CHANGED", 409, "源笔记状态已变化，请刷新后重试");
  }
  assertCopyableFormat(source.contentFormat);
  const stableSource = source;
  const contentFormat = source.contentFormat;
  const authoritative = readAuthoritativeNoteContent(db, source.id, source.content || "").content;
  const sourceVersion = source.version;
  const copied = await copyReferencedNoteAttachments({
    db,
    userId: input.userId,
    noteId: source.id,
    content: authoritative,
  }).catch(mapKnownError);

  let content = authoritative;
  for (const attachment of copied) {
    content = rewriteSourceAttachmentUrl(
      content,
      attachment.sourceId,
      `/api/attachments/${attachment.id}`,
    );
  }

  let result: DuplicatedNoteResult | null = null;
  try {
    result = db.transaction(() => {
      const current = readSourceNote(db, stableSource.id);
      if (!current || current.isTrashed === 1 || current.isLocked === 1) {
        throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_CHANGED", 409, "源笔记状态已变化，请刷新后重试");
      }
      const currentPermission = resolveNotePermission(current.id, input.userId).permission;
      if (!hasPermission(currentPermission, "read")) {
        throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_FORBIDDEN", 403, "没有读取源笔记的权限");
      }
      if (requestedParentId === null) ensureSourceParentCanBeReused(current, input.userId);
      if (current.version !== sourceVersion
        || current.treeParentId !== stableSource.treeParentId
        || current.workspaceId !== stableSource.workspaceId
        || current.treeScopeKey !== stableSource.treeScopeKey
        || current.contentFormat !== contentFormat) {
        throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_CHANGED", 409, "源笔记已更新或移动，请重试");
      }

      const container = resolveCopyContainer(db, current, requestedParentId);
      const title = nextDuplicateTitle(db, container.scopeKey, container.parentId, current.title, requestedParentId !== null);
      const nodeType = resolveCopyNodeType(contentFormat, current.noteType);
      // 表格正文存在 sheets 表，createKnowledgeChild 建表时需要顺带写入。
      const sheetRow = nodeType === "sheet"
        ? db.prepare("SELECT data FROM sheets WHERE noteId = ?").get(current.id) as { data: string } | undefined
        : undefined;
      const created = createKnowledgeChild({
        actorUserId: input.userId,
        workspaceId: current.workspaceId,
        parentId: container.parentId,
        nodeType,
        title,
        ...(sheetRow ? { sheetData: JSON.parse(sheetRow.data) } : {}),
        db,
      });
      const createdNote = db.prepare("SELECT workspaceId, version FROM notes WHERE id = ?")
        .get(created.resourceId) as { workspaceId: string | null; version: number } | undefined;
      if (!createdNote) {
        throw new DuplicateNoteError("NOTE_DUPLICATE_CREATE_FAILED", 500, "副本创建失败");
      }

      const insertAttachment = db.prepare(`
        INSERT INTO attachments (
          id, noteId, userId, filename, mimeType, size, path, workspaceId, hash, uploadSource
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'note_duplicate')
      `);
      for (const attachment of copied) {
        insertAttachment.run(
          attachment.id,
          created.resourceId,
          input.userId,
          attachment.filename,
          attachment.mimeType,
          attachment.size,
          attachment.path,
          createdNote.workspaceId,
          attachment.hash,
        );
      }

      db.prepare(`
        INSERT OR IGNORE INTO note_tags (noteId, tagId)
        SELECT ?, tagId FROM note_tags WHERE noteId = ?
      `).run(created.resourceId, current.id);
      if (nodeType === "sheet" || isEmptyDocumentContent(contentFormat, content)) {
        // 表格与空白文档没有 Block 结构，原样写入正文，不做切块与权威源重建。
        db.prepare(`
          UPDATE notes
          SET content = ?, contentText = ?, contentFormat = ?, updatedAt = datetime('now')
          WHERE id = ?
        `).run(content, current.contentText, contentFormat, created.resourceId);
      } else {
        const synced = syncNoteBlocks(db, created.resourceId, content, contentFormat);
        db.prepare(`
          UPDATE notes
          SET content = ?, contentText = ?, contentFormat = ?, updatedAt = datetime('now')
          WHERE id = ?
        `).run(synced.content, synced.contentText, contentFormat, created.resourceId);
        syncReferences(db, created.resourceId, synced.content);
        syncNoteLinks(db, input.userId, created.resourceId, synced.content);
        // 导图/画板正文不是可物化文档，只有富文本与 Markdown 需要重建 Block 权威源。
        if (contentFormat === "markdown" || contentFormat === "tiptap-json") {
          rebuildBlockAuthorityStore(db, created.resourceId, synced.content, contentFormat, {
            noteVersion: createdNote.version,
            operationType: "create",
          });
        }
        rebuildYjsSubdocumentsIfEnabled(db, created.resourceId, synced.content, contentFormat);
      }

      const createdRecord = db.prepare(`
        SELECT id, userId, notebookId, workspaceId, title, content, contentText,
               isPinned, 0 AS isFavorite, isLocked, isArchived, isTrashed,
               version, sortOrder, createdAt, updatedAt, trashedAt, contentFormat
        FROM notes WHERE id = ?
      `).get(created.resourceId) as Record<string, unknown> | undefined;
      if (!createdRecord) {
        throw new DuplicateNoteError("NOTE_DUPLICATE_CREATE_FAILED", 500, "副本创建失败");
      }
      const createdTags = db.prepare(`
        SELECT tag.* FROM tags tag
        JOIN note_tags relation ON relation.tagId = tag.id
        WHERE relation.noteId = ?
      `).all(created.resourceId) as Array<Record<string, unknown>>;
      return { node: created, note: createdRecord, tags: createdTags };
    })();
  } catch (error) {
    await cleanupCopiedAttachmentObjects(copied);
    mapKnownError(error);
  }
  if (!result) {
    await cleanupCopiedAttachmentObjects(copied);
    throw new DuplicateNoteError("NOTE_DUPLICATE_CREATE_FAILED", 500, "副本创建失败");
  }

  for (const attachment of copied) {
    enqueueAttachment({
      attachmentId: attachment.id,
      userId: input.userId,
      workspaceId: (result.note.workspaceId as string | null) || null,
      noteId: result.node.resourceId,
    });
  }

  return result;
}
