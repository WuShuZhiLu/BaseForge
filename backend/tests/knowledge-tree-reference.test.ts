import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-knowledge-reference-"));
process.env.DB_PATH = path.join(tempDir, "knowledge-reference.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("copying a document creates a shared reference path", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const {
    createKnowledgeChild,
    createKnowledgeReference,
    deleteKnowledgeNode,
    listKnowledgeTree,
    moveKnowledgeReference,
    renameKnowledgeReference,
  } = await import("../src/services/knowledgeTree.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("owner", "owner", "hash");

  const folderA = createKnowledgeChild({
    actorUserId: "owner", workspaceId: null, parentId: null, nodeType: "folder", title: "A", db,
  });
  const folderB = createKnowledgeChild({
    actorUserId: "owner", workspaceId: null, parentId: null, nodeType: "folder", title: "B", db,
  });
  const note = createKnowledgeChild({
    actorUserId: "owner", workspaceId: null, parentId: folderA.id, nodeType: "mindmap", title: "导图", db,
  });

  // 复制 = 连接：只多一条路径，正文仍只有一份。
  const reference = createKnowledgeReference({ actorUserId: "owner", nodeId: note.id, db });
  assert.equal(reference.isReference, true);
  assert.equal(reference.resourceId, note.resourceId);
  assert.equal(reference.parentId, folderA.id);
  // 正文只有一行：复制没有产生第二份存储。
  const noteRows = db.prepare("SELECT COUNT(*) AS count FROM notes WHERE notebookId = ?")
    .get(folderA.resourceId) as { count: number };
  assert.equal(Number(noteRows.count), 1);

  let tree = listKnowledgeTree({ userId: "owner", workspaceId: null, db });
  const sameNoteRows = tree.filter((row) => row.resourceId === note.resourceId);
  assert.equal(sameNoteRows.length, 2, "同一篇文档应出现两条路径");
  assert.equal(sameNoteRows.filter((row) => row.isReference).length, 1);
  assert.equal(tree.find((row) => row.id === folderA.id)?.childCount, 2);

  // 改名改的是同一份正文：两条路径一起变。
  renameKnowledgeReference({ actorUserId: "owner", referenceId: reference.id, title: "改名后的导图", db });
  tree = listKnowledgeTree({ userId: "owner", workspaceId: null, db });
  assert.equal(
    tree.filter((row) => row.resourceId === note.resourceId).every((row) => row.title === "改名后的导图"),
    true,
  );

  // 移动到另一个文件夹只动路径，正文不动。
  const moved = moveKnowledgeReference({
    actorUserId: "owner", referenceId: reference.id, parentId: folderB.id, db,
  });
  assert.equal(moved.parentId, folderB.id);
  assert.equal(
    (db.prepare("SELECT notebookId FROM notes WHERE id = ?").get(note.resourceId) as { notebookId: string }).notebookId,
    folderA.resourceId,
    "引用移动不能改正文所属目录",
  );

  // 删掉一条路径：正文还在。
  deleteKnowledgeNode({ actorUserId: "owner", nodeId: reference.id, mode: "subtree", db });
  assert.equal(
    (db.prepare("SELECT isTrashed FROM notes WHERE id = ?").get(note.resourceId) as { isTrashed: number }).isTrashed,
    0,
  );
  tree = listKnowledgeTree({ userId: "owner", workspaceId: null, db });
  assert.equal(tree.filter((row) => row.resourceId === note.resourceId).length, 1);

  // 重新复制时复活被删掉的那条路径（UNIQUE(parentId, resourceId) 仍占位）。
  const revived = createKnowledgeReference({ actorUserId: "owner", nodeId: note.id, parentId: folderB.id, db });
  assert.equal(revived.id, reference.id);
  assert.equal(revived.parentId, folderB.id);
  tree = listKnowledgeTree({ userId: "owner", workspaceId: null, db });
  assert.equal(tree.filter((row) => row.resourceId === note.resourceId).length, 2);

  // 两条路径都删掉：正文才进回收站（每次删除后重新读树，与侧栏行为一致）。
  for (let guard = 0; guard < 4; guard += 1) {
    const rows = listKnowledgeTree({ userId: "owner", workspaceId: null, db })
      .filter((row) => row.resourceId === note.resourceId);
    if (rows.length === 0) break;
    deleteKnowledgeNode({ actorUserId: "owner", nodeId: rows[0].id, mode: "subtree", db });
  }
  assert.equal(
    (db.prepare("SELECT isTrashed FROM notes WHERE id = ?").get(note.resourceId) as { isTrashed: number }).isTrashed,
    1,
  );
});

test("a root-level document reports a clear error instead of an invisible copy", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const { createKnowledgeChild, createKnowledgeReference, listKnowledgeTree } =
    await import("../src/services/knowledgeTree.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("owner3", "owner3", "hash");

  // 根目录文档挂在隐藏容器下，列树时 parentId 被归一成 null。
  const rootDoc = createKnowledgeChild({
    actorUserId: "owner3", workspaceId: null, parentId: null, nodeType: "note", title: "根目录文档", db,
  });
  assert.throws(
    () => createKnowledgeReference({ actorUserId: "owner3", nodeId: rootDoc.id, db }),
    /根目录文档不能复制为链接/,
  );
  const rows = listKnowledgeTree({ userId: "owner3", workspaceId: null, db })
    .filter((row) => row.resourceId === rootDoc.resourceId);
  assert.equal(rows.length, 1, "不能建一条用户看不到的副本路径");
});

test("deleting the main path hands the document over to the remaining copy", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const {
    createKnowledgeChild,
    createKnowledgeReference,
    deleteKnowledgeNode,
    listKnowledgeTree,
  } = await import("../src/services/knowledgeTree.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("owner2", "owner2", "hash");

  const folderA = createKnowledgeChild({
    actorUserId: "owner2", workspaceId: null, parentId: null, nodeType: "folder", title: "A2", db,
  });
  const folderB = createKnowledgeChild({
    actorUserId: "owner2", workspaceId: null, parentId: null, nodeType: "folder", title: "B2", db,
  });
  const note = createKnowledgeChild({
    actorUserId: "owner2", workspaceId: null, parentId: folderA.id, nodeType: "note", title: "会议纪要", db,
  });
  createKnowledgeReference({ actorUserId: "owner2", nodeId: note.id, parentId: folderB.id, db });

  // 删掉主路径：正文不回收，主节点搬到剩下那条路径所在的目录。
  deleteKnowledgeNode({ actorUserId: "owner2", nodeId: note.id, mode: "subtree", db });
  assert.equal(
    (db.prepare("SELECT isTrashed FROM notes WHERE id = ?").get(note.resourceId) as { isTrashed: number }).isTrashed,
    0,
  );
  assert.equal(
    (db.prepare("SELECT notebookId FROM notes WHERE id = ?").get(note.resourceId) as { notebookId: string }).notebookId,
    folderB.resourceId,
  );
  const tree = listKnowledgeTree({ userId: "owner2", workspaceId: null, db });
  const rows = tree.filter((row) => row.resourceId === note.resourceId);
  assert.equal(rows.length, 1, "搬过去后不能同时留下路径和引用");
  assert.equal(rows[0].parentId, folderB.id);
  assert.equal(rows[0].isReference, undefined);
});
