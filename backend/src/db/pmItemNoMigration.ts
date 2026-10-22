import type { Migration } from "./migrations.impl.js";

/**
 * PM-ITEMNO (v128)
 *
 * 工作项编号：项目内自增整数（itemNo），用于 #n 引用与展示。
 */
export const pmItemNoMigration: Migration = {
  version: 128,
  name: "pm-work-item-no",
  up: (db) => {
    const cols = db.prepare("PRAGMA table_info(pm_work_items)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "itemNo")) {
      db.prepare("ALTER TABLE pm_work_items ADD COLUMN itemNo INTEGER").run();
      // 为既有行回填项目内自增编号
      db.exec(`
        UPDATE pm_work_items SET "itemNo" = (
          SELECT COUNT(*) FROM pm_work_items w2
          WHERE w2."projectId" = pm_work_items."projectId" AND w2."createdAt" <= pm_work_items."createdAt"
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pm_work_items_no ON pm_work_items("projectId", "itemNo");`);
    }
  },
};
