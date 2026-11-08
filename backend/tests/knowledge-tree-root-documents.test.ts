import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-root-documents-"));
process.env.DB_PATH = path.join(tempDir, "root-documents.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("knowledge tree creates rich-text and Markdown documents at root", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  await import("../src/runtime/knowledge-tree.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const {
    ROOT_DOCUMENT_NOTEBOOK_PREFIX,
    createKnowledgeChild,
    listKnowledgeTree,
    moveKnowledgeNode,
  } = await import("../src/services/knowledgeTree.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("owner", "owner", "hash");
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run("ws", "Team", "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("ws", "owner", "owner");

  const richText = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: null,
    nodeType: "note",
    title: "根级富文本文档",
    db,
  });
  const markdown = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: null,
    nodeType: "markdown",
    title: "根级 Markdown 文档",
    db,
  });

  assert.equal(richText.parentId, null);
  assert.equal(markdown.parentId, null);

  const richTextRow = db.prepare("SELECT notebookId, contentFormat FROM notes WHERE id = ?")
    .get(richText.resourceId) as { notebookId: string; contentFormat: string };
  const markdownRow = db.prepare("SELECT notebookId, contentFormat FROM notes WHERE id = ?")
    .get(markdown.resourceId) as { notebookId: string; contentFormat: string };

  assert.match(richTextRow.notebookId, new RegExp(`^${ROOT_DOCUMENT_NOTEBOOK_PREFIX}workspace:`));
  assert.equal(richTextRow.contentFormat, "tiptap-json");
  assert.equal(markdownRow.notebookId, richTextRow.notebookId);
  assert.equal(markdownRow.contentFormat, "markdown");

  const hiddenContainer = db.prepare("SELECT isDeleted FROM notebooks WHERE id = ?")
    .get(richTextRow.notebookId) as { isDeleted: number };
  assert.equal(hiddenContainer.isDeleted, 1);

  const initialTree = listKnowledgeTree({ userId: "owner", workspaceId: "ws", db });
  assert.equal(initialTree.find((node) => node.id === richText.id)?.parentId, null);
  assert.equal(initialTree.find((node) => node.id === markdown.id)?.parentId, null);
  assert.equal(
    initialTree.some((node) => node.resourceType === "notebook" && node.resourceId.startsWith(ROOT_DOCUMENT_NOTEBOOK_PREFIX)),
    false,
  );

  const folder = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: null,
    nodeType: "folder",
    title: "普通文件夹",
    db,
  });

  moveKnowledgeNode({
    actorUserId: "owner",
    nodeId: richText.id,
    parentId: folder.id,
    db,
  });
  assert.equal(
    (db.prepare("SELECT notebookId FROM notes WHERE id = ?").get(richText.resourceId) as { notebookId: string }).notebookId,
    folder.resourceId,
  );

  const movedBack = moveKnowledgeNode({
    actorUserId: "owner",
    nodeId: richText.id,
    parentId: null,
    db,
  });
  assert.equal(movedBack.parentId, null);
  assert.match(
    (db.prepare("SELECT notebookId FROM notes WHERE id = ?").get(richText.resourceId) as { notebookId: string }).notebookId,
    new RegExp(`^${ROOT_DOCUMENT_NOTEBOOK_PREFIX}workspace:`),
  );
  assert.equal(
    listKnowledgeTree({ userId: "owner", workspaceId: "ws", db })
      .find((node) => node.id === richText.id)?.parentId,
    null,
  );
});

test("restore normalization merges root documents into the fallback notebook", async () => {
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild, listKnowledgeTree } = await import("../src/services/knowledgeTree.js");
  const { mergeRootDocumentsIntoNotebook } = await import(
    "../src/services/knowledgeTreeRootDocumentNormalization.js"
  );

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("restore-owner", "restore-owner", "hash");
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run("restore-ws", "Restored", "restore-owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("restore-ws", "restore-owner", "owner");

  const doc = createKnowledgeChild({
    actorUserId: "restore-owner",
    workspaceId: "restore-ws",
    parentId: null,
    nodeType: "markdown",
    title: "根级待归并文档",
    db,
  });
  const second = createKnowledgeChild({
    actorUserId: "restore-owner",
    workspaceId: "restore-ws",
    parentId: null,
    nodeType: "note",
    title: "第二篇根级文档",
    db,
  });

  const result = mergeRootDocumentsIntoNotebook({ db });
  assert.ok(result.moved >= 2);
  assert.equal(result.notebookName, "待整理");

  const notebook = db.prepare(`
    SELECT id, parentId, icon FROM notebooks
     WHERE userId = ? AND workspaceId = ? AND name = '待整理'
  `).get("restore-owner", "restore-ws") as { id: string; parentId: string | null; icon: string };
  assert.ok(notebook);
  assert.equal(notebook.parentId, null);
  assert.equal(notebook.icon, "📥");

  for (const node of [doc, second]) {
    const note = db.prepare("SELECT notebookId FROM notes WHERE id = ?")
      .get(node.resourceId) as { notebookId: string };
    assert.equal(note.notebookId, notebook.id);
    assert.equal(
      listKnowledgeTree({ userId: "restore-owner", workspaceId: "restore-ws", db })
        .find((item) => item.id === node.id)?.parentId,
      `notebook:${notebook.id}`,
    );
  }

  // 幂等：已经没有根层文档时不再做任何移动。
  assert.equal(mergeRootDocumentsIntoNotebook({ db }).moved, 0);
});
