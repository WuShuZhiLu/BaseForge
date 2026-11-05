import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// sqlite-ext 给 node:sqlite 补 db.transaction / pragma，必须在开连接之前加载。
import "../src/db/sqlite-ext.js";

/**
 * 回归：存量库升级时 v139 会 `UPDATE notes SET note_type='normal'`。
 *
 * notes 上的 FTS 同步触发器（notes_search_ai/ad/au）引用自定义函数
 * nowen_search_normalize，只要触发器存在，任何触碰 notes 的语句在 prepare 阶段
 * 就要解析它 —— 哪怕 AU 的 WHEN 条件最终不成立。而迁移跑在
 * ensureNormalizedSearchFts() 之前，函数还没注册到这条连接上，
 * 于是老库升级直接 `no such function: nowen_search_normalize` 打断启动。
 *
 * 新库没有触发器，所以只建新库的迁移测试永远发现不了这个坑 —— 这里必须
 * 先让触发器存在，再在一个「新连接」上重跑 v139。
 */
test("v139 在已有 notes 搜索触发器的存量库上不会因 no such function 中断", async () => {
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { runMigrations } = await import("../src/db/migrations.js");
  const { DatabaseSync } = await import("node:sqlite");

  // 1) 建到当前版本：这一步会创建 notes_search_* 触发器
  const live = getDb();
  const triggers = live
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'notes_search_%'")
    .all() as { name: string }[];
  assert.equal(triggers.length, 3, "预期 notes 上有 3 个搜索同步触发器");

  // 2) 造一条历史「今日日记」笔记（note_type='journal'）
  live.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('v139-user', 'v139', 'x')").run();
  live.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('v139-nb', 'v139-user', 'nb')").run();
  live.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, note_type)
    VALUES ('v139-note', 'v139-user', 'v139-nb', '今日', '{}', '', 'journal')
  `).run();

  // 3) 回退账本，让 v139/v140 重新进入 pending
  live.prepare("DELETE FROM schema_migrations WHERE version >= 139").run();
  closeDb();

  // 4) 复制成一个「存量库」，在新连接上重跑（新连接没有注册自定义函数）
  const source = process.env.DB_PATH as string;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v139-regression-"));
  const target = path.join(dir, "existing.db");
  fs.copyFileSync(source, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${source}${suffix}`)) fs.copyFileSync(`${source}${suffix}`, `${target}${suffix}`);
  }

  const existing = new DatabaseSync(target);
  try {
    assert.doesNotThrow(() => runMigrations(existing), "存量库升级不应因搜索触发器引用未注册函数而中断");

    const row = existing
      .prepare("SELECT note_type FROM notes WHERE id = 'v139-note'")
      .get() as { note_type: string } | undefined;
    assert.equal(row?.note_type, "normal", "历史日记应被改回普通笔记，内容不丢");
    const version = existing
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    assert.ok(version.version >= 140, `预期迁移推进到 v140，实际 ${version.version}`);
  } finally {
    existing.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
