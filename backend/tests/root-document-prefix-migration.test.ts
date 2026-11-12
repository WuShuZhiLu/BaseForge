import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// sqlite-ext 给 node:sqlite 补 db.transaction / pragma，必须在开连接之前加载。
import "../src/db/sqlite-ext.js";

const LEGACY_PREFIX = "__nowen_root_documents__:";
const NEW_PREFIX = "__baseforge_root_documents__:";
const LEGACY_NOTEBOOK_ID = `${LEGACY_PREFIX}personal:prefix-user`;
const LEGACY_NODE_ID = `notebook:${LEGACY_NOTEBOOK_ID}`;
const NEW_NOTEBOOK_ID = `${NEW_PREFIX}personal:prefix-user`;
const NEW_NODE_ID = `notebook:${NEW_NOTEBOOK_ID}`;

/**
 * 回归：`__nowen_root_documents__` 是持久化 ID 前缀（notebooks.id / 树节点 /
 * notes.notebookId / 同步表），改名后旧库升级会识别不出根文档容器，且已建
 * 出的同步触发器体内固化的旧前缀 GLOB 会同时漏掉新旧两套 id。
 *
 * v142 做数据前缀迁移 + 重建 feed / outbox 触发器。这里在一个含旧前缀数据、
 * 且触发器被还原成旧 GLOB 的「存量库」上重跑迁移并逐项断言。
 */
