import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-versions-v2-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.VERSION_SNAPSHOT_TIMER_DISABLED = "1";

let app: Hono;
let getDb: () => Database.Database;
let sharesRouter: typeof import("../src/routes/shares").sharesRouter;
let noteVersionsRepository: typeof import("../src/repositories/noteVersionsRepository").noteVersionsRepository;
let computeContentHash: typeof import("../src/repositories/noteVersionsRepository").computeContentHash;
let runVersionSnapshotOnce: typeof import("../src/services/version-snapshot").runVersionSnapshotOnce;
let sweepVersionGcQueue: typeof import("../src/services/version-snapshot").sweepVersionGcQueue;

const USER_ID = "user-v2";
const ADMIN_ID = "admin-v2";
const NOTEBOOK_ID = "nb-v2";
const NOTE_ID = "note-v2";
const ATTACHMENT_ID = "11111111-1111-4111-8111-111111111111";

function db() {
  return getDb();
}

function seedBase() {
  // role 列 NOT NULL DEFAULT 'user'：不能显式传 NULL（会被 INSERT OR IGNORE 静默吞掉整行）
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash, role) VALUES (?, ?, ?, ?)").run(ADMIN_ID, "admin-v2", "hash", "admin");
  db().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NOTEBOOK_ID, USER_ID, "NB");
}

function seedNote(content: string) {
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(NOTE_ID, USER_ID, NOTEBOOK_ID, "V2 Note", content, "V2 Note", "tiptap-json", 1);
}

function seedAutoVersion() {
  const note = db().prepare("SELECT title, content, contentText, contentFormat, version FROM notes WHERE id = ?").get(NOTE_ID) as any;
  return noteVersionsRepository.createTypedVersion({
    noteId: NOTE_ID,
    userId: USER_ID,
    kind: "auto",
    changeType: "edit",
    snapshot: {
      title: note.title,
      content: note.content,
      contentText: note.contentText,
      contentFormat: note.contentFormat,
      version: note.version,
    },
  });
}

function resetData() {
  db().prepare("DELETE FROM version_attachment_refs").run();
  db().prepare("DELETE FROM note_versions").run();
  db().prepare("DELETE FROM notes").run();
  db().prepare("DELETE FROM notebooks").run();
  db().prepare("DELETE FROM system_settings").run();
  seedBase();
}

