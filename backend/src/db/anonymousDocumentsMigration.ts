import type { Migration } from "./migrations.impl.js";
import { installSyncOutboxCaptureTriggers } from "./syncOutboxCaptureMigration.js";

/**
 * v130: 匿名文档标记。
 *
 * 富文本里"插入即创建"的画板/导图文档只以嵌入块形式存在于宿主笔记中，
 * 不应该出现在知识树、笔记列表或搜索结果里。
 * `isUnlisted = 1` 表示该笔记没有知识树节点、不参与常规列表与检索。
 *
 * 同步链路：notes 的新列必须进入 sync_outbox 的 note payload，
 * 因此迁移末尾重装捕获触发器（installSyncOutboxCaptureTriggers 会通过
 * PRAGMA 探测列是否存在，旧库升级同样安全）。
 */
export const anonymousDocumentsMigration: Migration = {
  version: 130,
  name: "anonymous-documents",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "isUnlisted")) {
      db.exec("ALTER TABLE notes ADD COLUMN isUnlisted INTEGER NOT NULL DEFAULT 0");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_notes_unlisted_scope
        ON notes(userId, workspaceId, isUnlisted, isTrashed);
    `);
    installSyncOutboxCaptureTriggers(db);
  },
};
