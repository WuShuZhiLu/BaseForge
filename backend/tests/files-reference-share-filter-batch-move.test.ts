/**
 * 文件列表「文档引用 / 已分享」筛选 + 「最近引用」排序 + 批量归档
 * ---------------------------------------------------------------------------
 * 覆盖第三阶段（统一文件池 · 体验优化）的后端契约：
 *   1. filter=referenced 与 filter=unreferenced 来自同一次内容扫描，严格互补
 *      （刚上传还没插进笔记的文件进「未引用」，24h 宽限只属于 cleanup-orphans）；
 *   2. 列表项带 referenceCount（attachment_references 倒排表计数）；
 *   3. sort=referenced_desc：最近被引用的排前，从未被引用的沉底；
 *   4. shareStatus=shared / unshared：只算生效中且未过期的分享链接；
 *   5. q 关键字同时命中文件名与 MIME 类型；
 *   6. /stats 的 referenced / shared 徽标与列表口径一致；
 *   7. POST /api/files/batch-move：归档 / 移出文件夹 + 权限与异常分支。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";

const U1 = "u-filters-1";
const U2 = "u-filters-2";
const NB1 = "nb-filters-1";
const NB2 = "nb-filters-2";
const NOTE_HOST = "note-host-1";
const NOTE_REF = "note-ref-1";
const A_OLDREF = "att-oldref";
const A_FRESH = "att-fresh";
const A_ORPHAN = "att-orphan";
const A_GRACE = "att-grace";
const A_DOC = "att-doc";
const A_VIDEO = "att-video";
const FOLDER1 = "folder-1";
const FOLDER2_OTHER_USER = "folder-2-other";

let app: Hono;
let getDb: () => DatabaseSync;
let closeDb: () => void;

function db() {
  return getDb();
}

function insertAttachment(opt: {
  id: string;
  filename: string;
  mime: string;
  createdAt: string;
  folderId?: string | null;
}): void {
  db()
    .prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, createdAt, folderId, uploadSource)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'file_manager')`,
    )
    .run(
      opt.id,
      NOTE_HOST,
      U1,
      opt.filename,
      opt.mime,
      1024,
      `${opt.id}.bin`,
      opt.createdAt,
      opt.folderId ?? null,
    );
}

async function listIds(query: string): Promise<string[]> {
  const res = await app.request(`/files?pageSize=100&${query}`, {
    headers: { "X-User-Id": U1 },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ id: string }> };
  return body.items.map((it) => it.id);
}

async function listItems(query: string): Promise<Array<Record<string, unknown>>> {
  const res = await app.request(`/files?pageSize=100&${query}`, {
    headers: { "X-User-Id": U1 },
  });
  assert.equal(res.status, 200);
  return (await res.json()).items as Array<Record<string, unknown>>;
}

test.before(async () => {
  const [filesModule, schemaModule] = await Promise.all([
    import("../src/routes/files"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/files", filesModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(U1, U1, "hash");
  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(U2, U2, "hash");
  db().prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NB1, U1, "NB1");
  db().prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NB2, U2, "NB2");
  db()
    .prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, ?, ?)")
    .run(NOTE_HOST, U1, NB1, "文件管理（自动）", "");
  // 引用正文：老附件 + 宽限期内的新附件
  db()
    .prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, ?, ?)")
    .run(NOTE_REF, U1, NB1, "引用页", `![](/api/attachments/${A_OLDREF}) ![](/api/attachments/${A_FRESH})`);

  // 3 天前 / 刚刚 两档 createdAt，用来验证浏览分类不看时间宽限
  const select = (sql: string) =>
    (db().prepare(`SELECT ${sql} AS t`).get() as { t: string }).t;
  const t3d = select("datetime('now','-3 days')");
  const tNow = select("datetime('now')");
  const t2d = select("datetime('now','-2 days')");

  insertAttachment({ id: A_OLDREF, filename: "oldref.png", mime: "image/png", createdAt: t3d });
  insertAttachment({ id: A_FRESH, filename: "fresh.png", mime: "image/png", createdAt: tNow });
  insertAttachment({ id: A_ORPHAN, filename: "orphan.png", mime: "image/png", createdAt: t3d });
  insertAttachment({ id: A_GRACE, filename: "grace.png", mime: "image/png", createdAt: tNow });
  insertAttachment({ id: A_DOC, filename: "readme.bin", mime: "application/pdf", createdAt: t3d });
  insertAttachment({ id: A_VIDEO, filename: "clip.mp4", mime: "video/mp4", createdAt: t2d });
  // 视频也塞进引用正文，让 mimeCategory + filter 可以叠加验证
  db()
    .prepare("UPDATE notes SET content = content || ? WHERE id = ?")
    .run(` [v](/api/attachments/${A_VIDEO})`, NOTE_REF);

  db()
    .prepare(`INSERT INTO attachment_references ("attachmentId", "noteId", "createdAt") VALUES (?, ?, datetime('now','-1 day'))`)
    .run(A_OLDREF, NOTE_REF);
  db()
    .prepare(`INSERT INTO attachment_references ("attachmentId", "noteId", "createdAt") VALUES (?, ?, datetime('now','-2 hours'))`)
    .run(A_FRESH, NOTE_REF);
  db()
    .prepare(`INSERT INTO attachment_references ("attachmentId", "noteId", "createdAt") VALUES (?, ?, datetime('now','-5 hours'))`)
    .run(A_VIDEO, NOTE_REF);

  db()
    .prepare("INSERT INTO attachment_folders (id, userId, name) VALUES (?, ?, ?)")
    .run(FOLDER1, U1, "素材");
  db()
    .prepare("INSERT INTO attachment_folders (id, userId, name) VALUES (?, ?, ?)")
    .run(FOLDER2_OTHER_USER, U2, "别人的");

  // 分享状态：A_ORPHAN 生效中；A_OLDREF 已关闭；A_FRESH 已过期
  db()
    .prepare(
      `INSERT INTO attachment_shares (id, "attachmentId", "ownerId", "shareToken", "isActive", "expiresAt")
       VALUES ('s1', ?, ?, 'tok-1', 1, NULL)`,
    )
    .run(A_ORPHAN, U1);
  db()
    .prepare(
      `INSERT INTO attachment_shares (id, "attachmentId", "ownerId", "shareToken", "isActive")
       VALUES ('s2', ?, ?, 'tok-2', 0)`,
    )
    .run(A_OLDREF, U1);
  db()
    .prepare(
      `INSERT INTO attachment_shares (id, "attachmentId", "ownerId", "shareToken", "isActive", "expiresAt")
       VALUES ('s3', ?, ?, 'tok-3', 1, datetime('now','-1 hour'))`,
    )
    .run(A_FRESH, U1);
});

test.after(() => {
  closeDb();
});

test("filter=referenced 与 filter=unreferenced 严格互补（两个分类相加就是全部）", async () => {
  const referenced = await listIds("filter=referenced");
  const unreferenced = await listIds("filter=unreferenced");

  assert.deepEqual(new Set(referenced), new Set([A_OLDREF, A_FRESH, A_VIDEO]));
  assert.deepEqual(new Set(unreferenced), new Set([A_ORPHAN, A_GRACE, A_DOC]));
  // A_GRACE：刚上传、还没插进笔记——正是「未引用」要给用户看的那批。
  // 防误清不靠把文件藏起来，而是靠 cleanup-orphans 的 graceHours 与受保护标记。
  assert.ok(unreferenced.includes(A_GRACE));
  assert.equal(referenced.length + unreferenced.length, 6);
});

test("列表项带 referenceCount，未引用附件为 0", async () => {
  const items = await listItems("filter=referenced");
  const map = new Map(items.map((it) => [it.id, it.referenceCount]));
  assert.equal(map.get(A_OLDREF), 1);
  assert.equal(map.get(A_VIDEO), 1);

  const orphan = (await listItems("filter=unreferenced")).find((it) => it.id === A_DOC);
  assert.equal(orphan?.referenceCount, 0);
});

test("sort=referenced_desc 让最近引用的排前，从未引用的沉底", async () => {
  const ids = await listIds("sort=referenced_desc&pageSize=100");
  const pos = (id: string) => ids.indexOf(id);
  // A_FRESH(-2h) 比 A_OLDREF(-1d)、A_VIDEO(-5h) 都新
  assert.ok(pos(A_FRESH) < pos(A_VIDEO), "2 小时前的引用应排在 5 小时前之前");
  assert.ok(pos(A_VIDEO) < pos(A_OLDREF), "5 小时前的引用应排在 1 天前之前");
  // 从未引用过的附件（含刚上传的）必须排在所有有引用的附件之后
  assert.ok(pos(A_OLDREF) < pos(A_ORPHAN), "无引用的附件应沉底");
  assert.ok(pos(A_OLDREF) < pos(A_GRACE), "无引用的附件应沉底");
  // 沉底组内也要有定序（决胜位 a.createdAt DESC）：倒排表为空的老库里
  // 整组都是 NULL，没有决胜位则行序不确定，翻页会重复/漏项
  assert.ok(pos(A_GRACE) < pos(A_ORPHAN), "无引用组内按上传时间倒序");
  assert.deepEqual(ids, await listIds("sort=referenced_desc&pageSize=100"), "同样查询应稳定复现");
});

test("shareStatus 只认生效中且未过期的分享链接", async () => {
  assert.deepEqual(await listIds("shareStatus=shared"), [A_ORPHAN]);
  const unshared = await listIds("shareStatus=unshared");
  // 已关闭 / 已过期的分享都算「未分享」
  assert.ok(unshared.includes(A_OLDREF) && unshared.includes(A_FRESH));
  assert.ok(!unshared.includes(A_ORPHAN));
  assert.equal(unshared.length, 5);
});

test("q 关键字同时匹配文件名与 MIME 类型", async () => {
  assert.deepEqual(await listIds("q=pdf"), [A_DOC]);
  assert.deepEqual(await listIds("q=video%2F"), [A_VIDEO]);
  assert.deepEqual(await listIds("q=orphan"), [A_ORPHAN]);
});

test("mimeCategory 与 filter 正交叠加", async () => {
  assert.deepEqual(await listIds("mimeCategory=video&filter=referenced"), [A_VIDEO]);
  // 默认按上传时间倒序，这里只关心集合；用 Set 比较避开创建时间顺序
  assert.deepEqual(
    new Set(await listIds("mimeCategory=image&filter=referenced")),
    new Set([A_OLDREF, A_FRESH]),
  );
});

test("stats 的 referenced / shared 徽标与列表同口径", async () => {
  const res = await app.request("/files/stats", { headers: { "X-User-Id": U1 } });
  assert.equal(res.status, 200);
  const stats = (await res.json()) as {
    total: number;
    referenced: { count: number; bytes: number };
    unreferenced: { count: number };
    shared: { count: number; bytes: number };
    videos: { count: number };
  };
  assert.equal(stats.referenced.count, 3);
  assert.equal(stats.unreferenced.count, 3);
  assert.equal(stats.shared.count, 1);
  assert.equal(stats.videos.count, 1);
  // 分类型桶求和 = 总数（图片 5 + 视频 1 + PDF 归 other/doc）
  assert.equal(stats.total, 6);
});

test("batch-move 归档 / 移出 / 权限 / 异常分支", async () => {
  const move = async (body: unknown) => {
    const res = await app.request("/files/batch-move", {
      method: "POST",
      headers: { "X-User-Id": U1, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  // 1) 正常归档两个
  const ok = await move({ ids: [A_GRACE, A_DOC], folderId: FOLDER1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.moved, 2);
  assert.deepEqual(ok.body.failed, []);
  const folderOf = (id: string) =>
    (db().prepare("SELECT folderId FROM attachments WHERE id = ?").get(id) as { folderId: string | null }).folderId;
  assert.equal(folderOf(A_GRACE), FOLDER1);
  assert.equal(folderOf(A_DOC), FOLDER1);

  // 2) 重复移动同一批：已在目标文件夹 → 不再写，moved 0
  const again = await move({ ids: [A_GRACE, A_DOC], folderId: FOLDER1 });
  assert.equal(again.body.moved, 0);

  // 3) 移出文件夹（folderId=null）
  const unarchive = await move({ ids: [A_DOC], folderId: null });
  assert.equal(unarchive.body.moved, 1);
  assert.equal(folderOf(A_DOC), null);

  // 4) 别人的文件夹 → 404，且不产生任何写入
  const badFolder = await move({ ids: [A_ORPHAN], folderId: FOLDER2_OTHER_USER });
  assert.equal(badFolder.status, 404);
  assert.equal(folderOf(A_ORPHAN), null);

  // 5) 不存在的 id 进 failed[]，不阻塞同批其它 id
  const mixed = await move({ ids: [A_ORPHAN, "att-not-exists"], folderId: FOLDER1 });
  assert.equal(mixed.body.moved, 1);
  assert.deepEqual(mixed.body.failed, [{ id: "att-not-exists", reason: "文件不存在" }]);

  // 6) 空 ids / 非法 folderId
  assert.equal((await move({ ids: [] })).status, 400);
  assert.equal((await move({ ids: [A_VIDEO], folderId: 123 })).status, 400);
});
