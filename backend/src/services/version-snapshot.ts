/**
 * 版本历史 v2 —— 自动快照定时服务
 *
 * 参考 calendar-export.ts 的启动模式：进程内单实例 setInterval，随服务启动注册
 * （index.ts startVersionSnapshotScheduler）。每轮：
 *   1) 读取 version_history_settings；
 *   2) 粗筛「updatedAt 晚于最新版本 createdAt」的未删除笔记（分批），
 *      JS 侧做精确判断：最新版本距今 ≥ interval 分钟且当前内容 hash ≠ 最新版本
 *      hash 时，用 createTypedVersion(kind='auto', changeType='edit') 落一条版本；
 *   3) 遇到 contentHash 为 NULL 的旧版本顺带回填（惰性回填）；
 *   4) 每日一次执行保留策略（只清 auto，manual 永不参与）并清扫悬空附件引用。
 */

import { getDb } from "../db/schema";
import fs from "node:fs";
import path from "node:path";
import { computeContentHash, noteVersionsRepository } from "../repositories/noteVersionsRepository";
import { readVersionHistorySettings } from "./version-history-settings";
import { getAttachmentsDir as getStorageAttachmentsDir } from "./attachment-storage";

const TICK_INTERVAL_MS = 60_000;
const FIRST_RUN_DELAY_MS = 15_000;
const SCAN_BATCH_SIZE = 200;

let schedulerIntervalHandle: ReturnType<typeof setInterval> | null = null;
let isRoundRunning = false;
let lastRetentionRunDate: string | null = null;

interface SnapshotCandidateRow {
  id: string;
  userId: string;
  title: string | null;
  content: string | null;
  contentText: string | null;
  contentFormat: string | null;
  version: number;
  lastVersionId: string;
  lastContentHash: string | null;
  lastCreatedAt: string;
}

/** SQLite datetime('now') / JS ISO 两种形态都能解析；与 notes.ts 合并窗口同规则。 */
function parseSqliteTimestamp(value: string): number {
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(value) ? value : value.replace(" ", "T") + "Z";
  return new Date(normalized).getTime();
}

export async function runVersionSnapshotOnce(): Promise<{ scanned: number; created: number; backfilled: number }> {
  const settings = readVersionHistorySettings();
  const intervalMs = settings.autoVersionIntervalMinutes * 60 * 1000;
  const db = getDb();

  // 粗筛：只处理「已有版本且 updatedAt 晚于最新版本 createdAt」的未删除笔记。
  // 没有任何版本的笔记不参与（首条版本由保存/手动路径产生），避免首轮全库灌版本。
  const rows = db
    .prepare(
      `SELECT n.id, n."userId" AS userId, n.title, n.content, n."contentText" AS contentText,
              n."contentFormat" AS contentFormat, n.version,
              v.id AS lastVersionId, v."contentHash" AS lastContentHash, v."createdAt" AS lastCreatedAt
       FROM notes n
       JOIN note_versions v ON v.id = (
         SELECT nv.id FROM note_versions nv WHERE nv."noteId" = n.id ORDER BY nv."createdAt" DESC, nv.id DESC LIMIT 1
       )
       WHERE n."isTrashed" = 0 AND n.updatedAt > v."createdAt"
       ORDER BY n.updatedAt DESC
       LIMIT ?`,
    )
    .all(SCAN_BATCH_SIZE) as SnapshotCandidateRow[];

  let created = 0;
  let backfilled = 0;

  for (const row of rows) {
    // 1) 回填旧版本 NULL hash
    let lastHash = row.lastContentHash;
    if (!lastHash) {
      lastHash = noteVersionsRepository.ensureContentHash(row.lastVersionId);
      if (lastHash) backfilled += 1;
    }

    // 2) hash 去重：当前内容指纹与最新版本一致则跳过
    const currentHash = computeContentHash({
      title: row.title,
      content: row.content,
      contentText: row.contentText,
      contentFormat: row.contentFormat,
    });
    if (lastHash && lastHash === currentHash) continue;

    // 3) 间隔判断：最新版本距今不足 interval 分钟则跳过（等下一轮）
    const lastTs = parseSqliteTimestamp(row.lastCreatedAt);
    if (Number.isFinite(lastTs) && Date.now() - lastTs < intervalMs) continue;

    // 4) 落一条 auto 快照（记录的是笔记当前内容）
    noteVersionsRepository.createTypedVersion({
      noteId: row.id,
      userId: row.userId,
      kind: "auto",
      changeType: "edit",
      snapshot: {
        title: row.title ?? "",
        content: row.content ?? "",
        contentText: row.contentText ?? "",
        contentFormat: row.contentFormat || "tiptap-json",
        version: row.version,
      },
    });
    created += 1;
  }

  return { scanned: rows.length, created, backfilled };
}

/**
 * 立即按当前保留策略清理一次（POST /api/versions/cleanup 与每日任务共用入口）。
 * mode='forever' 时只做悬空引用清扫。
 */
