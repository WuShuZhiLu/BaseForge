/**
 * 项目管理插件数据层：项目（pm_projects）与工作项（pm_work_items）。
 *
 * 状态机（三类工作项共用）：todo → doing → review → done；canceled 为终止态。
 * 工单类型：项目级自定义（typeConfig JSON），默认需求/任务/缺陷。
 * 关联：noteId（交付文档）、notebookId（文档存放笔记本）、gitRepo/gitBranch/gitIssue/
 * gitSourceId/gitIssueState/gitIssueUrl（P1 手工引用，P2 对接平台 API 自动同步）、
 * tags（自定义标签，JSON 数组存储，按项目聚合筛选）。
 */
import { getDb } from "../db/schema";
import { randomUUID } from "crypto";

export interface PmItemTypeConfig {
  key: string;
  label: string;
  color?: string;
}

/** 项目级默认工单类型（typeConfig 未配置/损坏时回退） */
export const DEFAULT_PM_TYPE_CONFIG: PmItemTypeConfig[] = [
  { key: "requirement", label: "需求", color: "#0ea5e9" },
  { key: "task", label: "任务", color: "#10b981" },
  { key: "bug", label: "缺陷", color: "#ef4444" },
];

export interface PmProject {
  id: string;
  userId: string;
  name: string;
  description: string;
  color: string | null;
  workspaceId: string | null;
  typeConfig: PmItemTypeConfig[];
  createdAt: string;
  updatedAt: string;
}

export type PmWorkItemType = string;
export type PmWorkItemStatus = "todo" | "doing" | "review" | "done" | "canceled";
export type PmWorkItemPriority = "urgent" | "high" | "medium" | "low";