async function requestJson(method: string, url: string, body?: unknown, userId = USER_ID) {
  const res = await app.request(url, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

test.before(async () => {
  const [sharesModule, settingsModule, schemaModule, versionsRepoModule, snapshotModule] = await Promise.all([
    import("../src/routes/shares"),
    import("../src/routes/settings"),
    import("../src/db/schema"),
    import("../src/repositories/noteVersionsRepository"),
    import("../src/services/version-snapshot"),
  ]);
  getDb = schemaModule.getDb;
  sharesRouter = sharesModule.sharesRouter;
  noteVersionsRepository = versionsRepoModule.noteVersionsRepository;
  computeContentHash = versionsRepoModule.computeContentHash;
  runVersionSnapshotOnce = snapshotModule.runVersionSnapshotOnce;
  sweepVersionGcQueue = snapshotModule.sweepVersionGcQueue;
  app = new Hono();
  app.route("/shares", sharesRouter);
  app.route("/api/settings", settingsModule.default);
  seedBase();
});

test("手动版本：kind/label/description/contentHash 与版本附件引用同步写入", async () => {
  resetData();
  seedNote(`{"src":"/api/attachments/${ATTACHMENT_ID}"}`);

  const { status, json } = await requestJson("POST", `/shares/note/${NOTE_ID}/versions`, {
    label: "定稿 v1",
    description: "首次发版",
  });
  assert.equal(status, 201);
  assert.equal(json.kind, "manual");
  assert.equal(json.label, "定稿 v1");
  assert.equal(json.description, "首次发版");
  assert.match(json.contentHash, /^[0-9a-f]{16}$/);

  const refs = db().prepare('SELECT "attachmentId" FROM version_attachment_refs WHERE "versionId" = ?').all(json.id);
  assert.equal(refs.length, 1);
  assert.equal((refs[0] as any).attachmentId, ATTACHMENT_ID);

  // hash 与独立实现一致（内容含附件 URL 也要参与判定）
  const row = db().prepare('SELECT "contentHash", content FROM note_versions WHERE id = ?').get(json.id) as any;
  assert.equal(row.contentHash, computeContentHash({ title: "V2 Note", content: row.content, contentText: "V2 Note", contentFormat: "tiptap-json" }));
});

test("版本列表：kind 筛选与占用字节统计", async () => {
  resetData();
  seedNote("{}");
  seedAutoVersion();
  await requestJson("POST", `/shares/note/${NOTE_ID}/versions`, { label: "手动一" });

  const all = await requestJson("GET", `/shares/note/${NOTE_ID}/versions`);
  assert.equal(all.json.total, 2);
  assert.equal(typeof all.json.contentBytesTotal, "number");
  assert.ok(all.json.contentBytesTotal > 0);
  for (const v of all.json.versions) {
    assert.ok(v.kind === "auto" || v.kind === "manual");
    assert.equal(typeof v.contentBytes, "number");
  }

  const onlyManual = await requestJson("GET", `/shares/note/${NOTE_ID}/versions?kind=manual`);
  assert.equal(onlyManual.json.total, 1);
  assert.equal(onlyManual.json.versions[0].kind, "manual");
  assert.equal(onlyManual.json.versions[0].label, "手动一");
});

test("自动快照：hash 回填去重 + 间隔判断 + 内容变更触发", async () => {
  resetData();
  seedNote("{}");
  seedAutoVersion();

  // 最新版本 createdAt 拨回 2 小时前（满足间隔），contentHash 置 NULL 触发惰性回填
  db().prepare(`UPDATE note_versions SET "createdAt" = datetime('now', '-2 hours'), "contentHash" = NULL WHERE "noteId" = ?`).run(NOTE_ID);
  db().prepare(`UPDATE notes SET updatedAt = datetime('now') WHERE id = ?`).run(NOTE_ID);

  // 当前内容与版本内容一致：回填 hash 后去重命中，不新建
  const first = await runVersionSnapshotOnce();
  assert.equal(first.backfilled, 1);
  assert.equal(first.created, 0);

  // 内容变更后：到点且 hash 变化 → 落一条 auto 版本
  db().prepare(`UPDATE notes SET content = '{"b":2}', "contentText" = 'changed', updatedAt = datetime('now') WHERE id = ?`).run(NOTE_ID);
  const second = await runVersionSnapshotOnce();
  assert.equal(second.created, 1);

  // 连续第二轮：距新建版本不足间隔且 hash 一致 → 不再创建
  const third = await runVersionSnapshotOnce();
  assert.equal(third.created, 0);
});

test("批量删除与清空：manual 版本豁免", async () => {
  resetData();
  seedNote("{}");
  seedAutoVersion(); // A1
  seedAutoVersion(); // A2
  await requestJson("POST", `/shares/note/${NOTE_ID}/versions`, { label: "保留我" });
  const manual = db().prepare(`SELECT id FROM note_versions WHERE kind = 'manual'`).get() as { id: string };
  const autos = db().prepare(`SELECT id FROM note_versions WHERE kind = 'auto' ORDER BY version`).all() as Array<{ id: string }>;

  const batch = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/batch-delete`, { ids: [autos[0].id, manual.id, "not-exists"] });
  assert.equal(batch.json.deleted, 1);
  assert.equal(batch.json.skipped, 2);
  assert.ok(db().prepare("SELECT id FROM note_versions WHERE id = ?").get(manual.id));

  // 清空：只清 auto（A2），manual 保留
  const clear = await requestJson("DELETE", `/shares/note/${NOTE_ID}/versions`);
  assert.equal(clear.json.deleted, 1);
  assert.equal(clear.json.skippedManual, 1);
  assert.equal(db().prepare(`SELECT COUNT(*) AS c FROM note_versions WHERE kind = 'manual'`).get().c, 1);
});

test("会话结束快照：内容未变幂等，变更后创建", async () => {
  resetData();
  seedNote("{}");
  seedAutoVersion();
  db().prepare(`UPDATE note_versions SET "createdAt" = datetime('now', '-3 hours') WHERE "noteId" = ?`).run(NOTE_ID);

  const unchanged = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/snapshot`);
  assert.equal(unchanged.json.created, false);

  db().prepare(`UPDATE notes SET content = '{"c":3}', "contentText" = 'changed-again', updatedAt = datetime('now') WHERE id = ?`).run(NOTE_ID);
  const changed = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/snapshot`);
  assert.equal(changed.json.created, true);
});

test("从版本创建副本：标题带副本后缀且附件引用同步", async () => {
  resetData();
  seedNote(`{"src":"/api/attachments/${ATTACHMENT_ID}"}`);
  // 真实上传必有 attachments 行：attachment_references.attachmentId 外键指向它
  db().prepare(
    "INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(ATTACHMENT_ID, NOTE_ID, USER_ID, "a.png", "image/png", 1024, `2026/10/${ATTACHMENT_ID}.png`);
  const created = seedAutoVersion();
  const version = db().prepare("SELECT * FROM note_versions WHERE id = ?").get(created.id) as any;

  const { status, json } = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/${created.id}/duplicate`);
  assert.equal(status, 201);
  assert.ok(json.title.endsWith("（副本）"));
  assert.equal(json.content, version.content);
  assert.equal(json.notebookId, NOTEBOOK_ID);

  const refs = db().prepare('SELECT "noteId" FROM attachment_references WHERE "attachmentId" = ?').all(ATTACHMENT_ID);
  assert.ok(refs.some((r: any) => r.noteId === json.id));
});

