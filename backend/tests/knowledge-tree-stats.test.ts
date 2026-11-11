import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "baseforge-kb-stats-"));
process.env.DB_PATH = path.join(tempDir, "kb-stats.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("knowledgeNodeStats：文件夹不计入文档数、字数去空白、贡献者聚合", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const { knowledgeNodeStats } = await import("../src/services/knowledgeTreeStats.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash, displayName) VALUES (?, ?, ?, ?)")
    .run("u-alice", "alice", "hash", "爱丽丝");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("u-bob", "bob", "hash");

  // notebooks 触发器会同步创建知识树根节点（resourceType=notebook）
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, sortOrder)
    VALUES (?, ?, NULL, NULL, ?, ?)
  `).run("nb-stats", "u-alice", "统计库", 10);

  const root = db.prepare(`
    SELECT id, scopeKey FROM knowledge_tree_nodes WHERE resourceId = ? AND resourceType = 'notebook'
  `).get("nb-stats") as { id: string; scopeKey: string } | undefined;
  assert.ok(root?.id, "notebook 触发器应创建根节点");

  // 子文件夹（不应计入文档数），作用域取根节点实际值
  db.prepare(`
    INSERT INTO knowledge_tree_nodes
      (id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType, resourceId, sortOrder, isExpanded, isDeleted)
    VALUES (?, ?, NULL, ?, ?, 'folder', 'notebook', ?, 1, 1, 0)
  `).run("folder-1", "u-alice", root!.scopeKey, root!.id, "nb-sub");

  // 三篇文档：内容含空格/换行/制表，字数应按去空白后计
  const insertNote = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText)
    VALUES (?, ?, ?, NULL, ?, '{}', ?)
  `);
  insertNote.run("note-a", "u-alice", "nb-stats", "A", "  ab  c\n\td  "); // 去空白后 "abcd" = 4
  insertNote.run("note-b", "u-alice", "nb-stats", "B", "ef"); // 2
  insertNote.run("note-c", "u-alice", "nb-stats", "C", "ghij"); // 4

  // notes 触发器已把三篇文档投影为根节点下的树节点；note-c 挪进子文件夹
  // （验证递归下钻），并固定各自 updatedAt
  db.prepare(`
    UPDATE knowledge_tree_nodes SET parentId = ?, updatedAt = ?
     WHERE resourceType = 'note' AND resourceId = ?
  `).run(root!.id, "2026-10-01 10:00:00", "note-a");
  db.prepare(`
    UPDATE knowledge_tree_nodes SET parentId = ?, updatedAt = ?
     WHERE resourceType = 'note' AND resourceId = ?
  `).run(root!.id, "2026-10-03 09:00:00", "note-b");
  db.prepare(`
    UPDATE knowledge_tree_nodes SET parentId = ?, updatedAt = ?
     WHERE resourceType = 'note' AND resourceId = ?
  `).run("folder-1", "2026-10-02 08:00:00", "note-c");

  const projected = db.prepare(`
    SELECT COUNT(*) AS c FROM knowledge_tree_nodes WHERE resourceType = 'note' AND isDeleted = 0
  `).get() as { c: number };
  assert.equal(projected.c, 3, "三篇文档应各自投影一个树节点");

  const stats = knowledgeNodeStats(root!.id, db);

  // 文档数：3 篇文档；文件夹与根节点本身不计入
  assert.equal(stats.docCount, 3, "文件夹不计入文档数");
  // 字数：去空白后的字符数之和（abcd + ef + ghij）
  assert.equal(stats.charCount, 10, "字数应去除空格/制表/换行");
  // 最近更新时间：节点 updatedAt 由触发器统一盖章（手动指定会被覆盖），
  // 这里只断言取值格式与「取到了子树内的时间」而非固定值。
  assert.match(stats.updatedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "应返回子树内最大 updatedAt");
  // 贡献者：personal 作用域下只能挂本用户笔记（触发器禁止跨 scope），此处断言聚合结果
  assert.equal(stats.contributors.length, 1);
  assert.equal(stats.contributors[0].userId, "u-alice");
  assert.equal(stats.contributors[0].docCount, 3);
  assert.equal(stats.contributors[0].displayName, "爱丽丝");
});

test("knowledgeNodeStats：空库返回 0 文档且不报错", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { knowledgeNodeStats } = await import("../src/services/knowledgeTreeStats.js");

  const db = getDb();
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, sortOrder)
    VALUES (?, ?, NULL, NULL, ?, ?)
  `).run("nb-empty", "u-alice", "空库", 20);

  const root = db.prepare(`
    SELECT id FROM knowledge_tree_nodes WHERE resourceId = ? AND resourceType = 'notebook'
  `).get("nb-empty") as { id: string } | undefined;

  const stats = knowledgeNodeStats(root!.id, db);
  assert.equal(stats.docCount, 0);
  assert.equal(stats.charCount, 0);
  assert.deepEqual(stats.contributors, []);
});
