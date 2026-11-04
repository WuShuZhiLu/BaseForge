/**
 * /api/files 列表在「知识树可见性收口」层的参数口径
 * ---------------------------------------------------------------------------
 * GET /api/files 的响应并不是 routes/files.ts 直接给出的：
 *   routes/files.ts → knowledgeFilesCapabilityGuard（**整体重建**列表与分页）
 *                   → fileOrphanVisibility（孤儿即时视图 / 来源笔记修正）
 * 收口层只认它自己实现的 query 参数，历史上当时的新参数
 * （mimeCategory / shareStatus / filter=referenced / sort=referenced_desc / q 的
 * MIME 命中 / uploadedWithin）全部被静默丢弃——前端"参数发了但没生效"。
 * 本用例锁定这一层的口径，防止再加筛选维度时又只改路由。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const U1 = "u-guard-1";
const U2 = "u-guard-2";
const NB1 = "nb-guard-1";
const NOTE_HOST = "note-guard-host";
const NOTE_REF = "note-guard-ref";
const A_IMG = "att-guard-img";
const A_PDF = "att-guard-pdf";
const A_SHARED = "att-guard-shared";
const A_RECENT = "att-guard-recent";

let getDb: () => Database.Database;
let closeDb: () => void;

function db() {
  return getDb();
}

function insertAttachment(opt: {
  id: string;
  filename: string;
  mime: string;
  createdAt: string;
  withinGrace?: boolean;
}): void {
  db()
    .prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, createdAt, uploadSource)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'note_editor')`,
    )
    .run(
      opt.id,
      NOTE_HOST,
      U1,
      opt.filename,
      opt.mime,
      2048,
      `${opt.id}.bin`,
      opt.createdAt,
    );
}

async function listItems(query: string): Promise<Array<Record<string, any>>> {
  const res = await app.request(`/files?pageSize=100&${query}`, {
    headers: { "X-User-Id": U1 },
  });
  assert.equal(res.status, 200);
  return (await res.json()).items as Array<Record<string, any>>;
}

async function listIds(query: string): Promise<string[]> {
  return (await listItems(query)).map((it) => it.id);
}

let app: Hono;

test.before(async () => {
  const [filesModule, schemaModule, guardModule] = await Promise.all([
    import("../src/routes/files"),
    import("../src/db/schema"),
    import("../src/middleware/knowledgeFilesCapabilityGuard"),
  ]);
  // 与 runtime/knowledge-tree.ts 的挂载顺序一致：先收口层，再进路由。
  const inner = new Hono();
  inner.route("/files", filesModule.default);
  app = new Hono();
  app.use("*", guardModule.enforceKnowledgeFilesVisibility);
  app.route("/", inner);

  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(U1, U1, "hash");
  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(U2, U2, "hash");
  db().prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NB1, U1, "NB1");
  db()
    .prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, ?, ?)")
    .run(NOTE_HOST, U1, NB1, "文件管理（自动）", "");
  db()
    .prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, ?, ?)")
    .run(NOTE_REF, U1, NB1, "引用页", `![](/api/attachments/${A_IMG}) ![](/api/attachments/${A_RECENT})`);

  const select = (sql: string) =>
    (db().prepare(`SELECT ${sql} AS t`).get() as { t: string }).t;
  const t3d = select("datetime('now','-3 days')");
  const tNow = select("datetime('now')");
  const t2d = select("datetime('now','-2 days')");

  insertAttachment({ id: A_IMG, filename: "photo.png", mime: "image/png", createdAt: t3d });
  insertAttachment({ id: A_PDF, filename: "spec.bin", mime: "application/pdf", createdAt: t3d });
  insertAttachment({ id: A_SHARED, filename: "shared.png", mime: "image/png", createdAt: t2d });
  insertAttachment({ id: A_RECENT, filename: "recent.png", mime: "image/png", createdAt: tNow });

  db()
    .prepare(`INSERT INTO attachment_references ("attachmentId", "noteId", "createdAt")
              VALUES (?, ?, datetime('now','-1 day'))`)
    .run(A_IMG, NOTE_REF);
  db()
    .prepare(`INSERT INTO attachment_references ("attachmentId", "noteId", "createdAt")
              VALUES (?, ?, datetime('now','-2 hours'))`)
    .run(A_RECENT, NOTE_REF);

  db()
    .prepare(
      `INSERT INTO attachment_shares (id, "attachmentId", "ownerId", "shareToken", "isActive", "expiresAt")
       VALUES ('s-guard-1', ?, ?, 'tok-guard-1', 1, NULL)`,
    )
    .run(A_SHARED, U1);
});

test.after(() => {
  closeDb();
});

test("收口层认识 mimeCategory（不再退回全部附件）", async () => {
  assert.deepEqual(new Set(await listIds("mimeCategory=image")), new Set([A_IMG, A_SHARED, A_RECENT]));
  assert.deepEqual(await listIds("mimeCategory=doc"), [A_PDF]);
  assert.deepEqual(await listIds("mimeCategory=video"), []);
  // 与范围维度正交：可以叠加
  assert.deepEqual(await listIds("mimeCategory=image&shareStatus=shared"), [A_SHARED]);
});

test("收口层认识 shareStatus（过期/已关闭都不算已分享）", async () => {
  assert.deepEqual(await listIds("shareStatus=shared"), [A_SHARED]);
  assert.deepEqual(
    new Set(await listIds("shareStatus=unshared")),
    new Set([A_IMG, A_PDF, A_RECENT]),
  );
});

test("收口层认识 filter=referenced / unreferenced", async () => {
  assert.deepEqual(new Set(await listIds("filter=referenced")), new Set([A_IMG, A_RECENT]));
  // 与「文档引用」严格互补：没被正文引用的就都在这里（不看上传来源）
  assert.deepEqual(new Set(await listIds("filter=unreferenced")), new Set([A_PDF, A_SHARED]));
});

test("收口层按 referenced_desc 排序并下发 referenceCount", async () => {
  const items = await listItems("sort=referenced_desc");
  assert.equal(items[0].id, A_RECENT, "2 小时前的引用应排最前");
  assert.equal(items[1].id, A_IMG, "1 天前的引用次之");
  // 无引用组沉底，且组内有定序（createdAt DESC）——否则翻页会重复/漏项
  assert.deepEqual(items.slice(2).map((it) => it.id), [A_SHARED, A_PDF]);
  const countOf = new Map(items.map((it) => [it.id, it.referenceCount]));
  assert.equal(countOf.get(A_RECENT), 1);
  assert.equal(countOf.get(A_PDF), 0);
});

test("收口层的 q 同时命中文件名与 MIME，uploadedWithin 生效", async () => {
  assert.deepEqual(await listIds("q=pdf"), [A_PDF]);
  assert.deepEqual(new Set(await listIds("q=photo")), new Set([A_IMG]));
  // 最近 1 天：只有 A_RECENT（A_SHARED 是 2 天前）
  assert.deepEqual(await listIds("uploadedWithin=1"), [A_RECENT]);
});
