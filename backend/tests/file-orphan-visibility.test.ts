import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { Hono } from "hono";

import { getDb } from "../src/db/schema";
import {
  fileOrphanVisibilityMiddleware,
  getCurrentReferenceNotes,
  getProtectedManualUploadIds,
} from "../src/runtime/file-orphan-visibility";

type Fixture = {
  userId: string;
  notebookId: string;
  noteId: string;
  attachmentId: string;
};

function seedFixture(): Fixture {
  const db = getDb();
  const suffix = crypto.randomUUID();
  const fixture = {
    userId: `orphan-user-${suffix}`,
    notebookId: `orphan-nb-${suffix}`,
    noteId: `orphan-note-${suffix}`,
    attachmentId: `orphan-att-${suffix}`,
  };

  db.prepare(
    "INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)",
  ).run(fixture.userId, fixture.userId, "hash");
  db.prepare(
    "INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)",
  ).run(fixture.notebookId, fixture.userId, "孤儿测试");
  db.prepare(
    "INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, ?, ?)",
  ).run(fixture.noteId, fixture.userId, fixture.notebookId, "图片引用测试", "{}");
  db.prepare(
    `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fixture.attachmentId,
    fixture.noteId,
    fixture.userId,
    "image.png",
    "image/png",
    843 * 1024,
    `${fixture.attachmentId}.png`,
  );

  return fixture;
}

function cleanupFixture(fixture: Fixture): void {
  const db = getDb();
  db.prepare("DELETE FROM attachment_references WHERE attachmentId = ?").run(fixture.attachmentId);
  db.prepare("DELETE FROM attachments WHERE id = ?").run(fixture.attachmentId);
  db.prepare("DELETE FROM notes WHERE id = ?").run(fixture.noteId);
  db.prepare("DELETE FROM notebooks WHERE id = ?").run(fixture.notebookId);
  db.prepare("DELETE FROM users WHERE id = ?").run(fixture.userId);
}

test("current reference lookup follows attachment_references immediately on add and remove", () => {
  const db = getDb();
  const fixture = seedFixture();
  const scope = { kind: "personal" as const, workspaceId: null };

  try {
    // “来源笔记”必须跟着当前真实引用，而不是上传时的归属。
    assert.equal(
      getCurrentReferenceNotes(db, [fixture.attachmentId], scope, fixture.userId)
        .has(fixture.attachmentId),
      false,
    );

    db.prepare(
      "INSERT INTO attachment_references (attachmentId, noteId) VALUES (?, ?)",
    ).run(fixture.attachmentId, fixture.noteId);

    const referenced = getCurrentReferenceNotes(
      db,
      [fixture.attachmentId],
      scope,
      fixture.userId,
    );
    assert.equal(referenced.get(fixture.attachmentId)?.id, fixture.noteId);
    assert.equal(referenced.get(fixture.attachmentId)?.title, "图片引用测试");

    // 模拟编辑器删除图片并保存：syncReferences 会删除最后一条倒排引用。
    db.prepare(
      "DELETE FROM attachment_references WHERE attachmentId = ? AND noteId = ?",
    ).run(fixture.attachmentId, fixture.noteId);

    assert.equal(
      getCurrentReferenceNotes(db, [fixture.attachmentId], scope, fixture.userId)
        .has(fixture.attachmentId),
      false,
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("file manager responses expose current reference state instead of historical upload ownership", async () => {
  const db = getDb();
  const fixture = seedFixture();
  const app = new Hono();
  app.use("*", fileOrphanVisibilityMiddleware);
  app.get("/api/files", (c) => c.json({
    items: [{
      id: fixture.attachmentId,
      filename: "image.png",
      mimeType: "image/png",
      size: 843 * 1024,
      createdAt: new Date().toISOString(),
      category: "image",
      url: `/api/attachments/${fixture.attachmentId}`,
      hash: null,
      folderId: null,
      folderName: null,
      // 模拟旧 filesRouter：把 attachments.noteId 当成了来源笔记。
      primaryNote: {
        id: fixture.noteId,
        title: "图片引用测试",
        notebookId: fixture.notebookId,
        notebookName: "孤儿测试",
        notebookIcon: null,
        isTrashed: 0,
      },
    }],
    accessUrls: {},
    total: 1,
    page: 1,
    pageSize: 10,
  }));
  app.get("/api/files/stats", (c) => c.json({
    total: 1,
    totalBytes: 843 * 1024,
    images: { count: 1, bytes: 843 * 1024 },
    files: { count: 0, bytes: 0 },
    unreferenced: { count: 0, bytes: 0 },
  }));

  const headers = { "X-User-Id": fixture.userId };

  try {
    const allResponse = await app.request("http://localhost/api/files", { headers });
    assert.equal(allResponse.status, 200);
    const allPayload = await allResponse.json() as any;
    assert.equal(allPayload.items[0].primaryNote, null);
    assert.equal(allPayload.items[0].isAutoCleanupProtected, false);

    const unreferencedResponse = await app.request(
      "http://localhost/api/files?filter=unreferenced&page=1&pageSize=10",
      { headers },
    );
    assert.equal(unreferencedResponse.status, 200);
    const unreferencedPayload = await unreferencedResponse.json() as any;
    // 刚上传、还没插进笔记的文件也必须出现在「未引用」里（这一层不再重建该列表）。
    assert.equal(unreferencedPayload.total, 1);
    assert.equal(unreferencedPayload.items[0].id, fixture.attachmentId);
    assert.equal(unreferencedPayload.items[0].primaryNote, null);

    const statsResponse = await app.request("http://localhost/api/files/stats", { headers });
    assert.equal(statsResponse.status, 200);
    const statsPayload = await statsResponse.json() as any;
    // stats 透传：这一层不再用倒排表口径覆写 unreferenced 徽标。
    assert.deepEqual(statsPayload.unreferenced, { count: 0, bytes: 0 });

    db.prepare(
      "INSERT INTO attachment_references (attachmentId, noteId) VALUES (?, ?)",
    ).run(fixture.attachmentId, fixture.noteId);

    const referencedResponse = await app.request("http://localhost/api/files", { headers });
    const referencedPayload = await referencedResponse.json() as any;
    assert.equal(referencedPayload.items[0].primaryNote.id, fixture.noteId);
    assert.equal(referencedPayload.items[0].primaryNote.title, "图片引用测试");
  } finally {
    cleanupFixture(fixture);
  }
});

test("manual uploads stay in the unreferenced list but are marked auto-cleanup protected", async () => {
  const db = getDb();
  const fixture = seedFixture();
  const scope = { kind: "personal" as const, workspaceId: null };
  db.prepare(
    "UPDATE attachments SET uploadSource = 'file_manager' WHERE id = ?",
  ).run(fixture.attachmentId);

  const app = new Hono();
  app.use("*", fileOrphanVisibilityMiddleware);
  const basePayload = {
    id: fixture.attachmentId,
    filename: "image.png",
    mimeType: "image/png",
    size: 843 * 1024,
    createdAt: new Date().toISOString(),
    category: "image",
    url: `/api/attachments/${fixture.attachmentId}`,
    hash: null,
    folderId: null,
    folderName: null,
    primaryNote: null,
  };
  app.get("/api/files", (c) => c.json({
    items: [basePayload],
    accessUrls: {},
    total: 1,
    page: 1,
    pageSize: 10,
  }));
  app.get("/api/files/stats", (c) => c.json({
    total: 1,
    totalBytes: 843 * 1024,
    images: { count: 1, bytes: 843 * 1024 },
    files: { count: 0, bytes: 0 },
    unreferenced: { count: 1, bytes: 843 * 1024 },
  }));
  app.get(`/api/files/${fixture.attachmentId}`, (c) => c.json({
    ...basePayload,
    references: [],
  }));

  const headers = { "X-User-Id": fixture.userId };

  try {
    assert.equal(
      getProtectedManualUploadIds(db, [fixture.attachmentId], scope, fixture.userId)
        .has(fixture.attachmentId),
      true,
    );

    const allResponse = await app.request("http://localhost/api/files", { headers });
    const allPayload = await allResponse.json() as any;
    assert.equal(allPayload.items[0].isManualUpload, true);
    assert.equal(allPayload.items[0].isAutoCleanupProtected, true);

    const unreferencedResponse = await app.request(
      "http://localhost/api/files?filter=unreferenced&page=1&pageSize=10",
      { headers },
    );
    const unreferencedPayload = await unreferencedResponse.json() as any;
    // 从文件管理手动上传的文件是「未引用」最典型的人群：列出但带盾牌。
    assert.equal(unreferencedPayload.total, 1);
    assert.equal(unreferencedPayload.items[0].id, fixture.attachmentId);
    assert.equal(unreferencedPayload.items[0].isAutoCleanupProtected, true);

    const statsResponse = await app.request("http://localhost/api/files/stats", { headers });
    const statsPayload = await statsResponse.json() as any;
    assert.deepEqual(statsPayload.unreferenced, { count: 1, bytes: 843 * 1024 });

    const detailResponse = await app.request(
      `http://localhost/api/files/${fixture.attachmentId}`,
      { headers },
    );
    const detailPayload = await detailResponse.json() as any;
    assert.equal(detailPayload.isManualUpload, true);
    assert.equal(detailPayload.isAutoCleanupProtected, true);
  } finally {
    cleanupFixture(fixture);
  }
});
