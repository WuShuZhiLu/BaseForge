import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-color-mark-"));
process.env.DB_PATH = path.join(tempDir, "knowledge-tree-color.db");

const owner = "tree-color-owner";
const notebookId = "tree-color-notebook";
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

/**
 * 回归：知识树节点必须带出笔记色标。
 *
 * `knowledgeTreeListing` / `sharedKnowledgeTreeListing` 的 SELECT 里少一列
 * `note.colorMark AS colorMark` 时：接口 200、类型也对（`colorMark?` 是可选），
 * 但前端 `NoteColorMarkDot` 拿到 undefined 就什么都不画 —— 侧栏/树里"改了颜色看不到"。
 */
test("knowledge tree nodes expose the note color mark", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const { createKnowledgeChild, listKnowledgeTree } = await import("../src/services/knowledgeTree.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(owner, owner, "hash");

  const folder = createKnowledgeChild({
    actorUserId: owner,
    parentId: null,
    nodeType: "folder",
    title: "资料",
    db,
  });
  const colored = createKnowledgeChild({
    actorUserId: owner,
    parentId: folder.id,
    nodeType: "document",
    title: "带颜色的笔记",
    db,
  });
  const plain = createKnowledgeChild({
    actorUserId: owner,
    parentId: folder.id,
    nodeType: "document",
    title: "普通笔记",
    db,
  });

  db.prepare("UPDATE notes SET colorMark = 'purple' WHERE id = ?").run(colored.resourceId);

  const tree = listKnowledgeTree({ userId: owner, workspaceId: null, db });
  const coloredNode = tree.find((node) => node.id === colored.id);
  const plainNode = tree.find((node) => node.id === plain.id);
  const folderNode = tree.find((node) => node.id === folder.id);

  assert.equal(coloredNode?.colorMark, "purple");
  assert.equal(plainNode?.colorMark, null);
  // 非笔记节点（目录）不应带出任何颜色。
  assert.equal(folderNode?.colorMark, null);
});