test("v142 将存量库的 nowen 根文档前缀迁移为 baseforge 并重建触发器", async () => {
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { runMigrations } = await import("../src/db/migrations.js");
  const { DatabaseSync } = await import("node:sqlite");

  // 1) 建到当前版本
  const live = getDb();

  // 2) 构造含旧前缀的存量数据
  live.prepare(
    "INSERT INTO users (id, username, passwordHash) VALUES ('prefix-user', 'prefix', 'x')",
  ).run();
  // 隐藏状态的根文档容器（与 hideRootContainer 后的形态一致）
  live.prepare(`
    INSERT INTO notebooks (id, userId, name, sortOrder, isDeleted)
    VALUES (?, 'prefix-user', '__NOWEN_ROOT_DOCUMENTS__', -2147483648, 1)
  `).run(LEGACY_NOTEBOOK_ID);
  live.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText)
    VALUES ('prefix-note', 'prefix-user', ?, '根文档', '{}', '')
  `).run(LEGACY_NOTEBOOK_ID);
  // 容器节点由 notebooks 的 knowledge_tree_notebooks_ai 触发器自动建出（隐藏状态，
  // id 形如 notebook:__nowen_root_documents__:personal:<uid>）；
  // 文档节点由 notes 的 knowledge_tree_notes_ai 触发器自动建出（parentId 为 NULL，
  // 与根文档「脱离容器」的形态一致）
  live.prepare(`
    INSERT INTO knowledge_tree_history (id, nodeId, action, actorUserId)
    VALUES ('prefix-hist', ?, 'create', 'prefix-user')
  `).run(LEGACY_NODE_ID);

  // 同步表里的存量引用
  live.prepare("INSERT INTO sync_profiles (id, name, serverUrl) VALUES ('prefix-profile', 'p', 'http://localhost')").run();
  live.prepare(`
    INSERT INTO sync_outbox (id, mutationId, profileId, scopeKey, deviceId, entityType, entityId, operation, status)
    VALUES ('ob1', 'm1', 'prefix-profile', 'personal:prefix-user', 'dev1',
            'knowledge_tree_node', ?, 'upsert', 'pending')
  `).run(LEGACY_NODE_ID);
  live.prepare("UPDATE sync_outbox SET payload = ? WHERE id = 'ob1'")
    .run(JSON.stringify({ id: LEGACY_NODE_ID, resourceId: LEGACY_NOTEBOOK_ID }));
  live.prepare(`
    INSERT INTO sync_changes_v2 (entityType, entityId, userId, operation)
    VALUES ('knowledge_tree_node', ?, 'prefix-user', 'upsert')
  `).run(LEGACY_NODE_ID);

  // 3) 触发器还原成旧版形态：体内 GLOB 还是 nowen 前缀（旧库升级的真实场景）
  const legacyTriggers = live
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
              AND name IN ('sync_v2_knowledge_tree_feed_insert', 'sync_outbox_knowledge_tree_insert')`)
    .all() as Array<{ name: string; sql: string }>;
  assert.equal(legacyTriggers.length, 2, "预期存在 2 个依赖根文档前缀 GLOB 的触发器");
  for (const trigger of legacyTriggers) {
    live.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    live.exec(trigger.sql.replaceAll("baseforge_root_documents", "nowen_root_documents"));
  }

  // 4) 回退账本，复制成「存量库」，在新连接上重跑迁移
  live.prepare("DELETE FROM schema_migrations WHERE version >= 142").run();
  closeDb();

  const source = process.env.DB_PATH as string;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v142-regression-"));
  const target = path.join(dir, "existing.db");
  fs.copyFileSync(source, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${source}${suffix}`)) fs.copyFileSync(`${source}${suffix}`, `${target}${suffix}`);
  }

  const existing = new DatabaseSync(target);
  try {
    assert.doesNotThrow(() => runMigrations(existing), "存量库升级不应因前缀迁移中断");

    // 迁移已推进到 142
    const version = existing
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    assert.equal(version.version, 142);

    // notebooks.id / name 前缀已迁移，无重复容器
    const notebook = existing
      .prepare(`SELECT id, name, isDeleted FROM notebooks WHERE id GLOB '*root_documents__:personal:*'`)
      .all() as Array<{ id: string; name: string; isDeleted: number }>;
    assert.deepEqual(notebook, [{
      id: NEW_NOTEBOOK_ID,
      name: "__BASEFORGE_ROOT_DOCUMENTS__",
      isDeleted: 1,
    }]);

    // notes.notebookId 已跟随迁移，笔记没丢
    const note = existing
      .prepare("SELECT notebookId FROM notes WHERE id = 'prefix-note'")
      .get() as { notebookId: string };
    assert.equal(note.notebookId, NEW_NOTEBOOK_ID);

    // 树节点 id / resourceId 已迁移，文档节点还在且无重复容器节点
    const treeCount = existing
      .prepare("SELECT COUNT(*) AS count FROM knowledge_tree_nodes WHERE id GLOB '*root_documents__:personal:*'")
      .get() as { count: number };
    assert.equal(treeCount.count, 1, "容器节点应恰好一份且为新前缀");
    const containerNode = existing
      .prepare("SELECT id, resourceId FROM knowledge_tree_nodes WHERE id = ?")
      .get(NEW_NODE_ID) as { id: string; resourceId: string };
    assert.equal(containerNode.resourceId, NEW_NOTEBOOK_ID);
    const docNode = existing
      .prepare("SELECT id FROM knowledge_tree_nodes WHERE id = 'note:prefix-note'")
      .get();
    assert.ok(docNode, "根文档节点应保留");

    // history 引用已跟随迁移
    const history = existing
      .prepare("SELECT nodeId FROM knowledge_tree_history WHERE id = 'prefix-hist'")
      .get() as { nodeId: string };
    assert.equal(history.nodeId, NEW_NODE_ID);

    // 同步表 entityId / payload 已迁移
    const outbox = existing
      .prepare("SELECT entityId, payload FROM sync_outbox WHERE id = 'ob1'")
      .get() as { entityId: string; payload: string };
    assert.equal(outbox.entityId, NEW_NODE_ID);
    assert.ok(outbox.payload.includes(NEW_PREFIX), "payload 里的旧前缀应被替换");
    const change = existing
      .prepare(`SELECT entityId FROM sync_changes_v2 WHERE entityType = 'knowledge_tree_node' AND entityId GLOB '*root_documents__:personal:*'`)
      .get() as { entityId: string };
    assert.equal(change.entityId, NEW_NODE_ID);

    // 库里不应再残留旧前缀
    const staleNotebooks = existing
      .prepare(`SELECT COUNT(*) AS count FROM notebooks WHERE id GLOB '__nowen_root_documents__:*'`)
      .get() as { count: number };
    assert.equal(staleNotebooks.count, 0);

    // 触发器已重建，体内 GLOB 用新前缀、不再含旧前缀
    const rebuilt = existing
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
                AND name IN ('sync_v2_knowledge_tree_feed_insert', 'sync_outbox_knowledge_tree_insert')`)
      .all() as Array<{ name: string; sql: string }>;
    assert.equal(rebuilt.length, 2, "触发器应被重建");
    for (const trigger of rebuilt) {
      assert.ok(trigger.sql.includes("notebook:__baseforge_root_documents__:*"),
        `${trigger.name} 的 GLOB 应使用新前缀`);
      assert.ok(!trigger.sql.includes("__nowen_root_documents__"),
        `${trigger.name} 不应再包含旧前缀`);
    }

  } finally {
    existing.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