test("删除单个版本：协作者 403，所有者可删", async () => {
  resetData();
  seedNote("{}");
  const created = seedAutoVersion();

  // 协作者（无记录用户）删除 → 404（不存在或无权）
  const forbidden = await requestJson("DELETE", `/shares/note/${NOTE_ID}/versions/${created.id}`, undefined, "someone-else");
  assert.equal(forbidden.status, 404);

  // 所有者删除 → 成功
  const ok = await requestJson("DELETE", `/shares/note/${NOTE_ID}/versions/${created.id}`);
  assert.equal(ok.json.success, true);
  assert.equal(db().prepare("SELECT COUNT(*) AS c FROM note_versions").get().c, 0);
});

test("设置端点：GET 默认值，非管理员 PUT 403，管理员可写", async () => {
  resetData();

  const initial = await requestJson("GET", "/api/settings/version-history");
  assert.equal(initial.json.versionHistory.autoVersionIntervalMinutes, 30);
  assert.equal(initial.json.versionHistory.retention.mode, "forever");

  const forbiddenPut = await requestJson("PUT", "/api/settings/version-history", { retention: { mode: "count" } });
  assert.equal(forbiddenPut.status, 403);

  const okPut = await requestJson("PUT", "/api/settings/version-history", { retention: { mode: "count", count: 20 } }, ADMIN_ID);
  assert.equal(okPut.json.versionHistory.retention.mode, "count");
  assert.equal(okPut.json.versionHistory.retention.count, 20);

  const cleanup = await requestJson("POST", "/api/settings/version-history/cleanup", undefined, ADMIN_ID);
  assert.equal(cleanup.json.success, true);
  assert.equal(typeof cleanup.json.deleted, "number");
});

