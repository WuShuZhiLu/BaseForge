import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-version-source-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.VERSION_SNAPSHOT_TIMER_DISABLED = "1";

let app: Hono;
let getDb: () => DatabaseSync;
let sharesRouter: typeof import("../src/routes/shares").sharesRouter;
let noteVersionsRepository: typeof import("../src/repositories/noteVersionsRepository").noteVersionsRepository;
let computeContentHash: typeof import("../src/repositories/noteVersionsRepository").computeContentHash;
let runVersionRetentionNow: typeof import("../src/services/version-snapshot").runVersionRetentionNow;
let writeVersionHistorySettings: typeof import("../src/services/version-history-settings").writeVersionHistorySettings;
let versionSourceMigration: typeof import("../src/db/versionSourceMigration").versionSourceMigration;

const USER_ID = "user-src";
const NOTEBOOK_ID = "nb-src";
const NOTE_ID = "note-src";
const NOTE2_ID = "note-src-2";

function db() {
  return getDb();
}

function seedBase() {
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NOTEBOOK_ID, USER_ID, "NB");
}

function seedNote(id: string, content: string) {
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, USER_ID, NOTEBOOK_ID, "Src Note", content, `text:${content}`, "tiptap-json", 1);
}

function updateNoteContent(id: string, content: string) {
  db().prepare(`UPDATE notes SET content = ?, "contentText" = ?, updatedAt = datetime('now') WHERE id = ?`)
    .run(content, `text:${content}`, id);
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
  const [sharesModule, schemaModule, versionsRepoModule, snapshotModule, settingsServiceModule, migrationModule] = await Promise.all([
    import("../src/routes/shares"),
    import("../src/db/schema"),
    import("../src/repositories/noteVersionsRepository"),
    import("../src/services/version-snapshot"),
    import("../src/services/version-history-settings"),
    import("../src/db/versionSourceMigration"),
  ]);
  getDb = schemaModule.getDb;
  sharesRouter = sharesModule.sharesRouter;
  noteVersionsRepository = versionsRepoModule.noteVersionsRepository;
  computeContentHash = versionsRepoModule.computeContentHash;
  runVersionRetentionNow = snapshotModule.runVersionRetentionNow;
  writeVersionHistorySettings = settingsServiceModule.writeVersionHistorySettings;
  versionSourceMigration = migrationModule.versionSourceMigration;
  app = new Hono();
  app.route("/shares", sharesRouter);
  seedBase();
});

test("迁移 134：存量行回填（kind=auto 保持 auto，其余回填 manual）", async () => {
  const mem = new DatabaseSync(":memory:");
  mem.exec(`
    CREATE TABLE note_versions (
      id TEXT PRIMARY KEY,
      "noteId" TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'auto'
    );
  `);
  mem.prepare(`INSERT INTO note_versions (id, "noteId", kind) VALUES ('a1', 'n1', 'auto')`).run();
  mem.prepare(`INSERT INTO note_versions (id, "noteId", kind) VALUES ('m1', 'n1', 'manual')`).run();

  versionSourceMigration.up(mem);

  const rows = mem.prepare("SELECT id, source FROM note_versions ORDER BY id").all() as Array<{ id: string; source: string }>;
  assert.deepEqual(rows, [
    { id: "a1", source: "auto" },
    { id: "m1", source: "manual" },
  ]);
  mem.close();
});

