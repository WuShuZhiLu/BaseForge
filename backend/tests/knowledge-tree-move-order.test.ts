import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-kb-move-"));
process.env.DB_PATH = path.join(tempDir, "kb-move.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("moveKnowledgeNode：按 beforeId/afterId 插入并重排兄弟顺序", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const { createKnowledgeChild } = await import("../src/services/knowledgeTreeRootDocuments.js");
  const { moveKnowledgeNode } = await import("../src/services/knowledgeTreeRootDocuments.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("u-move", "u-move", "hash");

  // 根级 folder = 知识库
  const kb = createKnowledgeChild({
    actorUserId: "u-move", workspaceId: null, parentId: null, nodeType: "folder", title: "KB",
  });
  const f1 = createKnowledgeChild({ actorUserId: "u-move", workspaceId: null, parentId: kb.id, nodeType: "folder", title: "1" });
  const f2 = createKnowledgeChild({ actorUserId: "u-move", workspaceId: null, parentId: kb.id, nodeType: "folder", title: "2" });
  const f3 = createKnowledgeChild({ actorUserId: "u-move", workspaceId: null, parentId: kb.id, nodeType: "folder", title: "3" });

  const order = () => (db.prepare(`
    SELECT id FROM knowledge_tree_nodes
     WHERE parentId = ? AND isDeleted = 0 ORDER BY sortOrder, id
  `).all(kb.id) as Array<{ id: string }>)
    .map((row) => [f1.id, f2.id, f3.id].indexOf(row.id) + 1)
    .filter((value) => value > 0);

  assert.deepEqual(order(), [1, 2, 3]);

  // 3 拖到 1 之前
  moveKnowledgeNode({ actorUserId: "u-move", nodeId: f3.id, parentId: kb.id, beforeId: f1.id });
  assert.deepEqual(order(), [3, 1, 2], "beforeId 应插到目标之前");

  // 1 拖到 2 之后
  moveKnowledgeNode({ actorUserId: "u-move", nodeId: f1.id, parentId: kb.id, afterId: f2.id });
  assert.deepEqual(order(), [3, 2, 1], "afterId 应插到目标之后");
});

test("moveKnowledgeNode：知识库（根级）不允许被移入其它知识库", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild, moveKnowledgeNode } = await import("../src/services/knowledgeTreeRootDocuments.js");

  const db = getDb();
  const kbA = createKnowledgeChild({ actorUserId: "u-move", workspaceId: null, parentId: null, nodeType: "folder", title: "A" });
  const kbB = createKnowledgeChild({ actorUserId: "u-move", workspaceId: null, parentId: null, nodeType: "folder", title: "B" });

  assert.throws(
    () => moveKnowledgeNode({ actorUserId: "u-move", nodeId: kbA.id, parentId: kbB.id }),
    (error: unknown) => (error as { code?: string }).code === "KNOWLEDGE_ROOT_NOTEBOOK_MOVE_FORBIDDEN",
  );
  // 根层之间重排仍然允许
  const moved = moveKnowledgeNode({ actorUserId: "u-move", nodeId: kbA.id, parentId: null, beforeId: kbB.id });
  assert.equal(moved.parentId, null);
  const rootOrder = (db.prepare(`
    SELECT id FROM knowledge_tree_nodes WHERE parentId IS NULL AND isDeleted = 0 ORDER BY sortOrder, id
  `).all() as Array<{ id: string }>).map((row) => row.id);
  assert.ok(rootOrder.indexOf(kbA.id) < rootOrder.indexOf(kbB.id), "A 应排在 B 之前");
});
