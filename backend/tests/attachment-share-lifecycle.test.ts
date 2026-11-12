import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baseforge-attachment-share-lifecycle-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.ELECTRON_USER_DATA = dir;
process.env.ATTACHMENT_LEGACY_PUBLIC_URL = "false";

const OWNER_ID = "share-owner";
const NOTE_ID = "share-note";
const NOTEBOOK_ID = "share-notebook";
const ATTACHMENT_ID = "share-attachment";
const FILE_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

let publicApp: Hono;
let manageApp: Hono;
let getDb: () => import("node:sqlite").DatabaseSync;
let closeDb: () => void;

test.before(async () => {
  const [routes, schema] = await Promise.all([
    import("../src/routes/attachment-shares"),
    import("../src/db/schema"),
  ]);
  getDb = schema.getDb;
  closeDb = schema.closeDb;

  // 与 index.ts 相同的两段挂载：公开段在前（免 JWT），管理段在后（X-User-Id）
  publicApp = new Hono();
  publicApp.route("/api/attachment-shares", routes.attachmentSharePublicRouter);
  manageApp = new Hono();
  manageApp.route("/api/attachment-shares", routes.attachmentSharesRouter);

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(OWNER_ID, OWNER_ID);
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, 'NB')").run(NOTEBOOK_ID, OWNER_ID);
  db.prepare(
    "INSERT INTO notes (id, userId, notebookId, title, content, contentText) VALUES (?, ?, ?, 'T', '{}', 'T')",
  ).run(NOTE_ID, OWNER_ID, NOTEBOOK_ID);
  db.prepare(
    `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
     VALUES (?, ?, ?, 'demo.txt', 'text/plain', ?, 'att-share-demo.txt')`,
  ).run(ATTACHMENT_ID, NOTE_ID, OWNER_ID, FILE_BYTES.byteLength);

  const attachmentsDir = path.join(dir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(attachmentsDir, "att-share-demo.txt"), FILE_BYTES);
});

test("attachment share lifecycle: open -> anonymous download -> close/expired/maxViews/password", async () => {
  // 开启分享（无密码）
  const created = await manageApp.request("/api/attachment-shares", {
    method: "POST",
    headers: { "X-User-Id": OWNER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ attachmentId: ATTACHMENT_ID }),
  });
  assert.equal(created.status, 201);
  const share = await created.json() as { id: string; shareToken: string; isActive: boolean; hasPassword: boolean };
  assert.equal(share.isActive, true);
  assert.equal(share.hasPassword, false);

  // 重复 POST 复用同一行并保持激活
  const again = await manageApp.request("/api/attachment-shares", {
    method: "POST",
    headers: { "X-User-Id": OWNER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ attachmentId: ATTACHMENT_ID }),
  });
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { id: string }).id, share.id);

  // meta + 匿名下载
  const meta = await publicApp.request(`/api/attachment-shares/${share.shareToken}/meta`);
  assert.equal(meta.status, 200);
  assert.equal(((await meta.json()) as { needPassword: boolean }).needPassword, false);
  const download = await publicApp.request(`/api/attachment-shares/${share.shareToken}/content`);
  assert.equal(download.status, 200);
  assert.equal(new Uint8Array(await download.arrayBuffer())[0], FILE_BYTES[0]);
  assert.match(download.headers.get("Content-Type") || "", /^text\/plain/);

  // 关闭 -> 404（设置保留、可重开）
  const closed = await manageApp.request(`/api/attachment-shares/${share.id}`, {
    method: "PATCH",
    headers: { "X-User-Id": OWNER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(closed.status, 200);
  assert.equal(((await closed.json()) as { isActive: boolean }).isActive, false);
  assert.equal((await publicApp.request(`/api/attachment-shares/${share.shareToken}/meta`)).status, 404);
  assert.equal((await publicApp.request(`/api/attachment-shares/${share.shareToken}/content`)).status, 404);
  const db = getDb();
  const kept = db.prepare("SELECT expiresAt, password FROM attachment_shares WHERE id = ?").get(share.id) as any;
  assert.ok("expiresAt" in kept, "关闭后设置保留");

  // 重开
  await manageApp.request(`/api/attachment-shares/${share.id}`, {
    method: "PATCH",
    headers: { "X-User-Id": OWNER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ isActive: true }),
  });
  assert.equal((await publicApp.request(`/api/attachment-shares/${share.shareToken}/content`)).status, 200);

  // 过期 -> 404
  await manageApp.request(`/api/attachment-shares/${share.id}`, {
    method: "PATCH",
    headers: { "X-User-Id": OWNER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
  });
  assert.equal((await publicApp.request(`/api/attachment-shares/${share.shareToken}/content`)).status, 404);
  await manageApp.request(`/api/attachment-shares/${share.id}`, {
    method: "PATCH",
    headers: { "X-User-Id": OWNER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresAt: null }),
  });

  // maxViews 耗尽 -> 404
  await manageApp.request(`/api/attachment-shares/${share.id}`, {
    method: "PATCH",
    headers: { "X-User-Id": OWNER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ maxViews: 1, resetViews: true }),
  });
  assert.equal((await publicApp.request(`/api/attachment-shares/${share.shareToken}/content`)).status, 200);
  assert.equal((await publicApp.request(`/api/attachment-shares/${share.shareToken}/content`)).status, 404);
  await manageApp.request(`/api/attachment-shares/${share.id}`, {
    method: "PATCH",
    headers: { "X-User-Id": OWNER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ maxViews: null, resetViews: true }),
  });

  // 密码：错误 403，正确换取 token 后可下载
  await manageApp.request(`/api/attachment-shares/${share.id}`, {
    method: "PATCH",
    headers: { "X-User-Id": OWNER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "hunter2" }),
  });
  const metaLocked = await publicApp.request(`/api/attachment-shares/${share.shareToken}/meta`);
  assert.equal(((await metaLocked.json()) as { needPassword: boolean }).needPassword, true);

  const bad = await publicApp.request(`/api/attachment-shares/${share.shareToken}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(bad.status, 403);

  const noToken = await publicApp.request(`/api/attachment-shares/${share.shareToken}/content`);
  assert.equal(noToken.status, 401);

  const ok = await publicApp.request(`/api/attachment-shares/${share.shareToken}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "hunter2" }),
  });
  assert.equal(ok.status, 200);
  const { accessToken } = await ok.json() as { accessToken: string };
  const authed = await publicApp.request(`/api/attachment-shares/${share.shareToken}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(authed.status, 200);

  // 列表 + 彻底删除 -> 404
  const list = await manageApp.request("/api/attachment-shares", {
    headers: { "X-User-Id": OWNER_ID },
  });
  assert.equal(list.status, 200);
  const rows = await list.json() as Array<{ id: string; hasPassword: boolean }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasPassword, true);

  const removed = await manageApp.request(`/api/attachment-shares/${share.id}`, {
    method: "DELETE",
    headers: { "X-User-Id": OWNER_ID },
  });
  assert.equal(removed.status, 200);
  assert.equal((await publicApp.request(`/api/attachment-shares/${share.shareToken}/content`)).status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM attachment_shares").get().c, 0);
});

test.after(() => {
  closeDb?.();
  fs.rmSync(dir, { recursive: true, force: true });
});
