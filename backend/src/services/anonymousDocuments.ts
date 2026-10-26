import type Database from "better-sqlite3";
import { deleteAttachmentFilesByNoteIds } from "../routes/attachments.js";
import { yDestroyDoc } from "./yjs.js";

/**
 * 匿名文档（isUnlisted = 1）的引用扫描与回收。
 *
 * 匿名文档只通过宿主笔记里的 wiki 嵌入块（![[board:<id>]] / ![[mindmap:<id>]] /
 * ![[sheet:<id>]]）被引用，没有知识树节点。宿主删除块或笔记后，文档变成孤儿。
 *
 * 判定方式与附件 GC 一致：从"有主"的笔记（isUnlisted = 0）出发做引用可达性
 * 遍历，只有完全不可达的匿名文档才会被回收。这样：
 *   - 匿名文档引用另一个匿名文档时，父文档存活则子文档也存活；
 *   - 回收父文档后，子文档在同一轮里也会被识别为孤儿；
 *   - 回收站里的宿主仍算引用方，恢复笔记时嵌入块不会失效。
 *
 * 宽限期（默认 24 小时）用于覆盖"先创建文档、紧接着插入块"的窗口，
 * 也避免用户误删块后短时间无法撤销。
 */
const EMBED_REF_RE = /\b(?:board|mindmap|sheet):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/** SQLite datetime('now') 返回的是 UTC 但没有时区标记，直接 new Date 会按本地时间解析。 */
function parseSqliteTimestamp(value: string): number {
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(value) ? value : value.replace(" ", "T") + "Z";
  return new Date(normalized).getTime();
}

export function extractEmbeddedDocumentIds(content: string | null | undefined): string[] {
  if (!content) return [];
  const ids = new Set<string>();
  for (const match of content.matchAll(EMBED_REF_RE)) {
    ids.add(match[1].toLowerCase());
  }
  return [...ids];
}

interface NoteRefRow {
  id: string;
  content: string | null;
  isUnlisted: number;
  createdAt: string;
}

/**
 * 返回可以安全回收的匿名笔记 id。
 *
 * 只读：调用方负责删除磁盘附件与数据库行。
 */
export function findOrphanAnonymousNoteIds(
  db: Database.Database,
  options: { graceHours?: number } = {},
): string[] {
  // 绝大多数资料库没有匿名文档：先做一次轻量存在性检查，避免每次保存都扫全部正文。
  if (!db.prepare("SELECT 1 FROM notes WHERE isUnlisted = 1 LIMIT 1").get()) return [];

  const rows = db.prepare(
    "SELECT id, content, isUnlisted, createdAt FROM notes",
  ).all() as NoteRefRow[];

  const byId = new Map(rows.map((row) => [row.id, row]));
  const refsById = new Map(rows.map((row) => [row.id, extractEmbeddedDocumentIds(row.content)]));

  // 从所有"有主"笔记出发，沿嵌入引用做可达性遍历。
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const row of rows) {
    if (row.isUnlisted !== 1) {
      reachable.add(row.id);
      queue.push(row.id);
    }
  }
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const ref of refsById.get(current) || []) {
      if (!byId.has(ref) || reachable.has(ref)) continue;
      reachable.add(ref);
      queue.push(ref);
    }
  }

  const graceHours = options.graceHours ?? 24;
  const cutoff = Date.now() - graceHours * 60 * 60 * 1000;
  return rows
    .filter((row) => row.isUnlisted === 1 && !reachable.has(row.id))
    .filter((row) => {
      const created = parseSqliteTimestamp(row.createdAt);
      return !Number.isFinite(created) || created <= cutoff;
    })
    .map((row) => row.id);
}

/**
 * 回收孤儿匿名文档：先删磁盘附件（DB 行删除后 path 就查不到了），
 * 再删 notes 行，最后释放可能存在的内存 Y.Doc。
 *
 * 调用方负责在宿主内容变化 / 永久删除之后触发；失败只记录日志，不影响主请求。
 */
export function sweepOrphanAnonymousNotes(db: Database.Database): void {
  try {
    const ids = findOrphanAnonymousNoteIds(db);
    if (ids.length === 0) return;
    try {
      deleteAttachmentFilesByNoteIds(ids);
    } catch (error) {
      console.warn("[anonymous-docs.gc] deleteAttachmentFilesByNoteIds failed:", error);
    }
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM notes WHERE id IN (${placeholders}) AND isUnlisted = 1`).run(...ids);
    for (const id of ids) {
      try { yDestroyDoc(id); } catch { /* ignore */ }
    }
  } catch (error) {
    console.warn("[anonymous-docs.gc] sweep failed:", error);
  }
}
