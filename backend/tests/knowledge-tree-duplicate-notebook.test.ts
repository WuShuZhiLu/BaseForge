import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-duplicate-notebook-"));
process.env.DB_PATH = path.join(tempDir, "duplicate-notebook.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("duplicating a folder deep-copies its subtree next to the source", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const { createKnowledgeChild, duplicateKnowledgeNotebook, listKnowledgeTree } =
    await import("../src/services/knowledgeTree.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("owner", "owner", "hash");

  const folder = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "产品资料",
    db,
  });
  const note = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: folder.id,
    nodeType: "markdown",
    title: "需求",
    db,
  });
  const childFolder = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: folder.id,
    nodeType: "folder",
    title: "评审",
    db,
  });
  const childNote = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: childFolder.id,
    nodeType: "note",
    title: "评审记录",
    db,
  });
  // 从未编辑过的富文本笔记正文是 "{}"，没有 Block 结构，也应被原样复制。
  const blankNote = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: folder.id,
    nodeType: "note",
    title: "空白",
    db,
  });
  // 导图与画板同属文档，复制时必须一并带上。
  const mindmapNote = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: folder.id,
    nodeType: "mindmap",
    title: "结构导图",
    db,
  });
  const boardNote = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: folder.id,
    nodeType: "board",
    title: "流程画板",
    db,
  });
  db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
    .run("# 需求\n\n原文正文", "原文正文", note.resourceId);
  db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
    .run(
      JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "评审正文" }] }] }),
      "评审正文",
      childNote.resourceId,
    );

  const result = await duplicateKnowledgeNotebook({ actorUserId: "owner", nodeId: folder.id, db });

  assert.equal(result.title, "产品资料（副本）");
  assert.equal(result.notebookCount, 2);
  assert.equal(result.noteCount, 5);
  assert.equal(result.skippedNoteCount, 0);
  assert.equal(result.skippedFileCount, 0);

  const nodes = listKnowledgeTree({ userId: "owner", workspaceId: null, db });
  const copyRoot = nodes.find((candidate) => candidate.id === result.nodeId);
  assert.ok(copyRoot, "副本目录应出现在知识树里");
  assert.equal(copyRoot.parentId, null);
  assert.equal(copyRoot.title, "产品资料（副本）");
  assert.equal(copyRoot.childCount, 5);

  const copiedChildren = nodes.filter((candidate) => candidate.parentId === result.nodeId);
  const copiedNote = copiedChildren.find((candidate) => candidate.resourceType === "note");
  const copiedFolder = copiedChildren.find((candidate) => candidate.resourceType === "notebook");
  assert.ok(copiedNote && copiedFolder);
  assert.notEqual(copiedNote.resourceId, note.resourceId);
  // 四篇文档（含空白、导图、画板）+ 一个子目录全部复制过来。
  assert.equal(copiedChildren.length, 5);

  const copiedMindmap = copiedChildren.find((candidate) => candidate.title === "结构导图");
  const copiedBoard = copiedChildren.find((candidate) => candidate.title === "流程画板");
  assert.ok(copiedMindmap && copiedBoard, "导图与画板应随目录复制");
  const readNote = (id: string) => db.prepare("SELECT content, contentFormat FROM notes WHERE id = ?")
    .get(id) as { content: string; contentFormat: string };
  const sourceMindmap = readNote(mindmapNote.resourceId);
  const copiedMindmapRow = readNote(copiedMindmap.resourceId);
  assert.equal(copiedMindmapRow.contentFormat, "mindmap");
  assert.equal(copiedMindmapRow.content, sourceMindmap.content);
  assert.equal(readNote(copiedBoard.resourceId).contentFormat, "board");
  assert.equal(readNote(blankNote.resourceId).content, readNote(
    (copiedChildren.find((candidate) => candidate.title === "空白")!).resourceId,
  ).content);

  const copiedContent = db.prepare("SELECT content FROM notes WHERE id = ?")
    .get(copiedNote.resourceId) as { content: string };
  assert.match(copiedContent.content, /原文正文/);

  const grandChildren = nodes.filter((candidate) => candidate.parentId === copiedFolder.id);
  assert.equal(grandChildren.length, 1);
  assert.equal(grandChildren[0].title, "评审记录");
  const copiedChildContent = db.prepare("SELECT content FROM notes WHERE id = ?")
    .get(grandChildren[0].resourceId) as { content: string };
  assert.match(copiedChildContent.content, /评审正文/);

  // 源目录保持原样，副本再次复制时编号递增。
  const source = nodes.find((candidate) => candidate.id === folder.id);
  assert.equal(source?.childCount, 5);
  const second = await duplicateKnowledgeNotebook({ actorUserId: "owner", nodeId: folder.id, db });
  assert.equal(second.title, "产品资料（副本 2）");
});

test("duplicating a document node is rejected", async () => {
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild, duplicateKnowledgeNotebook, KnowledgeTreeError } =
    await import("../src/services/knowledgeTree.js");
  const db = getDb();

  const folder = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "仅目录可复制",
    db,
  });
  const note = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: folder.id,
    nodeType: "note",
    title: "文档",
    db,
  });

  await assert.rejects(
    () => duplicateKnowledgeNotebook({ actorUserId: "owner", nodeId: note.id, db }),
    (error: unknown) => error instanceof KnowledgeTreeError && error.status === 404,
  );
});
