import type { Migration } from "./migrations.impl.js";

/**
 * PM-M3 (v129)
 *
 * 工作项模型深化（docs/plugin-pm-m3-design.md）：
 * - pm_work_items."parentId"：父子工作项（仅一层嵌套；删父 → 子项 parentId 置空提升为顶层，
 *   非破坏性）；
 * - pm_work_item_logs：活动流（字段级变更历史，仓库层 updateWorkItem 内建 diff 写入，
 *   每工单仅保留最近 200 条，见 pmRepository.appendWorkItemLog）；
 * - pm_item_notes：多文档关联（UNIQUE(itemId, noteId)）；旧单 noteId 自动迁移为关联之一，
 *   noteId 列保留为「主交付文档」语义（迁移幂等：'m3-' || item.id 确定主键 + NOT EXISTS 兜底）。
 */
export const pmM3Migration: Migration = {
  version: 129,
  name: "pm-m3-model-deepening",
  up: (db) => {
    const itemCols = db.prepare("PRAGMA table_info(pm_work_items)").all() as { name: string }[];
    if (!itemCols.some((c) => c.name === "parentId")) {
      db.prepare(
        `ALTER TABLE pm_work_items ADD COLUMN "parentId" TEXT REFERENCES pm_work_items(id) ON DELETE SET NULL`,
      ).run();
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pm_work_items_parent ON pm_work_items("projectId", "parentId");`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS pm_work_item_logs (
        id TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "itemId" TEXT NOT NULL REFERENCES pm_work_items(id) ON DELETE CASCADE,
        "projectId" TEXT NOT NULL,
        field TEXT NOT NULL,
        oldValue TEXT,
        newValue TEXT,
        "createdAt" TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pm_logs_item ON pm_work_item_logs("itemId", "createdAt" DESC);
      CREATE INDEX IF NOT EXISTS idx_pm_logs_project ON pm_work_item_logs("projectId", "createdAt" DESC);

      CREATE TABLE IF NOT EXISTS pm_item_notes (
        id TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "itemId" TEXT NOT NULL REFERENCES pm_work_items(id) ON DELETE CASCADE,
        "noteId" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE("itemId", "noteId")
      );
      CREATE INDEX IF NOT EXISTS idx_pm_item_notes_note ON pm_item_notes("noteId");
    `);

    // 旧单 noteId → 多文档关联（幂等：确定主键 + NOT EXISTS 双保险）
    db.exec(`
      INSERT INTO pm_item_notes (id, "userId", "itemId", "noteId", "createdAt")
      SELECT 'm3-' || w.id, w."userId", w.id, w."noteId", w."updatedAt"
      FROM pm_work_items w
      WHERE w."noteId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM pm_item_notes n WHERE n."itemId" = w.id AND n."noteId" = w."noteId"
        );
    `);
  },
};
