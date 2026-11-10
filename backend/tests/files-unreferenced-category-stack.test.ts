/**
 * 「未引用」分类走完整三层挂载后的行为
 * ---------------------------------------------------------------------------
 * GET /api/files 在生产里要穿三层：
 *   routes/files.ts
 *     → knowledgeFilesCapabilityGuard（**整体重建**列表与分页）
 *     → fileOrphanVisibility（来源笔记修正 + 受保护标记）
 *
 * 曾经的两处口径分叉都会让「未引用」看起来“不工作”：
 *   - 收口层不认参数 → 静默退回全部附件；
 *   - 孤儿层用「倒排表 NOT EXISTS 且 uploadSource<>file_manager」重建列表并覆写
 *     stats.unreferenced → 从文件管理上传的文件永远不进「未引用」（实测恒为空），
 *     而且与走内容扫描的「文档引用」不互补。
 * 只挂 router 的单测发现不了第二层，所以这里按 runtime/knowledge-tree.ts 的顺序
 * 把三层全部装上。
 *
 * 挂载顺序本身就是回归点：孤儿/来源笔记修正层必须在收口层**外层**，否则它给
 * 列表项加的 isManualUpload / isAutoCleanupProtected / primaryNote 会被收口层的
 * 重建响应吹掉（旧写法就是如此，绿色盾牌在真实应用里从未下发过）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";

const U1 = "u-unref-1";
const NB1 = "nb-unref-1";
const NOTE_HOST = "note-unref-host";
const NOTE_REF = "note-unref-ref";
const A_FRESH_1 = "att-unref-fresh1";
const A_FRESH_2 = "att-unref-fresh2";
const A_OLD = "att-unref-old";
const A_USED = "att-unref-used";

let getDb: () => DatabaseSync;
let closeDb: () => void;
let app: Hono;

function db() {
  return getDb();
}

/** 文件管理页手动上传的独立文件（uploadSource=file_manager）。 */
function insertManualUpload(opt: {
  id: string;
  filename: string;
  mime: string;
  createdAt: string;
}): void {
  db()
    .prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, createdAt, uploadSource)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'file_manager')`,
    )
    .run(opt.id, NOTE_HOST, U1, opt.filename, opt.mime, 1024, `${opt.id}.bin`, opt.createdAt);
}

async function listIds(query: string): Promise<string[]> {
  const res = await app.request(`http://localhost/api/files?pageSize=100&${query}`, {
    headers: { "X-User-Id": U1 },
  });
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { items: Array<Record<string, any>>; total: number };
  return payload.items.map((it) => it.id);
}

async function listItems(query: string): Promise<Array<Record<string, any>>> {
  const res = await app.request(`http://localhost/api/files?pageSize=100&${query}`, {
    headers: { "X-User-Id": U1 },
  });
  return (await res.json()).items as Array<Record<string, any>>;
}

test.before(async () => {
  const [filesModule, schemaModule, guardModule, orphanModule] = await Promise.all([
    import("../src/routes/files"),
    import("../src/db/schema"),
    import("../src/middleware/knowledgeFilesCapabilityGuard"),
    import("../src/runtime/file-orphan-visibility"),
  ]);

  app = new Hono();
  // 与 runtime/knowledge-tree.ts 一致：先注册的是外层。
  app.use("*", orphanModule.fileOrphanVisibilityMiddleware);
  app.use("*", guardModule.enforceKnowledgeFilesVisibility);
  app.route("/api/files", filesModule.default);

  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(U1, U1, "hash");
  db().prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NB1, U1, "NB1");
  db()
    .prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, ?, ?)")
    .run(NOTE_HOST, U1, NB1, "未归档文件", "");
  db()
    .prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, ?, ?)")
    .run(NOTE_REF, U1, NB1, "引用页", `![](/api/attachments/${A_USED})`);

  const select = (sql: string) =>
    (db().prepare(`SELECT ${sql} AS t`).get() as { t: string }).t;
  const tNow = select("datetime('now')");
  const t3d = select("datetime('now','-3 days')");

  // 两个刚上传、一个三天前上传，全都没被正文引用；A_USED 被正文引用。
  insertManualUpload({ id: A_FRESH_1, filename: "fresh1.png", mime: "image/png", createdAt: tNow });
  insertManualUpload({ id: A_FRESH_2, filename: "fresh2.png", mime: "image/png", createdAt: tNow });
  insertManualUpload({ id: A_OLD, filename: "old.png", mime: "image/png", createdAt: t3d });
  insertManualUpload({ id: A_USED, filename: "used.png", mime: "image/png", createdAt: t3d });

  // 真实保存路径（syncReferences）会同步写倒排表，“来源笔记”就是从它读的。
  db()
    .prepare(`INSERT INTO attachment_references ("attachmentId", "noteId", "createdAt")
              VALUES (?, ?, datetime('now','-1 day'))`)
    .run(A_USED, NOTE_REF);
});

test.after(() => {
  closeDb();
});

test("「未引用」列出文件管理手动上传的文件（不再恒为空）", async () => {
  const unreferenced = await listIds("filter=unreferenced");
  assert.deepEqual(
    new Set(unreferenced),
    new Set([A_FRESH_1, A_FRESH_2, A_OLD]),
    "手动上传且没被正文引用的文件必须出现在「未引用」",
  );
  // 保护靠标记（UI 盾牌），不是靠把文件从分类里藏掉。
  const items = await listItems("filter=unreferenced");
  assert.ok(items.every((it) => it.isManualUpload === true));
  assert.ok(items.every((it) => it.isAutoCleanupProtected === true));
  // 没被引用的文件不该把 holder 笔记当成“来源笔记”。
  assert.ok(items.every((it) => it.primaryNote === null));
});

test("被正文引用的手动上传显示真实引用笔记，不是 holder 笔记", async () => {
  const [item] = await listItems("filter=referenced");
  assert.equal(item.id, A_USED);
  assert.equal(item.primaryNote?.id, NOTE_REF);
  assert.equal(item.primaryNote?.title, "引用页");
});

test("「文档引用」与「未引用」严格互补，相加就是全部", async () => {
  const referenced = await listIds("filter=referenced");
  const unreferenced = await listIds("filter=unreferenced");
  assert.deepEqual(referenced, [A_USED]);
  assert.equal(
    referenced.length + unreferenced.length,
    (await listIds("")).length,
    "两个分类的并集必须等于「全部」",
  );
});

test("stats 徽标与列表同口径（不再被倒排表覆写）", async () => {
  const res = await app.request("http://localhost/api/files/stats", {
    headers: { "X-User-Id": U1 },
  });
  assert.equal(res.status, 200);
  const stats = (await res.json()) as {
    total: number;
    referenced: { count: number };
    unreferenced: { count: number };
  };
  assert.equal(stats.total, 4);
  assert.equal(stats.referenced.count, 1);
  assert.equal(stats.unreferenced.count, 3);
});
