import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./migrations.impl.js";
import { installKnowledgeTreeFeedTriggers } from "./syncV2KnowledgeTreeFeedMigration.js";
import { installKnowledgeTreeOutboxTriggers } from "./syncV2KnowledgeTreeOutboxMigration.js";

/** 旧版（nowen 时代）根文档容器持久化 ID 前缀。 */
const LEGACY_PREFIX = "__nowen_root_documents__:";
/** 当前代码使用的根文档容器持久化 ID 前缀。 */
const NEW_PREFIX = "__baseforge_root_documents__:";

/**
 * 表是否存在（老库可能还没建出某张表，统一守卫后再 UPDATE）。
 */
function hasTable(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

/**
 * v142：把持久化 ID 里的 nowen 根文档前缀迁移为 baseforge。
 *
 * 背景：`9c4bf7e9` 把 `__nowen_root_documents__:` 改成了 `__baseforge_root_documents__:`。
 * 它不是显示名，而是写进 notebooks.id / knowledge_tree_nodes / notes.notebookId
 * 的持久化标识；已应用迁移建出来的同步触发器体内也固化了旧前缀的 GLOB。
 * 新代码认不出旧前缀 → 根文档容器识别失效（另建新容器）、触发器产生同步噪音。
 *
 * 动作：
 *  1. 先 DROP 依赖该前缀 GLOB 的 6 个同步触发器（避免迁移期间的 UPDATE 被旧
 *     GLOB 放行而产生事件噪音，重建后体内即用新前缀）；
 *  2. 数据前缀替换：notebooks.id/parentId/name、notes.notebookId、
 *     knowledge_tree_nodes 的 id/parentId/resourceId、history/references/acl
 *     的节点引用、notebook 维度引用表，以及 sync_outbox / sync_changes_v2 里
 *     存量 entityId 与 payload；
 *  3. DROP + CREATE 重建 feed / outbox 触发器（复用现有安装函数，体内 GLOB
 *     自然带上新前缀）。
 *
 * 外键：迁移框架把每条迁移包在事务里，PRAGMA foreign_keys 已在连接上开启且
 * 事务内不可切换；这里用 `PRAGMA defer_foreign_keys = ON` 把外键校验推迟到
 * COMMIT——先改父键（notebooks.id / 节点 id）再改子引用，提交时全部一致。
 * 幂等：所有 UPDATE 都以前缀 GLOB/LIKE 收口，重复执行为 no-op。
 */
export const rootDocumentPrefixMigration: Migration = {
  version: 142,
  name: "root-document-prefix-nowen-to-baseforge",
  up(db) {
    // 新库（schema.ts 基线直建）不会有旧前缀数据，但触发器仍可能带旧 GLOB，
    // 触发器重建必须无条件执行。
    const legacyNotebookExists = hasTable(db, "notebooks") && Boolean(
      db.prepare(
        "SELECT 1 FROM notebooks WHERE id GLOB ? LIMIT 1",
      ).get(`${LEGACY_PREFIX}*`),
    );
    if (!hasTable(db, "knowledge_tree_nodes") && !legacyNotebookExists) {
      // 极早期库：树表和旧前缀都不存在，只重建触发器即可。
      rebuildSyncTriggers(db);
      return;
    }

    // ---- 1. 摘掉依赖旧前缀 GLOB 的同步触发器，避免迁移期间产生事件噪音 ----
    db.exec(`
      DROP TRIGGER IF EXISTS sync_v2_knowledge_tree_feed_insert;
      DROP TRIGGER IF EXISTS sync_v2_knowledge_tree_feed_update;
      DROP TRIGGER IF EXISTS sync_v2_knowledge_tree_feed_delete;
      DROP TRIGGER IF EXISTS sync_outbox_knowledge_tree_insert;
      DROP TRIGGER IF EXISTS sync_outbox_knowledge_tree_update;
      DROP TRIGGER IF EXISTS sync_outbox_knowledge_tree_delete;
    `);

    // ---- 2. 外键校验推迟到 COMMIT（事务内不可切换 foreign_keys 本体）----
    db.exec("PRAGMA defer_foreign_keys = ON;");

    // ---- 3. 树节点 id 先改（后续引用都指向新 id）----
    db.prepare(`
      UPDATE knowledge_tree_nodes
         SET id = REPLACE(id, ?, ?)
       WHERE id GLOB 'notebook:${LEGACY_PREFIX}*'
    `).run(LEGACY_PREFIX, NEW_PREFIX);

    // ---- 4. notes.notebookId（触发器会对每行做一次树同步，指向已改名的节点）----
    if (hasTable(db, "notes")) {
      db.prepare(`
        UPDATE notes
           SET notebookId = REPLACE(notebookId, ?, ?)
         WHERE notebookId GLOB '${LEGACY_PREFIX}*'
      `).run(LEGACY_PREFIX, NEW_PREFIX);
    }

    // ---- 5. notebooks.id / parentId / name ----
    if (hasTable(db, "notebooks")) {
      db.prepare(`
        UPDATE notebooks
           SET id = REPLACE(id, ?, ?)
         WHERE id GLOB '${LEGACY_PREFIX}*'
      `).run(LEGACY_PREFIX, NEW_PREFIX);
      db.prepare(`
        UPDATE notebooks
           SET parentId = REPLACE(parentId, ?, ?)
         WHERE parentId GLOB '${LEGACY_PREFIX}*'
      `).run(LEGACY_PREFIX, NEW_PREFIX);
      // 容器隐藏名 `__NOWEN_ROOT_DOCUMENTS__` 也一并统一；非容器行不受影响。
      db.prepare(`
        UPDATE notebooks
           SET name = REPLACE(name, '__NOWEN_ROOT_DOCUMENTS__', '__BASEFORGE_ROOT_DOCUMENTS__')
         WHERE name GLOB '*__NOWEN_ROOT_DOCUMENTS__*'
      `).run();
    }

    // ---- 6. 树节点 resourceId（notebook 类型）/ parentId ----
    db.prepare(`
      UPDATE knowledge_tree_nodes
         SET resourceId = REPLACE(resourceId, ?, ?)
       WHERE resourceType = 'notebook' AND resourceId GLOB '${LEGACY_PREFIX}*'
    `).run(LEGACY_PREFIX, NEW_PREFIX);
    db.prepare(`
      UPDATE knowledge_tree_nodes
         SET parentId = REPLACE(parentId, ?, ?)
       WHERE parentId GLOB 'notebook:${LEGACY_PREFIX}*'
    `).run(LEGACY_PREFIX, NEW_PREFIX);

    // ---- 7. 树的附属表：history / references / acl 的节点引用 ----
    const nodeRefColumns: Array<[string, string]> = [
      ["knowledge_tree_history", "nodeId"],
      ["knowledge_tree_history", "fromParentId"],
      ["knowledge_tree_history", "toParentId"],
      ["knowledge_tree_references", "parentId"],
      ["knowledge_tree_acl", "nodeId"],
    ];
    for (const [table, column] of nodeRefColumns) {
      if (!hasTable(db, table)) continue;
      db.prepare(`
        UPDATE ${table}
           SET ${column} = REPLACE(${column}, ?, ?)
         WHERE ${column} GLOB 'notebook:${LEGACY_PREFIX}*'
      `).run(LEGACY_PREFIX, NEW_PREFIX);
    }

    // ---- 8. 其余引用 notebookId 的表（老库可能还没建，逐表守卫）----
    const notebookRefColumns: Array<[string, string]> = [
      ["notebook_members", "notebookId"],
      ["notebook_share_links", "notebookId"],
      ["notebook_passwords", "notebookId"],
      ["user_search_notebook_exclusions", "notebookId"],
      ["wechat_assistant_profiles", "notebookId"],
    ];
    for (const [table, column] of notebookRefColumns) {
      if (!hasTable(db, table)) continue;
      db.prepare(`
        UPDATE ${table}
           SET ${column} = REPLACE(${column}, ?, ?)
         WHERE ${column} GLOB '${LEGACY_PREFIX}*'
      `).run(LEGACY_PREFIX, NEW_PREFIX);
    }

    // ---- 9. 同步表（无外键）：entityId + payload 文本替换 ----
    if (hasTable(db, "sync_outbox")) {
      db.prepare(`
        UPDATE sync_outbox
           SET entityId = REPLACE(entityId, ?, ?),
               payload = REPLACE(payload, ?, ?)
         WHERE entityId LIKE '%${LEGACY_PREFIX}%'
      `).run(LEGACY_PREFIX, NEW_PREFIX, LEGACY_PREFIX, NEW_PREFIX);
    }
    if (hasTable(db, "sync_changes_v2")) {
      db.prepare(`
        UPDATE sync_changes_v2
           SET entityId = REPLACE(entityId, ?, ?)
         WHERE entityId LIKE '%${LEGACY_PREFIX}%'
      `).run(LEGACY_PREFIX, NEW_PREFIX);
    }

    // ---- 10. 重建 feed / outbox 触发器（体内 GLOB 即为新前缀）----
    rebuildSyncTriggers(db);
  },
};

/**
 * 重建知识树 feed / outbox 同步触发器（DROP + CREATE 幂等）。
 */
function rebuildSyncTriggers(db: DatabaseSync): void {
  if (!hasTable(db, "sync_changes_v2") && !hasTable(db, "sync_outbox")) return;
  if (hasTable(db, "knowledge_tree_nodes")) {
    if (hasTable(db, "sync_changes_v2")) installKnowledgeTreeFeedTriggers(db);
    if (hasTable(db, "sync_outbox")) installKnowledgeTreeOutboxTriggers(db);
  }
}
