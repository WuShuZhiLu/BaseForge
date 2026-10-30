import type { Migration } from "./migrations.impl.js";

export const VERSION_SOURCE_SCHEMA_VERSION = 134;

/**
 * 版本来源标记（v134）
 *
 * 版本历史按「快照来源」区分三类记录：
 * - auto：定时快照（前端计时 + 服务端调度器）
 * - manual：Ctrl+S 保存产生的记录
 * - release：用户「保存为版本」（发版）标记的记录
 *
 * 实现：note_versions 增加 source 列。迁移时先以 DEFAULT 'manual' 补列
 * （即「已有记录回填 manual」），再把 kind='auto' 的存量行改判为 auto——
 * 旧行只有 auto/manual 两种 kind，能确定是定时产物的保持 auto，
 * 其余（旧手动备份等无法区分 Ctrl+S 与发版的）一律回填 manual。
 */
export const versionSourceMigration: Migration = {
  version: VERSION_SOURCE_SCHEMA_VERSION,
  name: "version-source-marker",
  up: (db) => {
    // 逐列防重：与 v124（version-history-v2）同规则，base DDL 与存量库都可能已有该列
    const columns = db.prepare("PRAGMA table_info(note_versions)").all() as Array<{ name: string }>;
    const hasColumn = (name: string) => columns.some((column) => column.name === name);
    if (!hasColumn("source")) {
      db.exec("ALTER TABLE note_versions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';");
    }
    // 回填：定时产物保持 auto；其余存量行维持/回填 manual
    db.exec("UPDATE note_versions SET source = 'auto' WHERE kind = 'auto' AND source != 'auto';");
    db.exec("UPDATE note_versions SET source = 'manual' WHERE source NOT IN ('auto', 'manual', 'release');");
  },
};
