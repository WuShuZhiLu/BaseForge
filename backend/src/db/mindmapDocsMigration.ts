import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";
import { collectMindmapTexts, defaultMindmapContent } from "../lib/mindmapData.js";
import { resolveMindmapFallbackNotebook } from "../services/mindmapDocs.js";
import { MINDMAP_LEGACY_NOTEBOOK_PREFIX } from "./knowledgeTreeMindmapFolderMigration.js";

interface LegacyMindmapRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  data: string | null;
  starred: number | null;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LegacyNodeRow {
  resourceId: string;
  parentId: string | null;
  sortOrder: number | null;
  isDeleted: number | null;
  deletedAt: string | null;
}

/** 兜底建表 DDL 保持本地：import mindmap-schema 会拉起 db/schema，把迁移列表注册期间的
 *  CURRENT_SCHEMA_VERSION 冻结在旧值（见 knowledgeTreeResourceMigration 同款注释）。 */
function ensureMindmapsTableLocal(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mindmaps (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      title TEXT NOT NULL DEFAULT '无标题导图',
      data TEXT NOT NULL DEFAULT '{}',
      starred INTEGER NOT NULL DEFAULT 0,
      folderId TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * v131: 思维导图归一知识库文档。
 *
 * mindmaps 独立表迁为 notes 行（contentFormat="mindmap"，正文存 MindMapData JSON），
 * 沿用原 id —— 现有 ![[mindmap:<id>]] 嵌入引用不失效。树节点由 notes 投影触发器
 * 重建为 note:<id>，位置（parentId/sortOrder）对齐旧导图节点；导图文件夹继续以
 * 伪 notebook 容器存在（__nowen_mindmap_folder__ 前缀）。回收站中的导图按
 * isTrashed=1 迁移，之后由笔记回收站链路接管。迁移末尾清空 mindmaps 并卸载
 * 导图树投影触发器；导图与笔记的同步/搜索/回收站从此共用 notes 一条链路。
 */
export const mindmapDocsMigration: Migration = {
  version: 131,
  name: "mindmap-docs",
  up(db) {
    ensureMindmapsTableLocal(db);

    const maps = db.prepare("SELECT * FROM mindmaps").all() as LegacyMindmapRow[];
    if (maps.length > 0) {
      const legacyNodes = new Map<string, LegacyNodeRow>();
      for (const node of db.prepare(`
        SELECT resourceId, parentId, sortOrder, isDeleted, deletedAt
        FROM knowledge_tree_nodes WHERE resourceType = 'mindmap'
      `).all() as LegacyNodeRow[]) {
        legacyNodes.set(node.resourceId, node);
      }

      // 导图文件夹 → 伪 notebook（真实 notebooks 行）的映射，作用域必须一致。
      const pseudoByFolder = new Map<string, { userId: string; workspaceId: string | null }>();
      for (const row of db.prepare(`
        SELECT id, userId, workspaceId FROM notebooks WHERE id GLOB ?
      `).all(`${MINDMAP_LEGACY_NOTEBOOK_PREFIX}*`) as Array<{ id: string; userId: string; workspaceId: string | null }>) {
        pseudoByFolder.set(row.id.slice(MINDMAP_LEGACY_NOTEBOOK_PREFIX.length), {
          userId: row.userId,
          workspaceId: row.workspaceId,
        });
      }

      const fallbackCache = new Map<string, string>();
      const fallbackFor = (row: LegacyMindmapRow): string => {
        const key = `${row.userId}|${row.workspaceId ?? ""}`;
        let notebookId = fallbackCache.get(key);
        if (!notebookId) {
          notebookId = resolveMindmapFallbackNotebook(db, row.userId, row.workspaceId);
          fallbackCache.set(key, notebookId);
        }
        return notebookId;
      };

      const noteExists = db.prepare("SELECT 1 FROM notes WHERE id = ?");
      const insertNote = db.prepare(`
        INSERT INTO notes (
          id, userId, workspaceId, notebookId, title, content, contentText,
          contentFormat, note_type, isFavorite, isTrashed, trashedAt, sortOrder,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'mindmap', 'normal', ?, ?, ?, ?, ?, ?)
      `);
      const fixNodePosition = db.prepare(
        "UPDATE knowledge_tree_nodes SET parentId = ?, sortOrder = ? WHERE id = ?",
      );

      for (const map of maps) {
        if (noteExists.get(map.id)) continue; // 防御：异常重跑时跳过已迁移的 id
        const legacy = legacyNodes.get(map.id);
        const trashed = legacy?.isDeleted === 1;
        const title = map.title || "无标题导图";
        const content = map.data || defaultMindmapContent(title);

        // notebookId：优先导图文件夹对应的伪 notebook，否则挂靠兜底笔记本。
        let notebookId: string | null = null;
        if (map.folderId) {
          const pseudo = pseudoByFolder.get(map.folderId);
          if (pseudo
            && pseudo.workspaceId === map.workspaceId
            && (map.workspaceId !== null || pseudo.userId === map.userId)) {
            notebookId = `${MINDMAP_LEGACY_NOTEBOOK_PREFIX}${map.folderId}`;
          }
        }
        if (!notebookId) notebookId = fallbackFor(map);

        insertNote.run(
          map.id, map.userId, map.workspaceId, notebookId, title, content,
          collectMindmapTexts(content).join(" "),
          map.starred ? 1 : 0, trashed ? 1 : 0,
          trashed ? legacy?.deletedAt ?? map.updatedAt : null,
          legacy?.sortOrder ?? 0, map.createdAt, map.updatedAt,
        );
        // notes 投影触发器把节点挂在 notebook 下；这里对齐旧的树位置。
        if (!trashed && legacy) {
          fixNodePosition.run(
            legacy.parentId ?? `notebook:${notebookId}`,
            legacy.sortOrder ?? 0,
            `note:${map.id}`,
          );
        }
      }
    }

    // 清空旧表并清理投影树节点。正常路径由 ad 触发器完成，这里显式删除以覆盖
    // 触发器缺失/已卸载的异常库态（幂等）。
    db.prepare("DELETE FROM mindmaps").run();
    db.prepare("DELETE FROM knowledge_tree_nodes WHERE resourceType = 'mindmap'").run();
    db.exec(`
      DROP TRIGGER IF EXISTS knowledge_tree_mindmaps_ai;
      DROP TRIGGER IF EXISTS knowledge_tree_mindmaps_au;
      DROP TRIGGER IF EXISTS knowledge_tree_mindmaps_ad;
    `);
  },
};
