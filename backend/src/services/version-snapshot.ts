/**
 * 版本历史 v2 —— 版本维护定时服务
 *
 * 参考 calendar-export.ts 的启动模式：进程内单实例 setInterval，随服务启动注册
 * （index.ts startVersionSnapshotScheduler）。每轮：
 *   1) 惰性回填旧版本 NULL contentHash（支撑相邻同内容合并的去重判定）；
 *   2) 每日一次执行保留策略（auto/manual 分别清理，release 永不参与）并清扫悬空附件引用。
 *
 * 【产品决策 2026-10-30】版本记录只允许三个显式入口：点「已同步」按钮、Ctrl+S、前端定时保存。
 * 原后端兜底自动快照（发现"笔记内容比最新版本新且距今超过 autoVersionIntervalMinutes"就补一条
 * auto 快照）已永久停用——它导致用户刚打完字 1 分钟内就冒出一条「自动记录」。调度器不再创建
 * 任何快照，仅保留上述维护逻辑。
 */

import { getDb } from "../db/schema";
import fs from "node:fs";
import path from "node:path";
import { noteVersionsRepository } from "../repositories/noteVersionsRepository";
import { readVersionHistorySettings } from "./version-history-settings";
import { getAttachmentsDir as getStorageAttachmentsDir } from "./attachment-storage";

const TICK_INTERVAL_MS = 60_000;
const FIRST_RUN_DELAY_MS = 15_000;
const BACKFILL_BATCH_SIZE = 200;

let schedulerIntervalHandle: ReturnType<typeof setInterval> | null = null;
let isRoundRunning = false;
let lastRetentionRunDate: string | null = null;

export function runVersionSnapshotOnce(): { backfilled: number } {
  const db = getDb();

  // 惰性回填：只处理 contentHash 为 NULL 的旧版本，不再创建任何快照。
  const rows = db
    .prepare(`SELECT id FROM note_versions WHERE "contentHash" IS NULL LIMIT ?`)
    .all(BACKFILL_BATCH_SIZE) as Array<{ id: string }>;

  let backfilled = 0;
  for (const row of rows) {
    if (noteVersionsRepository.ensureContentHash(row.id)) backfilled += 1;
  }

  return { backfilled };
}

/**
 * 立即按当前保留策略清理一次（POST /api/settings/version-history/cleanup 与每日任务共用入口）。
 * - auto 按 settings.retention 清理，manual（Ctrl+S 记录）按 settings.manualRetention 清理；
 * - release 永不参与清理与合并；
 * - 各步骤独立容错：单步失败只记入 failed 并告警，不影响其它步骤与主流程；
 * - mode='forever' 时仍执行相邻同内容合并与悬空引用清扫。
 */
export function runVersionRetentionNow(): { deleted: number; freedBytes: number; enqueuedAttachments: number; failed: string[] } {
  const settings = readVersionHistorySettings();
  let deleted = 0;
  let freedBytes = 0;
  const freedAttachmentIds = new Set<string>();
  const failed: string[] = [];

  const runStep = (name: string, fn: () => { deleted: number; freedBytes: number; freedAttachmentIds: string[] }): void => {
    try {
      const result = fn();
      deleted += result.deleted;
      freedBytes += result.freedBytes;
      for (const id of result.freedAttachmentIds) freedAttachmentIds.add(id);
    } catch (error) {
      failed.push(name);
      console.warn(`[version-snapshot] retention step ${name} failed:`, error instanceof Error ? error.message : error);
    }
  };

  // 相邻同内容记录合并（同 source 同 hash 只留最新一条；release 豁免）
  runStep("merge-adjacent", () => {
    const merged = noteVersionsRepository.mergeAdjacentSameContent();
    return { deleted: merged.merged, freedBytes: 0, freedAttachmentIds: merged.freedAttachmentIds };
  });

  if (settings.retention.mode === "count") {
    runStep("auto-count", () => noteVersionsRepository.pruneVersionsBySourceCount("auto", settings.retention.count));
  } else if (settings.retention.mode === "days") {
    runStep("auto-days", () => noteVersionsRepository.pruneVersionsBySourceDays("auto", settings.retention.days));
  }

  if (settings.manualRetention.mode === "count") {
    runStep("manual-count", () => noteVersionsRepository.pruneVersionsBySourceCount("manual", settings.manualRetention.count));
  } else if (settings.manualRetention.mode === "days") {
    runStep("manual-days", () => noteVersionsRepository.pruneVersionsBySourceDays("manual", settings.manualRetention.days));
  }

  // P2 存储配额：auto 总字节超过配额时按最旧优先清理（不受 mode=forever 限制）
  if (settings.storageQuotaMb > 0) {
    runStep("auto-quota", () => noteVersionsRepository.pruneAutoVersionsOverQuota(settings.storageQuotaMb * 1024 * 1024));
  }

  let danglingSwept = 0;
  try {
    danglingSwept = noteVersionsRepository.deleteDanglingAttachmentRefs();
  } catch (error) {
    failed.push("dangling-sweep");
    console.warn("[version-snapshot] dangling refs sweep failed:", error instanceof Error ? error.message : error);
  }

  if (deleted > 0 || danglingSwept > 0 || freedAttachmentIds.size > 0 || failed.length > 0) {
    console.log(
      `[version-snapshot] retention mode=${settings.retention.mode}/${settings.manualRetention.mode} deleted=${deleted} freedBytes=${freedBytes} danglingRefsSwept=${danglingSwept} attachmentsQueuedForGc=${freedAttachmentIds.size} failed=[${failed.join(",")}]`,
    );
  }
  return { deleted, freedBytes, enqueuedAttachments: freedAttachmentIds.size, failed };
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
    // 产品决策（2026-10-30）：版本记录只来自三个显式入口——「已同步」按钮、Ctrl+S、前端定时保存。
    // 后端兜底自动快照已永久停用，这里只做 hash 惰性回填 + 每日清理/GC，不创建任何快照。
    const stats = runVersionSnapshotOnce();
    if (stats.backfilled > 0) {
      console.log(`[version-snapshot] round backfilled=${stats.backfilled}`);
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