export interface PmWorkItem {
  id: string;
  userId: string;
  projectId: string;
  type: PmWorkItemType;
  title: string;
  description: string;
  status: PmWorkItemStatus;
  priority: PmWorkItemPriority;
  dueDate: string | null;
  notebookId: string | null;
  noteId: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitIssue: string | null;
  gitSourceId: string | null;
  gitIssueState: string | null;
  gitIssueUrl: string | null;
  itemNo: number | null;
  parentId: string | null;
  tags: string[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

const ITEM_STATUSES: PmWorkItemStatus[] = ["todo", "doing", "review", "done", "canceled"];
const ITEM_PRIORITIES: PmWorkItemPriority[] = ["urgent", "high", "medium", "low"];

export interface PmWorkItemLog {
  field: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

export interface PmItemNoteLink {
  id: string;
  noteId: string;
  title: string | null;
  isTrashed: boolean;
  createdAt: string;
}

interface ItemRow {
  id: string;
  userId: string;
  projectId: string;
  type: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string | null;
  notebookId: string | null;
  noteId: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitIssue: string | null;
  gitSourceId: string | null;
  gitIssueState: string | null;
  gitIssueUrl: string | null;
  itemNo: number | null;
  parentId: string | null;
  tags: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

function parseTypeConfig(raw: unknown): PmItemTypeConfig[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return DEFAULT_PM_TYPE_CONFIG;
    const list = parsed
      .filter((t: any) => t && typeof t.key === "string" && typeof t.label === "string")
      .map((t: any) => ({ key: String(t.key).slice(0, 24), label: String(t.label).slice(0, 24), color: typeof t.color === "string" ? t.color : undefined }));
    return list.length > 0 ? list : DEFAULT_PM_TYPE_CONFIG;
  } catch {
    return DEFAULT_PM_TYPE_CONFIG;
  }
}

function parseTags(raw: unknown): string[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim().slice(0, 24)).slice(0, 10);
  } catch {
    return [];
  }
}

/** 活动流值统一截断（超 200 字符加 …），数组/对象 JSON 序列化。 */
function truncateLogValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** 活动流字段跟踪表（M3 设计 §三）：字段 → 序列化取值器。 */
const LOGGED_ITEM_FIELDS: Array<{ field: string; pick: (item: PmWorkItem) => unknown }> = [
  { field: "title", pick: (item) => item.title },
  { field: "description", pick: (item) => item.description },
  { field: "status", pick: (item) => item.status },
  { field: "priority", pick: (item) => item.priority },
  { field: "dueDate", pick: (item) => item.dueDate },
  { field: "type", pick: (item) => item.type },
  { field: "tags", pick: (item) => JSON.stringify(item.tags) },
  { field: "noteId", pick: (item) => item.noteId },
  { field: "gitRepo", pick: (item) => item.gitRepo },
  { field: "gitBranch", pick: (item) => item.gitBranch },
  { field: "gitIssue", pick: (item) => item.gitIssue },
  { field: "gitIssueState", pick: (item) => item.gitIssueState },
  { field: "parentId", pick: (item) => item.parentId },
];

/** 活动流写入：与旧值不同才记；每工单仅保留最近 200 条（防膨胀）。 */
function appendWorkItemLogs(db: ReturnType<typeof getDb>, userId: string, before: PmWorkItem, after: PmWorkItem): void {
  const now = new Date().toISOString();
  for (const { field, pick } of LOGGED_ITEM_FIELDS) {
    const oldValue = truncateLogValue(pick(before));
    const newValue = truncateLogValue(pick(after));
    if (oldValue === newValue) continue;
    db.prepare(
      `INSERT INTO pm_work_item_logs (id, "userId", "itemId", "projectId", field, oldValue, newValue, "createdAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), userId, after.id, after.projectId, field, oldValue, newValue, now);
  }
  db.prepare(
    `DELETE FROM pm_work_item_logs WHERE "itemId" = ? AND id NOT IN (
       SELECT id FROM pm_work_item_logs WHERE "itemId" = ? ORDER BY "createdAt" DESC, rowid DESC LIMIT 200
     )`,
  ).run(after.id, after.id);
}

/** 关联一篇笔记（UNIQUE 去重）；返回是否新建。 */
function linkItemNote(db: ReturnType<typeof getDb>, userId: string, item: PmWorkItem, noteId: string): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO pm_item_notes (id, "userId", "itemId", "noteId", "createdAt") VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), userId, item.id, noteId, new Date().toISOString());
  return result.changes > 0;
}

function rowToProject(row: any): PmProject {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    description: row.description ?? "",
    color: row.color ?? null,
    workspaceId: row.workspaceId ?? null,
    typeConfig: parseTypeConfig(row.typeConfig),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToItem(row: ItemRow): PmWorkItem {
  return {
    ...row,
    type: row.type,
    status: (ITEM_STATUSES.includes(row.status as PmWorkItemStatus) ? row.status : "todo") as PmWorkItemStatus,
    priority: (ITEM_PRIORITIES.includes(row.priority as PmWorkItemPriority) ? row.priority : "medium") as PmWorkItemPriority,
    gitSourceId: row.gitSourceId ?? null,
    gitIssueState: row.gitIssueState ?? null,
    gitIssueUrl: row.gitIssueUrl ?? null,
    itemNo: row.itemNo ?? null,
    parentId: row.parentId ?? null,
    tags: parseTags(row.tags),
  };
}

export function createPmRepository() {
  return {
    // ===== 项目 =====

    listProjects(userId: string): PmProject[] {
      const rows = getDb()
        .prepare(`SELECT * FROM pm_projects WHERE "userId" = ? ORDER BY "updatedAt" DESC`)
        .all(userId) as any[];
      return rows.map(rowToProject);
    },

    getProject(userId: string, id: string): PmProject | null {
      const row = getDb()
        .prepare(`SELECT * FROM pm_projects WHERE "userId" = ? AND id = ?`)
        .get(userId, id) as any;
      return row ? rowToProject(row) : null;
    },

    createProject(userId: string, input: { name: string; description?: string; color?: string; workspaceId?: string | null }): PmProject {
      const id = randomUUID();
      const now = new Date().toISOString();
      getDb()
        .prepare(
          `INSERT INTO pm_projects (id, "userId", name, description, color, "workspaceId", "createdAt", "updatedAt")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, userId, input.name.trim().slice(0, 120), (input.description ?? "").slice(0, 2000), input.color ?? null, input.workspaceId ?? null, now, now);
      return this.getProject(userId, id)!;
    },

    updateProject(userId: string, id: string, patch: { name?: string; description?: string; color?: string | null; typeConfig?: PmItemTypeConfig[] }): PmProject | null {
      const existing = this.getProject(userId, id);
      if (!existing) return null;
      const name = patch.name !== undefined ? patch.name.trim().slice(0, 120) : existing.name;
      const description = patch.description !== undefined ? patch.description.slice(0, 2000) : existing.description;
      const color = patch.color !== undefined ? patch.color : existing.color;
      const typeConfig = patch.typeConfig !== undefined ? JSON.stringify(parseTypeConfig(patch.typeConfig)) : JSON.stringify(existing.typeConfig);
      // M3：删除被引用的类型 → 阻止（前后端双重校验的后端侧）
      if (patch.typeConfig !== undefined) {
        const nextKeys = new Set(parseTypeConfig(patch.typeConfig).map((t) => t.key));
        const removedTypes = existing.typeConfig.filter((t) => !nextKeys.has(t.key));
        for (const removedType of removedTypes) {
          const used = getDb()
            .prepare(`SELECT COUNT(*) AS n FROM pm_work_items WHERE "projectId" = ? AND type = ?`)
            .get(id, removedType.key) as { n: number };
          if (used.n > 0) {
            throw new Error(`类型「${removedType.label}」仍被 ${used.n} 个工单使用，无法删除`);
          }
        }
      }
      getDb()
        .prepare(`UPDATE pm_projects SET name = ?, description = ?, color = ?, typeConfig = ?, "updatedAt" = ? WHERE "userId" = ? AND id = ?`)
        .run(name, description, color, typeConfig, new Date().toISOString(), userId, id);
      return this.getProject(userId, id);
    },

    deleteProject(userId: string, id: string): { success: boolean; itemsDeleted: number } {
      const db = getDb();
      const items = db.prepare(`SELECT COUNT(*) AS n FROM pm_work_items WHERE "projectId" = ? AND "userId" = ?`).get(id, userId) as { n: number };
      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM pm_work_items WHERE "projectId" = ? AND "userId" = ?`).run(id, userId);
        db.prepare(`DELETE FROM pm_projects WHERE "userId" = ? AND id = ?`).run(userId, id);
      });
      tx();
      return { success: true, itemsDeleted: items.n };
    },

    // ===== 工作项 =====

    listWorkItems(userId: string, projectId: string, filter?: { type?: string; status?: string; tag?: string }): PmWorkItem[] {
      const clauses: string[] = [`"userId" = ?`, `"projectId" = ?`];
      const params: unknown[] = [userId, projectId];
      if (filter?.type) {
        clauses.push(`type = ?`);
        params.push(filter.type);
      }
      if (filter?.status && ITEM_STATUSES.includes(filter.status as PmWorkItemStatus)) {
        clauses.push(`status = ?`);
        params.push(filter.status);
      }
      const rows = getDb()
        .prepare(`SELECT * FROM pm_work_items WHERE ${clauses.join(" AND ")} ORDER BY "sortOrder" ASC, "updatedAt" DESC`)
        .all(...params) as ItemRow[];
      const items = rows.map(rowToItem);
      if (filter?.tag) {
        return items.filter((item) => item.tags.includes(filter.tag!));
      }
      return items;
    },

    getWorkItem(userId: string, id: string): PmWorkItem | null {
      const row = getDb()
        .prepare(`SELECT * FROM pm_work_items WHERE "userId" = ? AND id = ?`)
        .get(userId, id) as ItemRow | undefined;
      return row ? rowToItem(row) : null;
    },

    createWorkItem(
      userId: string,
      projectId: string,
      input: {
        type?: string; title: string; description?: string; priority?: string;
        dueDate?: string | null; notebookId?: string | null; noteId?: string | null;
        gitRepo?: string | null; gitBranch?: string | null; gitIssue?: string | null;
        gitSourceId?: string | null; gitIssueState?: string | null; gitIssueUrl?: string | null;
        tags?: string[]; parentId?: string | null;
      },
    ): PmWorkItem {
      const project = this.getProject(userId, projectId);
      if (!project) throw new Error("项目不存在");
      const typeKeys = project.typeConfig.map((t) => t.key);
      const type = (input.type && typeKeys.includes(input.type) ? input.type : typeKeys[0]) as PmWorkItemType;
      const priority = ITEM_PRIORITIES.includes(input.priority as PmWorkItemPriority) ? input.priority : "medium";
      const tags = parseTags(JSON.stringify(input.tags ?? []));
      // M3：父子（一层嵌套）——父项必须存在、同项目、且自身不是子项
      const parentId = input.parentId ?? null;
      if (parentId) {
        const parent = this.getWorkItem(userId, parentId);
        if (!parent || parent.projectId !== projectId) throw new Error("父工作项不存在或不属于当前项目");
        if (parent.parentId) throw new Error("仅支持一层父子嵌套（父项不能再有父项）");
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      getDb()
        .prepare(
          `INSERT INTO pm_work_items
           (id, "userId", "projectId", type, title, description, status, priority, "dueDate", "notebookId", "noteId", "gitRepo", "gitBranch", "gitIssue", "gitSourceId", "gitIssueState", "gitIssueUrl", "parentId", tags, "sortOrder", "createdAt", "updatedAt")
           VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id, userId, projectId, type, input.title.trim().slice(0, 300), (input.description ?? "").slice(0, 50000),
          priority, input.dueDate ?? null, input.notebookId ?? null, input.noteId ?? null,
          input.gitRepo ?? null, input.gitBranch ?? null, input.gitIssue ?? null,
          input.gitSourceId ?? null, input.gitIssueState ?? null, input.gitIssueUrl ?? null,
          parentId, JSON.stringify(tags), now, now,
        );
      const created = this.getWorkItem(userId, id)!;
      const db = getDb();
      // 主交付文档自动进多文档关联
      if (created.noteId) linkItemNote(db, userId, created, created.noteId);
      // 活动流：创建记录
      db.prepare(
        `INSERT INTO pm_work_item_logs (id, "userId", "itemId", "projectId", field, oldValue, newValue, "createdAt")
         VALUES (?, ?, ?, ?, '__created__', NULL, ?, ?)`,
      ).run(randomUUID(), userId, created.id, created.projectId, truncateLogValue(created.title), new Date().toISOString());
      return created;
    },

