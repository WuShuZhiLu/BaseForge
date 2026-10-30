/**
 * 版本保存服务（v134 版本来源标记）
 *
 * 职责：
 * - recordNoteSave：Ctrl+S 保存（manual）/ 定时快照（auto）统一的落记录入口，
 *   「内容与最近一条记录不同才插入」，天然幂等（同内容重复提交只留一条，
 *   打开/切换焦点不会造成内容变化）；落记录后执行相邻同内容合并兜底。
 * - markVersionAsRelease / unmarkVersionRelease：发版标记与取消。
 *   release 记录永不参与自动清理与合并；取消标记回落为 manual。
 */

import { getDb } from "../db/schema";
import {
  computeContentHash,
  noteVersionsRepository,
} from "../repositories/noteVersionsRepository";
import type { NoteVersionRecord } from "../repositories/noteVersionsRepository";

export interface RecordSaveResult {
  created: boolean;
  record: NoteVersionRecord | null;
}

interface SaveSourceNoteRow {
  id: string;
  title: string | null;
  content: string | null;
  contentText: string | null;
  contentFormat: string | null;
  version: number;
}

/**
 * 把笔记当前内容落一条版本记录（source=auto|manual）。
 *
 * 幂等规则：
 * 1. 当前内容指纹（title/contentFormat/contentText/content 的 sha1）与最近一条
 *    版本记录一致 → 不插入（重复的定时提交/Ctrl+S 只留一条）；
 * 2. 最近一条记录 contentHash 为 NULL（v124 之前的旧行）时惰性回填后再比较；
 * 3. 插入后对该笔记执行相邻同内容合并（同 source 同 hash 只留最新一条），
 *    兜底并发/重试造成的相邻重复；release 不参与合并。
 */
export function recordNoteSave(input: {
  noteId: string;
  userId: string;
  source: "auto" | "manual";
}): RecordSaveResult {
  const db = getDb();
  const note = db
    .prepare(
      `SELECT id, title, content, "contentText" AS contentText, "contentFormat" AS contentFormat, version
       FROM notes WHERE id = ? AND isTrashed = 0`,
    )
    .get(input.noteId) as SaveSourceNoteRow | undefined;
  if (!note) return { created: false, record: null };

  const latest = noteVersionsRepository.getLatestVersionByNoteId(input.noteId);
  let latestHash = latest?.contentHash ?? null;
  if (latest && !latestHash) {
    latestHash = noteVersionsRepository.ensureContentHash(latest.id);
  }
  const currentHash = computeContentHash({
    title: note.title,
    content: note.content,
    contentText: note.contentText,
    contentFormat: note.contentFormat,
  });
  // 内容无变化：不落记录
  if (latestHash && latestHash === currentHash) {
    return { created: false, record: null };
  }

  const created = noteVersionsRepository.createTypedVersion({
    noteId: input.noteId,
    userId: input.userId,
    kind: input.source,
    source: input.source,
    changeType: "edit",
    snapshot: {
      title: note.title ?? "",
      content: note.content ?? "",
      contentText: note.contentText ?? "",
      contentFormat: note.contentFormat || "tiptap-json",
      version: note.version,
    },
  });

  // 相邻同内容合并兜底（只影响 auto/manual，release 永不删）
  try {
    noteVersionsRepository.mergeAdjacentSameContent(input.noteId);
  } catch (error) {
    console.warn(
      "[version-save] mergeAdjacentSameContent failed:",
      error instanceof Error ? error.message : error,
    );
  }

  return { created: true, record: noteVersionsRepository.getByIdAndNoteId(created.id, input.noteId) ?? null };
}

export interface MarkReleaseResult {
  ok: boolean;
  record: NoteVersionRecord | null;
}

/** 标记某条版本为 release（发版）。record 不存在或 noteId 不匹配时 ok=false。 */
export function markVersionAsRelease(noteId: string, versionId: string): MarkReleaseResult {
  const ok = noteVersionsRepository.setVersionSource(noteId, versionId, "release");
  return { ok, record: ok ? noteVersionsRepository.getByIdAndNoteId(versionId, noteId) ?? null : null };
}

/** 取消 release 标记：回落为 manual（该记录此后按 manual 保留策略参与清理）。 */
export function unmarkVersionRelease(noteId: string, versionId: string): MarkReleaseResult {
  const ok = noteVersionsRepository.setVersionSource(noteId, versionId, "manual");
  return { ok, record: ok ? noteVersionsRepository.getByIdAndNoteId(versionId, noteId) ?? null : null };
}
