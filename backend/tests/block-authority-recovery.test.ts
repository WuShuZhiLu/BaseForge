import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "baseforge-block-authority-recovery-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let closeDb: () => void;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("recovery synchronizes healthy notes and preserves invalid note snapshots", async () => {
  const [{ getDb, closeDb: close }, store, noteBlocks, recovery] = await Promise.all([
    import("../src/db/schema"),
    import("../src/lib/blockAuthorityStore"),
    import("../src/lib/noteBlocks"),
    import("../src/services/blockAuthorityRecovery"),
  ]);
  closeDb = close;
  const db = getDb();
  const userId = "recovery-user";
  const notebookId = "recovery-notebook";
  const healthyId = "35353535-3535-4535-8535-353535353535";
  const invalidId = "36363636-3636-4636-8636-363636363636";
  const healthyContent = JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "恢复成功" }] }],
  });
  const initialInvalidContent = JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "旧快照" }] }],
  });
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(userId, userId, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(notebookId, userId, "恢复测试");
  const insert = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, ?, ?, '', 'tiptap-json', 1)
  `);
  insert.run(healthyId, userId, notebookId, "健康", healthyContent);
  insert.run(invalidId, userId, notebookId, "损坏", initialInvalidContent);

  const initialSync = noteBlocks.syncNoteBlocks(db, invalidId, initialInvalidContent, "tiptap-json");
  store.rebuildBlockAuthorityStore(db, invalidId, initialSync.content, "tiptap-json", {
    noteVersion: 1,
    operationType: "snapshot",
  });
  const invalidContent = "{not-json";
  db.prepare("UPDATE notes SET content = ? WHERE id = ?").run(invalidContent, invalidId);

  const result = recovery.synchronizeRecoveredBlockAuthority(db, [healthyId, invalidId, healthyId, "missing"]);

  assert.equal(result.synchronized, 1);
  assert.deepEqual(result.skipped, ["missing"]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.noteId, invalidId);
  assert.equal((db.prepare("SELECT status FROM note_block_documents WHERE noteId = ?").get(healthyId) as any).status, "healthy");
  const persistedHealthyContent = (db.prepare("SELECT content FROM notes WHERE id = ?").get(healthyId) as any).content;
  assert.notEqual(persistedHealthyContent, healthyContent, "恢复时补齐的 Block ID 必须写回 notes.content");
  assert.deepEqual(
    store.readAuthoritativeNoteContent(db, healthyId, persistedHealthyContent),
    { content: persistedHealthyContent, source: "blocks", status: "healthy" },
  );
  assert.equal((db.prepare("SELECT status FROM note_block_documents WHERE noteId = ?").get(invalidId) as any).status, "mismatch");
  assert.equal((db.prepare("SELECT content FROM notes WHERE id = ?").get(invalidId) as any).content, invalidContent);
  assert.equal(
    (db.prepare("SELECT operationType FROM note_block_operations WHERE noteId = ? ORDER BY createdAt DESC LIMIT 1")
      .get(healthyId) as any).operationType,
    "recovery-sync",
  );
});

test("legacy notes declaring tiptap-json but holding HTML recover without mismatch", async () => {
  // baseforge 早期版本把 HTML 直接写进 notes.content，contentFormat 走了列默认值
  // 'tiptap-json'（真实整库导出包里 56 篇有 52 篇如此）。这类笔记若按声明格式
  // JSON.parse 必然失败，导入后每篇都被标成 block 权威 mismatch，且 contentText
  // 为空导致搜索不到。恢复流程必须按内容形态判定，并派生文本写回。
  const [{ getDb }, recovery] = await Promise.all([
    import("../src/db/schema"),
    import("../src/services/blockAuthorityRecovery"),
  ]);
  const db = getDb();
  const userId = "legacy-html-user";
  const notebookId = "legacy-html-notebook";
  const noteId = "37373737-3737-4737-8737-373737373737";
  const html = "<h1>硬链接</h1><p>a &amp; b</p>";

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(userId, userId, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(notebookId, userId, "HTML 旧数据");
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, ?, ?, '', 'tiptap-json', 1)
  `).run(noteId, userId, notebookId, "硬链接", html);

  const result = recovery.synchronizeRecoveredBlockAuthority(db, [noteId]);
  assert.equal(result.failures.length, 0, result.failures.map((item) => item.error).join("; "));
  assert.equal(result.synchronized, 1);

  // contentFormat 保持声明值：前端 TipTap 能直接吃 HTML，用户首次保存后自愈成
  // 合法 tiptap JSON；改成 html 反而会把笔记降级成只读预览。
  const row = db.prepare("SELECT contentFormat, contentText FROM notes WHERE id = ?").get(noteId) as {
    contentFormat: string;
    contentText: string;
  };
  assert.equal(row.contentFormat, "tiptap-json");
  assert.match(row.contentText, /硬链接/);
  assert.match(row.contentText, /a & b/);
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM note_block_documents WHERE noteId = ?").get(noteId) as { c: number }).c,
    0,
    "HTML 内容不能物化 block 权威存储",
  );
});

test("manual transactions are visible to the nested transaction runner", async () => {
  // 导入流程用 beginManualTransaction 开事务，事务体里还会调用 db.transaction()
  // （synchronizeRecoveredBlockAuthority → syncNoteBlocks）。不登记深度时内层会
  // 重发 BEGIN，SQLite 抛 cannot start a transaction within a transaction。
  const [{ getDb }, ext] = await Promise.all([
    import("../src/db/schema"),
    import("../src/db/sqlite-ext"),
  ]);
  const db = getDb();
  let innerRan = false;
  ext.beginManualTransaction(db);
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO system_settings (key, value) VALUES (?, ?)").run("manual-tx-probe", "1");
      innerRan = true;
    })();
    ext.commitManualTransaction(db);
  } catch (error) {
    try { ext.rollbackManualTransaction(db); } catch { /* ignore */ }
    throw error;
  }
  assert.equal(innerRan, true);
  assert.equal(
    (db.prepare("SELECT value FROM system_settings WHERE key = ?").get("manual-tx-probe") as { value: string }).value,
    "1",
  );
  db.prepare("DELETE FROM system_settings WHERE key = ?").run("manual-tx-probe");
});