    updateWorkItem(
      userId: string,
      id: string,
      patch: {
        title?: string; description?: string; status?: string; priority?: string;
        dueDate?: string | null; noteId?: string | null; notebookId?: string | null;
        gitRepo?: string | null; gitBranch?: string | null; gitIssue?: string | null;
        gitSourceId?: string | null; gitIssueState?: string | null; gitIssueUrl?: string | null;
        type?: string; tags?: string[]; parentId?: string | null;
      },
    ): PmWorkItem | null {
      const existing = this.getWorkItem(userId, id);
      if (!existing) return null;
      const project = this.getProject(userId, existing.projectId);
      const typeKeys = project?.typeConfig.map((t) => t.key) ?? [];
      const title = patch.title !== undefined ? patch.title.trim().slice(0, 300) : existing.title;
      const description = patch.description !== undefined ? patch.description.slice(0, 50000) : existing.description;
      const status = patch.status !== undefined && ITEM_STATUSES.includes(patch.status as PmWorkItemStatus) ? patch.status : existing.status;
      const priority = patch.priority !== undefined && ITEM_PRIORITIES.includes(patch.priority as PmWorkItemPriority) ? patch.priority : existing.priority;
      const dueDate = patch.dueDate !== undefined ? patch.dueDate : existing.dueDate;
      const noteId = patch.noteId !== undefined ? patch.noteId : existing.noteId;
      const notebookId = patch.notebookId !== undefined ? patch.notebookId : existing.notebookId;
      const gitRepo = patch.gitRepo !== undefined ? patch.gitRepo : existing.gitRepo;
      const gitBranch = patch.gitBranch !== undefined ? patch.gitBranch : existing.gitBranch;
      const gitIssue = patch.gitIssue !== undefined ? patch.gitIssue : existing.gitIssue;
      const gitSourceId = patch.gitSourceId !== undefined ? patch.gitSourceId : existing.gitSourceId;
      const gitIssueState = patch.gitIssueState !== undefined ? patch.gitIssueState : existing.gitIssueState;
      const gitIssueUrl = patch.gitIssueUrl !== undefined ? patch.gitIssueUrl : existing.gitIssueUrl;
      const type = patch.type !== undefined && typeKeys.includes(patch.type) ? patch.type : existing.type;
      const tags = patch.tags !== undefined ? parseTags(JSON.stringify(patch.tags)) : existing.tags;
      // M3：父子——null = 脱离父项；设置父项时校验同项目 / 一层嵌套 / 防自指
      const parentId = patch.parentId !== undefined ? patch.parentId : existing.parentId;
      if (patch.parentId !== undefined && patch.parentId !== null) {
        if (patch.parentId === id) throw new Error("不能把工作项设为自己的父项");
        const parent = this.getWorkItem(userId, patch.parentId);
        if (!parent || parent.projectId !== existing.projectId) throw new Error("父工作项不存在或不属于当前项目");
        if (parent.parentId) throw new Error("仅支持一层父子嵌套（父项不能再有父项）");
      }
      const db = getDb();
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE pm_work_items SET title = ?, description = ?, status = ?, priority = ?, "dueDate" = ?, "noteId" = ?, "notebookId" = ?, "gitRepo" = ?, "gitBranch" = ?, "gitIssue" = ?, "gitSourceId" = ?, "gitIssueState" = ?, "gitIssueUrl" = ?, type = ?, tags = ?, "parentId" = ?, "updatedAt" = ?
           WHERE "userId" = ? AND id = ?`,
        ).run(title, description, status, priority, dueDate, noteId, notebookId, gitRepo, gitBranch, gitIssue, gitSourceId, gitIssueState, gitIssueUrl, type, JSON.stringify(tags), parentId, new Date().toISOString(), userId, id);
        const after = this.getWorkItem(userId, id);
        if (after) {
          // M3：活动流——逐字段 diff（含 pm-git 同步等一切调用方）
          appendWorkItemLogs(db, userId, existing, after);
          // 主交付文档变更时自动进多文档关联
          if (after.noteId) linkItemNote(db, userId, after, after.noteId);
        }
      });
      tx();
      return this.getWorkItem(userId, id);
    },

    deleteWorkItem(userId: string, id: string): { success: boolean } {
      getDb().prepare(`DELETE FROM pm_work_items WHERE "userId" = ? AND id = ?`).run(userId, id);
      return { success: true };
    },
    // ===== M3：活动流 / 多文档关联 =====
    /** 活动流：单工单最近变更（倒序，limit 100）。 */
    listWorkItemLogs(userId: string, id: string): PmWorkItemLog[] {
      return getDb()
        .prepare(
          `SELECT field, oldValue, newValue, "createdAt" FROM pm_work_item_logs
           WHERE "userId" = ? AND "itemId" = ?
           ORDER BY "createdAt" DESC, rowid DESC LIMIT 100`,
        )
        .all(userId, id) as PmWorkItemLog[];
    },
    /** 多文档关联列表（LEFT JOIN 核心笔记表取标题；回收站笔记照常返回并由前端标记）。 */
    listItemNotes(userId: string, id: string): PmItemNoteLink[] {
      const rows = getDb()
        .prepare(
          `SELECT n.id, n."noteId", n."createdAt", notes.title AS noteTitle, notes."isTrashed" AS noteTrashed
           FROM pm_item_notes n LEFT JOIN notes ON notes.id = n."noteId"
           WHERE n."userId" = ? AND n."itemId" = ?
           ORDER BY n."createdAt" ASC`,
        )
        .all(userId, id) as Array<{ id: string; noteId: string; createdAt: string; noteTitle: string | null; noteTrashed: number | null }>;
      return rows.map((row) => ({
        id: row.id,
        noteId: row.noteId,
        title: row.noteTitle ?? null,
        isTrashed: row.noteTrashed === 1,
        createdAt: row.createdAt,
      }));
    },
    /** 关联既有笔记（UNIQUE 去重；活动流记 noteLinked）。 */
    addItemNote(userId: string, id: string, noteId: string): { duplicate: boolean } {
      const item = this.getWorkItem(userId, id);
      if (!item) throw new Error("工作项不存在");
      const note = getDb().prepare(`SELECT id FROM notes WHERE id = ?`).get(noteId) as { id: string } | undefined;
      if (!note) throw new Error("笔记不存在");
      const db = getDb();
      let created = false;
      const tx = db.transaction(() => {
        created = linkItemNote(db, userId, item, noteId);
        if (created) {
          db.prepare(
            `INSERT INTO pm_work_item_logs (id, "userId", "itemId", "projectId", field, oldValue, newValue, "createdAt")
             VALUES (?, ?, ?, ?, 'noteLinked', NULL, ?, ?)`,
          ).run(randomUUID(), userId, item.id, item.projectId, noteId, new Date().toISOString());
        }
      });
      tx();
      return { duplicate: !created };
    },
    /** 解除关联（活动流记 noteUnlinked）；解除主交付文档时同步清空 noteId（记字段日志）。 */
    removeItemNote(userId: string, id: string, noteId: string): { success: boolean; wasPrimary: boolean } {
      const item = this.getWorkItem(userId, id);
      if (!item) throw new Error("工作项不存在");
      const db = getDb();
      let removed = false;
      const tx = db.transaction(() => {
        const result = db.prepare(`DELETE FROM pm_item_notes WHERE "userId" = ? AND "itemId" = ? AND "noteId" = ?`).run(userId, id, noteId);
        removed = result.changes > 0;
        if (!removed) return;
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO pm_work_item_logs (id, "userId", "itemId", "projectId", field, oldValue, newValue, "createdAt")
           VALUES (?, ?, ?, ?, 'noteUnlinked', ?, NULL, ?)`,
        ).run(randomUUID(), userId, item.id, item.projectId, noteId, now);
        if (item.noteId === noteId) {
          db.prepare(`UPDATE pm_work_items SET "noteId" = NULL, "updatedAt" = ? WHERE "userId" = ? AND id = ?`).run(now, userId, id);
          db.prepare(
            `INSERT INTO pm_work_item_logs (id, "userId", "itemId", "projectId", field, oldValue, newValue, "createdAt")
             VALUES (?, ?, ?, ?, 'noteId', ?, NULL, ?)`,
          ).run(randomUUID(), userId, item.id, item.projectId, noteId, now);
        }
      });
      tx();
      return { success: removed, wasPrimary: removed && item.noteId === noteId };
    },

    /** 项目仪表盘：各状态计数 */
    projectStats(userId: string, projectId: string): Record<string, number> {
      const rows = getDb()
        .prepare(`SELECT status, COUNT(*) AS n FROM pm_work_items WHERE "userId" = ? AND "projectId" = ? GROUP BY status`)
        .all(userId, projectId) as Array<{ status: string; n: number }>;
      const stats: Record<string, number> = { todo: 0, doing: 0, review: 0, done: 0, canceled: 0 };
      for (const row of rows) stats[row.status] = row.n;
      return stats;
    },
    // ===== M3：跨项目概览（禅道式统计） =====
    /** 概览聚合：项目/工单计数、状态与类型分布、各项目进度、逾期清单、最近动态。 */
    overview(userId: string): {
      totals: { projects: number; items: number; byStatus: Record<string, number>; byType: Array<{ key: string; label: string; count: number }>; overdue: number };
      projects: Array<{ id: string; name: string; color: string | null; total: number; done: number; byStatus: Record<string, number>; overdue: number }>;
      overdueItems: Array<{ id: string; itemNo: number | null; title: string; dueDate: string; status: string; projectName: string }>;
      recent: Array<{ itemId: string; itemNo: number | null; title: string; field: string; oldValue: string | null; newValue: string | null; createdAt: string }>;
    } {
      const projects = this.listProjects(userId);
      const items = getDb().prepare(`SELECT * FROM pm_work_items WHERE "userId" = ?`).all(userId) as ItemRow[];
      const todayIso = new Date().toISOString().slice(0, 10);
      const typeLabel = new Map<string, string>();
      for (const project of projects) {
        for (const t of this.getProject(userId, project.id)?.typeConfig ?? []) typeLabel.set(t.key, t.label);
      }
      const byStatus: Record<string, number> = { todo: 0, doing: 0, review: 0, done: 0, canceled: 0 };
      const typeCount = new Map<string, number>();
      let overdue = 0;
      const projectStats = new Map<string, { total: number; done: number; byStatus: Record<string, number>; overdue: number }>();
      for (const row of items) {
        const item = rowToItem(row);
        byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
        typeCount.set(item.type, (typeCount.get(item.type) ?? 0) + 1);
        const isOverdue = !!item.dueDate && item.dueDate < todayIso && item.status !== "done" && item.status !== "canceled";
        if (isOverdue) overdue += 1;
        const entry = projectStats.get(item.projectId) ?? { total: 0, done: 0, byStatus: { todo: 0, doing: 0, review: 0, done: 0, canceled: 0 }, overdue: 0 };
        entry.total += 1;
        if (item.status === "done") entry.done += 1;
        entry.byStatus[item.status] = (entry.byStatus[item.status] ?? 0) + 1;
        if (isOverdue) entry.overdue += 1;
        projectStats.set(item.projectId, entry);
      }
      return {
        totals: {
          projects: projects.length,
          items: items.length,
          byStatus,
          byType: Array.from(typeCount.entries()).map(([key, count]) => ({ key, label: typeLabel.get(key) ?? key, count })),
          overdue,
        },
        projects: projects.map((p) => {
          const entry = projectStats.get(p.id) ?? { total: 0, done: 0, byStatus: { todo: 0, doing: 0, review: 0, done: 0, canceled: 0 }, overdue: 0 };
          return { id: p.id, name: p.name, color: p.color, total: entry.total, done: entry.done, byStatus: entry.byStatus, overdue: entry.overdue };
        }),
        overdueItems: items
          .filter((row) => {
            const item = rowToItem(row);
            return !!item.dueDate && item.dueDate < todayIso && item.status !== "done" && item.status !== "canceled";
          })
          .map((row) => {
            const item = rowToItem(row);
            return { id: item.id, itemNo: item.itemNo, title: item.title, dueDate: item.dueDate ?? "", status: item.status, projectName: projects.find((p) => p.id === item.projectId)?.name ?? "" };
          }),
        recent: getDb()
          .prepare(
            `SELECT l."itemId", w."itemNo", w.title, l.field, l.oldValue, l.newValue, l."createdAt"
             FROM pm_work_item_logs l JOIN pm_work_items w ON w.id = l."itemId"
             WHERE l."userId" = ?
             ORDER BY l."createdAt" DESC, l.rowid DESC LIMIT 10`,
          )
          .all(userId) as Array<{ itemId: string; itemNo: number | null; title: string; field: string; oldValue: string | null; newValue: string | null; createdAt: string }>,
      };
    },
  };
}

export const pmRepository = createPmRepository();
