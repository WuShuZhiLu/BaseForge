import type { Migration } from "./migrations.impl.js";

/**
 * v139：删除日记（说说 / 工作区日志）模块遗留的表。
 *
 * 背景：日记曾是内置的 nowen 插件，0.2.0 起产品内核只保留「文档 + 知识库」，
 * 日记与 AI 问答一并移除。代码侧已无任何读写方，这里把存量数据表一并清掉，
 * 避免库里留着永远没人读的死表。
 *
 * 删除顺序：先子表后父表（diary_attachments 有 diaryId 外键）。
 * 触发器随表一起被 SQLite 自动删除，无需单独 DROP TRIGGER。
 *
 * 幂等：全部 IF EXISTS，重复执行安全（例如从旧备份恢复后再跑一次）。
 */
export const dropDiaryTablesMigration: Migration = {
  version: 139,
  name: "drop-diary-tables",
  up(db) {
    // 同步队列里可能还留着 entityType='diary' 的待推送/待应用记录。
    // 表都删了，这些记录再推给别的设备只会让对端 apply 失败，先清掉。
    // 表 / 列名在不同历史版本有差异（v90 的 sync_outbox 没有 scopeKey 等），
    // 因此逐个探测，缺表就跳过。
    const hasTable = (name: string) =>
      Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name),
      );
    for (const table of ["sync_outbox", "sync_changes_v2", "sync_entity_state"]) {
      if (!hasTable(table)) continue;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some((column) => column.name === "entityType")) continue;
      db.prepare(`DELETE FROM ${table} WHERE entityType = 'diary'`).run();
    }

    db.exec(`
      DROP TABLE IF EXISTS diary_attachments;
      DROP TABLE IF EXISTS diaries;
      DROP TABLE IF EXISTS workspace_journals;
    `);

    // 「今日日记」曾借 notes.note_type='journal' + journal_date 落地（v34），
    // 日记入口删掉后这些笔记就只剩一个没人认识的类型标记。把它们改回普通笔记，
    // 内容、标题、所在笔记本都不动，只是不再被当成日记。
    // 同时撤掉 v34 建的两个 journal 专用索引：唯一索引只约束 note_type='journal'，
    // 类型改回 normal 后它就是死索引，留着只会拖慢 notes 的写入。
    const noteColumns = db.prepare("PRAGMA table_info(notes)").all() as { name: string }[];
    if (noteColumns.some((column) => column.name === "note_type")) {
      db.prepare("UPDATE notes SET note_type = 'normal' WHERE note_type = 'journal'").run();
    }
    db.exec(`
      DROP INDEX IF EXISTS idx_notes_journal_unique;
      DROP INDEX IF EXISTS idx_notes_journal_date;
    `);
  },
};
