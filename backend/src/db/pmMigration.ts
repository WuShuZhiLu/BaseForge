import type { Migration } from "./migrations.impl.js";

/**
 * PM (v126)
 *
 * 项目管理插件（remote-files 同款内置插件管线）：
 * - pm_projects：项目容器（可关联笔记本/知识分类，P2 关联 git 仓库与成员）
 * - pm_work_items：工作项（需求 / 任务 / 缺陷），状态机
 *   todo → doing → review → done（canceled 为终止态），支持关联笔记（交付文档）
 *   与 git 引用（P1 手工字段，P2 对接 GitHub/GitLab/Gitea API 自动同步）。
 */
export const pmMigration: Migration = {
  version: 126,
  name: "pm-projects-work-items",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pm_projects (
        id TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        color TEXT,
        "workspaceId" TEXT,
        "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
        "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pm_projects_user ON pm_projects("userId");

      CREATE TABLE IF NOT EXISTS pm_work_items (
        id TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "projectId" TEXT NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'task',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'medium',
        "dueDate" TEXT,
        "notebookId" TEXT,
        "noteId" TEXT,
        "gitRepo" TEXT,
        "gitBranch" TEXT,
        "gitIssue" TEXT,
        "sortOrder" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
        "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pm_work_items_project
        ON pm_work_items("projectId", status, "sortOrder");
      CREATE INDEX IF NOT EXISTS idx_pm_work_items_note ON pm_work_items("noteId");
    `);
  },
};