test("保留策略：按数量保留最近 N 条 auto，manual 永不参与", async () => {
  resetData();
  seedNote("{}");
  seedAutoVersion();
  seedAutoVersion();
  seedAutoVersion();
  await requestJson("POST", `/shares/note/${NOTE_ID}/versions`, { label: "永不清理" });

  const result = noteVersionsRepository.pruneAutoVersionsByCount(1);
  assert.equal(result.deleted, 2);
  const remaining = db().prepare(`SELECT kind FROM note_versions ORDER BY version`).all() as Array<{ kind: string }>;
  assert.equal(remaining.length, 2);
  assert.equal(remaining.filter((r) => r.kind === "manual").length, 1);
  assert.equal(remaining.filter((r) => r.kind === "auto").length, 1);
});

test("P2 附件 GC：删版本后失去引用的附件进入宽限队列，扫尾后物理删除", async () => {
  resetData();
  seedNote(`{"src":"/api/attachments/${ATTACHMENT_ID}"}`);

  // 造一个附件行（模拟上传产物）
  db().prepare(
    "INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(ATTACHMENT_ID, NOTE_ID, USER_ID, "a.png", "image/png", 2048, `2026/10/${ATTACHMENT_ID}.png`);

  const created = seedAutoVersion(); // 版本引用该附件 → version_attachment_refs 写入

  // 删除该版本：附件失去全部引用 → 入宽限队列
  const deleted = noteVersionsRepository.deleteVersionById(NOTE_ID, created.id);
  assert.ok(deleted.deleted);
  const queued = db().prepare(`SELECT path, bytes FROM version_gc_queue WHERE "attachmentId" = ?`).get(ATTACHMENT_ID) as any;
  assert.ok(queued);
  assert.equal(queued.bytes, 2048);

  // 宽限期内（freedAt 刚入队）扫尾 → 不删除
  const early = sweepVersionGcQueue(7);
  assert.equal(early.swept, 0);
  assert.ok(db().prepare("SELECT id FROM attachments WHERE id = ?").get(ATTACHMENT_ID));

  // 队列条目拨回 8 天前 → 扫尾删除 attachments 行并入审计计数
  db().prepare(`UPDATE version_gc_queue SET "freedAt" = datetime('now', '-8 days') WHERE "attachmentId" = ?`).run(ATTACHMENT_ID);
  const swept = sweepVersionGcQueue(7);
  assert.equal(swept.swept, 1);
  assert.equal(swept.freedBytes, 2048);
  assert.ok(!db().prepare("SELECT id FROM attachments WHERE id = ?").get(ATTACHMENT_ID));
  assert.ok(!db().prepare(`SELECT 1 FROM version_gc_queue WHERE "attachmentId" = ?`).get(ATTACHMENT_ID));
});

test("P2 存储配额：超配额时按最旧优先清理 auto，manual 不参与", async () => {
  resetData();
  seedNote("{}");
  // 三个 auto 版本，每个内容约 200 字节
  for (let i = 0; i < 3; i++) {
    const big = "x".repeat(200);
    noteVersionsRepository.createTypedVersion({
      noteId: NOTE_ID,
      userId: USER_ID,
      kind: "auto",
      changeType: "edit",
      snapshot: { title: "V2 Note", content: JSON.stringify({ i, big }), contentText: big, contentFormat: "tiptap-json", version: 1 },
    });
  }
  await requestJson("POST", `/shares/note/${NOTE_ID}/versions`, { label: "配额外保留" });

  // 配额仅容纳 1 条 auto（内容 200B + JSON 包装，取 400B）
  const result = noteVersionsRepository.pruneAutoVersionsOverQuota(400);
  assert.ok(result.deleted >= 1, `deleted=${result.deleted}`);
  const autos = db().prepare(`SELECT COUNT(*) AS c FROM note_versions WHERE kind = 'auto'`).get() as any;
  const manuals = db().prepare(`SELECT COUNT(*) AS c FROM note_versions WHERE kind = 'manual'`).get() as any;
  assert.equal(manuals.c, 1);
  assert.ok(autos.c >= 1 && autos.c <= 2, `autos=${autos.c}`);
});