test("Ctrl+S 保存：内容变化落 manual 记录，内容不变不落（幂等）", async () => {
  resetData();
  seedNote(NOTE_ID, '{"v":1}');

  // 无任何版本记录时：首保存落一条 manual
  const first = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/save`);
  assert.equal(first.status, 200);
  assert.equal(first.json.created, true);
  assert.equal(first.json.version.source, "manual");
  assert.equal(first.json.version.kind, "manual");
  assert.match(first.json.version.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(first.json.version.title, "Src Note");
  assert.ok((first.json.version.content ?? "").length > 0);

  // 内容无变化（重复提交 / 打开 / 切换焦点）→ 不落记录
  const repeat = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/save`);
  assert.equal(repeat.json.created, false);
  assert.equal(repeat.json.version, null);
  assert.equal(noteVersionsRepository.countByNoteId(NOTE_ID), 1);

  // 内容变化 → 再落一条 manual，内容快照为最新内容
  updateNoteContent(NOTE_ID, '{"v":2}');
  const second = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/save`);
  assert.equal(second.json.created, true);
  assert.equal(second.json.version.source, "manual");
  assert.equal(second.json.version.content, '{"v":2}');
  assert.equal(noteVersionsRepository.countByNoteId(NOTE_ID), 2);
});

test("定时快照：source=auto，同内容重复提交只留一条", async () => {
  resetData();
  seedNote(NOTE_ID, "{}");
  // 首条版本由保存路径产生
  await requestJson("POST", `/shares/note/${NOTE_ID}/versions/save`);

  updateNoteContent(NOTE_ID, '{"t":1}');
  const snap1 = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/snapshot`, { source: "auto" });
  assert.equal(snap1.json.created, true);
  assert.equal(snap1.json.version.source, "auto");

  // 同内容重复提交：幂等不落
  const snap2 = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/snapshot`, { source: "auto" });
  assert.equal(snap2.json.created, false);
  const autos = db().prepare(`SELECT COUNT(*) AS c FROM note_versions WHERE "noteId" = ? AND source = 'auto'`).get(NOTE_ID) as any;
  assert.equal(autos.c, 1);

  // hash 相同的相邻重复（模拟并发/重试）由合并兜底：只保留较新一条
  noteVersionsRepository.createTypedVersion({
    noteId: NOTE_ID, userId: USER_ID, kind: "auto", source: "auto", changeType: "edit",
    snapshot: { title: "Src Note", content: '{"t":1}', contentText: "text:{\"t\":1}", contentFormat: "tiptap-json", version: 1 },
  });
  assert.equal((db().prepare(`SELECT COUNT(*) AS c FROM note_versions WHERE source = 'auto'`).get() as any).c, 2);
  const merged = noteVersionsRepository.mergeAdjacentSameContent(NOTE_ID);
  assert.equal(merged.merged, 1);
  assert.equal((db().prepare(`SELECT COUNT(*) AS c FROM note_versions WHERE source = 'auto'`).get() as any).c, 1);
});

test("发版与标记：POST /versions 产 release，标记/取消互转", async () => {
  resetData();
  seedNote(NOTE_ID, "{}");

  // 发版端点（用户「保存为版本」）→ source=release
  const release = await requestJson("POST", `/shares/note/${NOTE_ID}/versions`, { label: "v1.0" });
  assert.equal(release.status, 201);
  assert.equal(release.json.source, "release");
  // kind 与 source 同值下发
  assert.equal(release.json.kind, "release");

  // Ctrl+S 记录 → 标记为 release → 取消回落 manual
  updateNoteContent(NOTE_ID, '{"v":2}');
  const saved = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/save`);
  const savedId = saved.json.version.id as string;

  const marked = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/${savedId}/release`);
  assert.equal(marked.json.source, "release");

  const unmarked = await requestJson("DELETE", `/shares/note/${NOTE_ID}/versions/${savedId}/release`);
  assert.equal(unmarked.json.source, "manual");

  // 列表 source 筛选
  const onlyRelease = await requestJson("GET", `/shares/note/${NOTE_ID}/versions?source=release`);
  assert.equal(onlyRelease.json.total, 1);
  assert.equal(onlyRelease.json.versions[0].source, "release");
});

test("保留策略：release 永不清理，auto/manual 分别按条数策略生效", async () => {
  resetData();
  seedNote(NOTE_ID, "{}");
  // 3 条 auto、3 条 manual（其中 1 条标记为 release）；auto/manual 各自需要内容变化才落记录
  for (let i = 0; i < 3; i++) {
    updateNoteContent(NOTE_ID, `{"auto":${i}}`);
    await requestJson("POST", `/shares/note/${NOTE_ID}/versions/snapshot`, { source: "auto" });
    updateNoteContent(NOTE_ID, `{"manual":${i}}`);
    await requestJson("POST", `/shares/note/${NOTE_ID}/versions/save`);
  }
  const manuals = db().prepare(`SELECT id FROM note_versions WHERE source = 'manual' ORDER BY "createdAt", id`).all() as Array<{ id: string }>;
  noteVersionsRepository.setVersionSource(NOTE_ID, manuals[2].id, "release");
  // 内容再次变化后 Ctrl+S，补回第 3 条 manual（同内容重复保存是幂等不落的）
  updateNoteContent(NOTE_ID, '{"final":1}');
  const refill = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/save`);
  assert.equal(refill.json.created, true);

  writeVersionHistorySettings({
    retention: { mode: "count", count: 1 },
    manualRetention: { mode: "count", count: 1 },
  });
  const result = runVersionRetentionNow();
  assert.deepEqual(result.failed, []);

  const after = db().prepare(`SELECT source, COUNT(*) AS c FROM note_versions WHERE "noteId" = ? GROUP BY source`).all(NOTE_ID) as Array<{ source: string; c: number }>;
  const bySource = Object.fromEntries(after.map((r) => [r.source, r.c]));
  assert.equal(bySource.auto, 1);        // auto 条数策略生效
  assert.equal(bySource.manual, 1);      // manual 条数策略生效
  assert.equal(bySource.release, 1);     // release 永不清理
});

