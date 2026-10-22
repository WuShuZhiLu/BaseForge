import type { Migration } from "./migrations.impl.js";

/**
 * VERSION-HISTORY-V2 (v124)
 *
 * 版本历史 v2 数据结构升级（docs/version-history-v2.md 第 5 节）：
 * - note_versions 增加 kind（auto|manual）/ label / description / contentHash 四列；
 *   存量行经 DEFAULT 'auto' 全部视为自动版本，contentHash 由调度器惰性回填。
 * - 新增 version_attachment_refs 倒排表：版本级附件引用，供附件孤儿扫描排除
 *   「仅被历史版本引用」的附件。表无外键（版本行删除路径显式清理），悬空行
 *   由孤儿扫描 JOIN 与每日保留策略兜底清扫。
 */
export const versionHistoryV2Migration: Migration = {
  version: 124,
  name: "version-history-v2",
  up: (db) => {
    // 逐列防重：v40 contentFormat 先例——base DDL 与存量库都可能已有这些列
    const columns = db.prepare("PRAGMA table_info(note_versions)").all() as Array<{ name: string }>;
    const hasColumn = (name: string) => columns.some((column) => column.name === name);
    if (!hasColumn("kind")) {
      db.exec("ALTER TABLE note_versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto';");
    }
    if (!hasColumn("label")) {
      db.exec("ALTER TABLE note_versions ADD COLUMN label TEXT;");
    }
    if (!hasColumn("description")) {
      db.exec("ALTER TABLE note_versions ADD COLUMN description TEXT;");
    }
    if (!hasColumn("contentHash")) {
      db.exec('ALTER TABLE note_versions ADD COLUMN "contentHash" TEXT;');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS version_attachment_refs (
        "versionId" TEXT NOT NULL,
        "attachmentId" TEXT NOT NULL,
        PRIMARY KEY ("versionId", "attachmentId")
      );
    `);
  },
};
