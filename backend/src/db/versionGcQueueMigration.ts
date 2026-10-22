import type { Migration } from "./migrations.impl.js";

/**
 * VERSION-GC-QUEUE (v125)
 *
 * 版本历史 v2 P2：附件两阶段 GC 的待清理队列。
 * - 版本删除/保留策略清掉最后一个引用后，附件进入本队列（freedAt 记录入队时间）；
 * - 调度器每日清扫：超过宽限期（默认 7 天）的条目删除物理文件与 attachments 行，
 *   并输出审计日志；宽限期内用户可随时还原/引用恢复。
 * - 孤儿扫描排除队列内条目，避免与 GC 扫尾双写冲突。
 */
export const versionGcQueueMigration: Migration = {
  version: 125,
  name: "version-gc-queue",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS version_gc_queue (
        "attachmentId" TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        "freedAt" TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_version_gc_queue_freed ON version_gc_queue("freedAt");
    `);
  },
};