test("保留策略：按天数清理 auto/manual，release 超龄保留", async () => {
  resetData();
  seedNote(NOTE_ID, "{}");
  await requestJson("POST", `/shares/note/${NOTE_ID}/versions/save`);
  db().prepare(`UPDATE note_versions SET "createdAt" = datetime('now', '-30 days') WHERE "noteId" = ?`).run(NOTE_ID);
  noteVersionsRepository.setVersionSource(NOTE_ID,
    (db().prepare(`SELECT id FROM note_versions WHERE "noteId" = ? LIMIT 1`).get(NOTE_ID) as any).id,
    "release",
  );
  updateNoteContent(NOTE_ID, '{"old-auto":1}');
  await requestJson("POST", `/shares/note/${NOTE_ID}/versions/snapshot`, { source: "auto" });
  db().prepare(`UPDATE note_versions SET "createdAt" = datetime('now', '-30 days') WHERE source = 'auto'`).run();

  const result = noteVersionsRepository.pruneVersionsBySourceDays("manual", 7);
  assert.equal(result.deleted, 0); // manual 已被标记为 release，不参与清理

  const autoResult = noteVersionsRepository.pruneVersionsBySourceDays("auto", 7);
  assert.equal(autoResult.deleted, 1);

  // release 超龄仍在
  const releases = db().prepare(`SELECT COUNT(*) AS c FROM note_versions WHERE source = 'release'`).get() as any;
  assert.equal(releases.c, 1);
});

test("版本对比：行级差异结构正确", async () => {
  resetData();
  seedNote(NOTE_ID, "keep");
  await requestJson("POST", `/shares/note/${NOTE_ID}/versions/save`);
  const a = (db().prepare(`SELECT id FROM note_versions WHERE "noteId" = ? ORDER BY rowid ASC LIMIT 1`).get(NOTE_ID) as any).id;
  updateNoteContent(NOTE_ID, "keep\nadded");
  await requestJson("POST", `/shares/note/${NOTE_ID}/versions/save`);
  const b = (db().prepare(`SELECT id FROM note_versions WHERE "noteId" = ? ORDER BY rowid DESC LIMIT 1`).get(NOTE_ID) as any).id;

  const { status, json } = await requestJson("GET", `/shares/note/${NOTE_ID}/versions/diff?a=${a}&b=${b}`);
  assert.equal(status, 200);
  assert.equal(json.a.id, a);
  assert.equal(json.b.id, b);
  assert.equal(json.stats.unchanged, 1);
  assert.equal(json.stats.added, 1);
  assert.equal(json.stats.removed, 0);
  const addedRow = json.rows.find((r: any) => r.type === "add");
  assert.equal(addedRow.text, "added");
  assert.equal(addedRow.newLine, 2);
  assert.equal(addedRow.oldLine, null);
});

test("版本对比：跨笔记 400，版本不存在 404", async () => {
  resetData();
  seedNote(NOTE_ID, "a");
  seedNote(NOTE2_ID, "b");
  await requestJson("POST", `/shares/note/${NOTE_ID}/versions/save`);
  await requestJson("POST", `/shares/note/${NOTE2_ID}/versions/save`);
  const v1 = (db().prepare(`SELECT id FROM note_versions WHERE "noteId" = ? LIMIT 1`).get(NOTE_ID) as any).id;
  const v2 = (db().prepare(`SELECT id FROM note_versions WHERE "noteId" = ? LIMIT 1`).get(NOTE2_ID) as any).id;

  // 跨笔记对比 → 400
  const cross = await requestJson("GET", `/shares/note/${NOTE_ID}/versions/diff?a=${v1}&b=${v2}`);
  assert.equal(cross.status, 400);
  assert.equal(cross.json.code, "VERSION_NOTE_MISMATCH");
  assert.equal(cross.json.offender, "b");

  // 版本不存在 → 404
  const missing = await requestJson("GET", `/shares/note/${NOTE_ID}/versions/diff?a=${v1}&b=not-exists`);
  assert.equal(missing.status, 404);

  // 缺参 → 400
  const noParams = await requestJson("GET", `/shares/note/${NOTE_ID}/versions/diff`);
  assert.equal(noParams.status, 400);
});

test("diffLines：公共前后缀修剪与中段 LCS", async () => {
  const { diffLines } = await import("../src/services/version-diff");
  const rows = diffLines("a\nb\nc", "a\nx\nc");
  assert.deepEqual(rows.map((r) => `${r.type}:${r.text}`), ["equal:a", "remove:b", "add:x", "equal:c"]);
  // 完全一致 → 全 equal
  const same = diffLines("same\ntext", "same\ntext");
  assert.ok(same.every((r) => r.type === "equal"));
});
