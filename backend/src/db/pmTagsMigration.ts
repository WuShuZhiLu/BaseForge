import type { Migration } from "./migrations.impl.js";

/**
 * PM-TAGS-TYPECONFIG (v127)
 *
 * 项目管理增强：
 * - pm_projects.typeConfig：项目级自定义工单类型（JSON 数组 [{key,label,color}]），
 *   默认需求/任务/缺陷三类型；工作项 type 存 key，按项目动态解释。
 * - pm_work_items.tags：自定义标签（JSON 数组字符串），多选、按项目聚合筛选。
 * - git 双向同步字段：gitSourceId（平台源）、gitIssueState（open/closed）、
 *   gitIssueUrl（平台链接）；gitIssue 兼容继续存平台内编号。
 */
export const pmTagsMigration: Migration = {
  version: 127,
  name: "pm-tags-typeconfig",
  up: (db) => {
    const projCols = db.prepare("PRAGMA table_info(pm_projects)").all() as { name: string }[];
    if (!projCols.some((c) => c.name === "typeConfig")) {
      db.prepare("ALTER TABLE pm_projects ADD COLUMN typeConfig TEXT").run();
    }
    const itemCols = db.prepare("PRAGMA table_info(pm_work_items)").all() as { name: string }[];
    if (!itemCols.some((c) => c.name === "tags")) {
      db.prepare("ALTER TABLE pm_work_items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'").run();
    }
    if (!itemCols.some((c) => c.name === "gitSourceId")) {
      db.prepare("ALTER TABLE pm_work_items ADD COLUMN gitSourceId TEXT").run();
    }
    if (!itemCols.some((c) => c.name === "gitIssueState")) {
      db.prepare("ALTER TABLE pm_work_items ADD COLUMN gitIssueState TEXT").run();
    }
    if (!itemCols.some((c) => c.name === "gitIssueUrl")) {
      db.prepare("ALTER TABLE pm_work_items ADD COLUMN gitIssueUrl TEXT").run();
    }
  },
};