export function runVersionRetentionNow(): { deleted: number; freedBytes: number; enqueuedAttachments: number } {
  const settings = readVersionHistorySettings();
  let result = { deleted: 0, freedBytes: 0, freedAttachmentIds: [] as string[] };
  if (settings.retention.mode === "count") {
    result = noteVersionsRepository.pruneAutoVersionsByCount(settings.retention.count);
  } else if (settings.retention.mode === "days") {
    result = noteVersionsRepository.pruneAutoVersionsByDays(settings.retention.days);
  }
  // P2 存储配额：auto 总字节超过配额时按最旧优先清理（不受 mode=forever 限制）
  if (settings.storageQuotaMb > 0) {
    const quotaResult = noteVersionsRepository.pruneAutoVersionsOverQuota(settings.storageQuotaMb * 1024 * 1024);
    result.deleted += quotaResult.deleted;
    result.freedBytes += quotaResult.freedBytes;
    result.freedAttachmentIds.push(...quotaResult.freedAttachmentIds);
  }
  const danglingSwept = noteVersionsRepository.deleteDanglingAttachmentRefs();
  if (result.deleted > 0 || danglingSwept > 0 || result.freedAttachmentIds.length > 0) {
    console.log(
      `[version-snapshot] retention mode=${settings.retention.mode} deleted=${result.deleted} freedBytes=${result.freedBytes} danglingRefsSwept=${danglingSwept} attachmentsQueuedForGc=${result.freedAttachmentIds.length}`,
    );
  }
  return { deleted: result.deleted, freedBytes: result.freedBytes, enqueuedAttachments: result.freedAttachmentIds.length };
}

/**
 * P2 附件两阶段 GC 第二阶段：清扫超过宽限期的待删除附件。
 * - 物理文件仅在无其他 attachments 行共享同一路径时才 unlink；
 * - attachments 行删除后，attachment_references 由外键级联清理；
 * - 全程输出审计日志。
 */
export function sweepVersionGcQueue(graceDays = 7): { swept: number; freedBytes: number } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT "attachmentId" AS attachmentId, path, bytes, "freedAt" FROM version_gc_queue
       WHERE "freedAt" <= datetime('now', ?)`,
    )
    .all(`-${Math.max(1, Math.round(graceDays))} days`) as Array<{ attachmentId: string; path: string; bytes: number; freedAt: string }>;
  if (rows.length === 0) return { swept: 0, freedBytes: 0 };

  const attachmentsDir = getStorageAttachmentsDir();
  let swept = 0;
  let freedBytes = 0;
  for (const row of rows) {
    try {
      const siblings = db.prepare("SELECT COUNT(*) AS c FROM attachments WHERE path = ? AND id != ?").get(row.path, row.attachmentId) as { c: number };
      if (siblings.c === 0) {
        try {
          fs.unlinkSync(path.join(attachmentsDir, row.path));
        } catch (e: any) {
          if (e?.code !== "ENOENT") throw e;
        }
      }
      db.prepare("DELETE FROM attachments WHERE id = ?").run(row.attachmentId);
      db.prepare('DELETE FROM version_gc_queue WHERE "attachmentId" = ?').run(row.attachmentId);
      swept += 1;
      freedBytes += row.bytes;
      console.log(`[version-gc] swept attachment=${row.attachmentId} path=${row.path} bytes=${row.bytes} freedAt=${row.freedAt}`);
    } catch (error) {
      console.warn(`[version-gc] sweep failed for attachment=${row.attachmentId}:`, error instanceof Error ? error.message : error);
    }
  }
  if (swept > 0) {
    console.log(`[version-gc] sweep done swept=${swept} freedBytes=${freedBytes} graceDays=${graceDays}`);
  }
  return { swept, freedBytes };
}

async function runSchedulerRound(): Promise<void> {
  if (isRoundRunning) return;
  isRoundRunning = true;
  try {
    const stats = await runVersionSnapshotOnce();
    if (stats.created > 0 || stats.backfilled > 0) {
      console.log(
        `[version-snapshot] round scanned=${stats.scanned} created=${stats.created} backfilled=${stats.backfilled}`,
      );
    }

    // 每日一次保留策略 + GC 扫尾（进程内以日期判重）
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastRetentionRunDate) {
      lastRetentionRunDate = today;
      runVersionRetentionNow();
      try {
        sweepVersionGcQueue(7);
      } catch (error) {
        console.warn("[version-snapshot] gc sweep failed:", error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    console.warn("[version-snapshot] round failed:", error instanceof Error ? error.message : error);
  } finally {
    isRoundRunning = false;
  }
}

export function startVersionSnapshotScheduler(): void {
  if (process.env.NODE_ENV === "test") return;
  if (process.env.VERSION_SNAPSHOT_TIMER_DISABLED === "1") {
    console.log("[version-snapshot] scheduler disabled by VERSION_SNAPSHOT_TIMER_DISABLED");
    return;
  }
  if (schedulerIntervalHandle) return;
  console.log("[version-snapshot] scheduler started (tick=60s, firstRoundDelay=15s)");
  setTimeout(() => { void runSchedulerRound(); }, FIRST_RUN_DELAY_MS).unref();
  schedulerIntervalHandle = setInterval(() => { void runSchedulerRound(); }, TICK_INTERVAL_MS);
  schedulerIntervalHandle.unref();
}

export function stopVersionSnapshotScheduler(): void {
  if (schedulerIntervalHandle) {
    clearInterval(schedulerIntervalHandle);
    schedulerIntervalHandle = null;
  }
}
