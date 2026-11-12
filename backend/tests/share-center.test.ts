/**
 * 分享中心：五路收口 / 计数同源 / 批量处置 / 默认有效期
 * ---------------------------------------------------------------------------
 * 产品里有 5 条互不相通的分享通道，其中 3 条（file_shares、目录邀请链接、目录公开
 * 出版）此前没有任何管理界面——列不出来也就撤不掉。本测试按真实库结构把五路各造
 * 一条，验证收口后的状态归一、徽标与列表同源、批量处置（含撤销邀请链接必须连带
 * 移除经它加入的成员），以及新建分享的 7 天默认有效期。
 *
 * 挂载方式沿用 files-unreferenced-category-stack.test.ts：真 DB 夹具 + 直调服务，
 * 默认有效期那部分才走 HTTP（那是路由层的职责）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";

const U1 = "u-sc-owner";
const U2 = "u-sc-stranger";
const NB1 = "nb-sc-1";
const NB_INVITE = "nb-sc-invite";
const NB_PUB = "nb-sc-pub";
const NOTE_LIVE = "note-sc-live";
const NOTE_TRASHED = "note-sc-trashed";
const ATT_A = "att-sc-a";
const ATT_B = "att-sc-b";

/** 固定"现在"，让过期/即将过期的判定不依赖真实时钟。 */
const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

let getDb: () => DatabaseSync;
let closeDb: () => void;
let app: Hono;
let queryShareCenter: typeof import("../src/services/share-center").queryShareCenter;
let parseShareCenterQuery: typeof import("../src/services/share-center").parseShareCenterQuery;
let applyShareCenterBatchAction: typeof import("../src/services/share-center").applyShareCenterBatchAction;

function db() {
  return getDb();
}

function api(query = "") {
  return queryShareCenter(db(), U1, parseShareCenterQuery({ pageSize: "100", ...(query ? Object.fromEntries(new URLSearchParams(query)) : {}) }), NOW);
}

function findItem(channel: string, id: string) {
  const item = api().items.find((it) => it.channel === channel && it.id === id);
  assert.ok(item, `${channel}/${id} 应该出现在分享中心里`);
  return item;
}

function row(sql: string, ...params: unknown[]) {
  return db().prepare(sql).get(...params as any[]) as any;
}

test.before(async () => {
  const [shareCenterModule, centerRouteModule, sharesModule, attachmentSharesModule, schemaModule] = await Promise.all([
    import("../src/services/share-center"),
    import("../src/routes/share-center"),
    import("../src/routes/shares"),
    import("../src/routes/attachment-shares"),
    import("../src/db/schema"),
  ]);
  queryShareCenter = shareCenterModule.queryShareCenter;
  parseShareCenterQuery = shareCenterModule.parseShareCenterQuery;
  applyShareCenterBatchAction = shareCenterModule.applyShareCenterBatchAction;

  app = new Hono();
  app.route("/api/share-center", centerRouteModule.shareCenterRouter);
  app.route("/api/shares", sharesModule.sharesRouter);
  app.route("/api/attachment-shares", attachmentSharesModule.attachmentSharesRouter);

  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  for (const id of [U1, U2]) {
    db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(id, id);
  }
  db().prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NB1, U1, "笔记本");
  db().prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NB_INVITE, U1, "邀请目录");
  db().prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NB_PUB, U1, "公开目录");
  db().prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, ?, '{}')")
    .run(NOTE_LIVE, U1, NB1, "在分享的文章");
  db().prepare("INSERT INTO notes (id, userId, notebookId, title, content, isTrashed) VALUES (?, ?, ?, ?, '{}', 1)")
    .run(NOTE_TRASHED, U1, NB1, "回收站里的文章");
  for (const [id, name] of [[ATT_A, "报告.pdf"], [ATT_B, "照片.png"]] as const) {
    db().prepare(`INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
                  VALUES (?, ?, ?, ?, 'application/octet-stream', 1024, ?)`)
      .run(id, NOTE_LIVE, U1, name, `${id}.bin`);
  }

  // ---- note_share（shares）----
  const insertShare = (id: string, overrides: Record<string, unknown> = {}) => {
    db().prepare(`INSERT INTO shares (id, noteId, ownerId, shareToken, shareType, permission, password, expiresAt, maxViews, viewCount, isActive)
                  VALUES (?, ?, ?, ?, 'link', ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        overrides.noteId ?? NOTE_LIVE,
        U1,
        `t-${id}`,
        overrides.permission ?? "view",
        overrides.password ?? null,
        overrides.expiresAt ?? null,
        overrides.maxViews ?? null,
        overrides.viewCount ?? 0,
        overrides.isActive ?? 1,
      );
  };
  insertShare("sh-open");                       // 无密码 / 永久 / 没人看过
  insertShare("sh-orphan", { noteId: NOTE_TRASHED });
  insertShare("sh-expired", { expiresAt: "2026-10-01T00:00:00.000Z", viewCount: 7 });
  insertShare("sh-disabled", { isActive: 0 });
  insertShare("sh-soon", { expiresAt: new Date(NOW + 5 * DAY_MS).toISOString(), viewCount: 4 });

  // 只有笔记分享有访问会话表，lastSeenAt 从它取。
  db().prepare(`INSERT INTO share_view_sessions (shareId, sessionHash, createdAt, lastSeenAt)
                VALUES ('sh-expired', 'sess-1', datetime('now','-2 day'), ?)`)
    .run(new Date(NOW - DAY_MS).toISOString());

  // ---- attachment_share ----
  db().prepare(`INSERT INTO attachment_shares (id, attachmentId, ownerId, shareToken, password, expiresAt, maxViews, viewCount, isActive)
                VALUES ('as-1', ?, ?, 't-as-1', 'bcrypt-hash', NULL, NULL, 3, 1)`)
    .run(ATT_A, U1);

  // ---- file_share（运行时稳定直链，不计数）----
  const { ensureFileSharesTable } = await import("../src/services/file-shares");
  ensureFileSharesTable();
  db().prepare(`INSERT INTO file_shares (id, token, attachmentId, noteId, ownerId, isActive, expiresAt, allowDownload)
                VALUES ('fs-1', 't-fs-1', ?, ?, ?, 1, NULL, 0)`)
    .run(ATT_A, NOTE_LIVE, U1);

  // ---- notebook_invite（字段名与其它通道不同：enabled / maxUses / useCount）----
  db().prepare(`INSERT INTO notebook_share_links (id, notebookId, token, role, enabled, expiresAt, maxUses, useCount, createdBy)
                VALUES ('il-1', ?, 't-il-1', 'editor', 1, NULL, 2, 1, ?)`)
    .run(NB_INVITE, U1);
  // 经邀请链接加入的成员是真实授权，撤链接时必须一起清掉。
  db().prepare(`INSERT INTO notebook_members (id, notebookId, userId, role, status, source, sourceId)
                VALUES ('nm-1', ?, ?, 'editor', 'active', 'invite_link', 'il-1')`)
    .run(NB_INVITE, U2);

  // ---- notebook_publication ----
  const { ensureNotebookPublicationTables } = await import("../src/runtime/notebook-publication");
  ensureNotebookPublicationTables();
  db().prepare(`INSERT INTO notebook_publications (id, notebookId, ownerId, token, accessMode, permission, allowDownload, allowComment, allowEdit, allowReshare, isActive)
                VALUES ('pub-1', ?, ?, 't-pub-1', 'public', 'read', 1, 0, 0, 0, 1)`)
    .run(NB_PUB, U1);
});

test.after(() => {
  closeDb();
});

test("五条通道收进同一个列表，字段归一", () => {
  const channels = new Set(api().items.map((item) => item.channel));
  assert.deepEqual(
    channels,
    // 裸直链也是这个列表里的一类（原型「全部」里就含裸直链），否则「全部」会比子分类还小
    new Set(["note_share", "attachment_share", "file_share", "notebook_invite", "notebook_publication", "attachment_bare"]),
    "五路分享 + 附件裸直链必须都能列出来（file_shares / 邀请链接 / 公开出版此前完全没有 UI）",
  );

  const note = findItem("note_share", "sh-open");
  assert.equal(note.objectKind, "note");
  assert.equal(note.urlPath, "/share/t-sh-open");
  assert.equal(note.access, "link");
  assert.equal(note.hasPassword, false);
  assert.equal(note.objectPath, "个人空间 / 笔记本");

  const attach = findItem("attachment_share", "as-1");
  assert.equal(attach.objectKind, "file");
  assert.equal(attach.permission, "download");
  assert.equal(attach.access, "password");
  assert.equal(attach.hasPassword, true);
  assert.equal(attach.urlPath, "/fs/t-as-1");
  // 附件仍由笔记持有，面包屑要能回答"这个文件在哪"
  assert.equal(attach.objectPath, "个人空间 / 笔记本 / 在分享的文章");

  const file = findItem("file_share", "fs-1");
  assert.equal(file.viewCount, null, "file_shares 不计数，不能谎报成 0 次访问");
  assert.equal(file.permission, "preview", "allowDownload=0 只剩预览");
  assert.match(file.urlPath, /^\/api\/attachments\/att-sc-a\?share=/);

  const invite = findItem("notebook_invite", "il-1");
  assert.equal(invite.objectKind, "notebook");
  assert.equal(invite.access, "members");
  assert.equal(invite.permission, "member_editor");
  assert.equal(invite.maxViews, 2);
  assert.equal(invite.viewCount, 1, "useCount 归一为 viewCount");
  assert.equal(invite.urlPath, "/notebook-share/t-il-1");

  const pub = findItem("notebook_publication", "pub-1");
  assert.equal(pub.access, "public");
  assert.equal(pub.viewCount, null);
  assert.equal(pub.urlPath, "/public/t-pub-1");
  assert.deepEqual(pub.capabilities, { download: true, comment: false, edit: false, reshare: false });
});

test("原对象消失优先于一切状态", () => {
  // sh-orphan 的 isActive=1、无过期、无次数上限，按原始字段是 active。
  assert.equal(findItem("note_share", "sh-orphan").status, "orphan");
  assert.deepEqual(findItem("note_share", "sh-orphan").risks, ["orphan"]);
  // 失效链接不该同时出现在"无密码永久链"风险里——它要做的是清理，不是加密码。
  assert.equal(findItem("note_share", "sh-expired").risks.length, 0);
});

test("左栏徽标与筛选后的条数同源", () => {
  const all = api();
  assert.equal(all.counts.total, all.items.length);
  for (const group of ["active", "attention", "disabled"] as const) {
    assert.equal(api(`group=${group}`).total, all.counts.groups[group], `group=${group}`);
  }
  for (const risk of ["open_ended", "orphan", "unused"] as const) {
    assert.equal(api(`risk=${risk}`).total, all.counts.risks[risk], `risk=${risk}`);
  }
  for (const objectKind of ["note", "file", "notebook"] as const) {
    assert.equal(api(`objectKind=${objectKind}`).total, all.counts.objects[objectKind], `objectKind=${objectKind}`);
  }
  // 三组之和就是全部，不能漏类别也不能重复计数
  assert.equal(
    all.counts.groups.active + all.counts.groups.attention + all.counts.groups.disabled,
    all.counts.total,
  );
  assert.equal(all.counts.statuses.orphan, 1);
  assert.equal(all.counts.statuses.expired, 1);
  assert.equal(all.counts.statuses.disabled, 1);
});

test("风险与有效期筛选按语义命中", () => {
  // 无密码 + 永久 + 不限次 + 生效中，才算"敞开"（目录公开出版也算）
  assert.deepEqual(
    api("risk=open_ended").items.map((item) => item.id).sort(),
    ["fs-1", "pub-1", "sh-open"],
  );
  assert.deepEqual(api("risk=unused").items.map((item) => item.id), ["sh-open"]);
  // 即将过期只看还没过期的
  assert.deepEqual(api("expiresWithinDays=30").items.map((item) => item.id), ["sh-soon"]);
  assert.deepEqual(api("expiresWithinDays=3").items.map((item) => item.id), []);
});

test("不计数的通道排在按访问量排序的末尾", () => {
  const sorted = api("sort=viewCount&order=desc");
  // file_shares / 公开出版 / 裸直链都不计数：它们不能被当成 0 次，必须全部沉底
  const firstNull = sorted.items.findIndex((item) => item.viewCount === null);
  assert.ok(firstNull > 0, "至少有一个可计数的通道排在前面");
  assert.ok(
    sorted.items.slice(firstNull).every((item) => item.viewCount === null),
    "file_shares / 公开出版不计数，不能被当成 0 次",
  );
  assert.notEqual(sorted.items[firstNull - 1].viewCount, null);
});

test("lastSeenAt 来自访问会话表，没有记录的排最后", () => {
  assert.equal(findItem("note_share", "sh-expired").lastSeenAt, new Date(NOW - DAY_MS).toISOString());
  assert.equal(findItem("note_share", "sh-open").lastSeenAt, null);
  const top = api("sort=lastSeenAt&order=desc").items[0];
  assert.equal(top.id, "sh-expired");
});

test("附件裸直链单独提示（既不计入列表也无法撤销）", () => {
  const { bareAttachmentUrls } = api();
  // 两个附件都有 /api/attachments/:id 免登录直链，其中一个没有任何分享记录。
  assert.equal(bareAttachmentUrls.count, 2);
  assert.equal(bareAttachmentUrls.revocable, false);
});

test("批量处置只认属主，越权条目计入 failed", () => {
  const foreign = applyShareCenterBatchAction(db(), U2, "disable", [{ channel: "note_share", id: "sh-open" }]);
  assert.deepEqual(foreign, { succeeded: 0, failed: 1 });
  assert.equal(findItem("note_share", "sh-open").status, "active");

  const ok = applyShareCenterBatchAction(db(), U1, "disable", [
    { channel: "note_share", id: "sh-open" },
    { channel: "attachment_share", id: "as-1" },
    { channel: "file_share", id: "fs-1" },
    { channel: "notebook_publication", id: "pub-1" },
  ]);
  assert.deepEqual(ok, { succeeded: 4, failed: 0 });
  assert.equal(findItem("note_share", "sh-open").status, "disabled");
  assert.equal(findItem("file_share", "fs-1").status, "disabled");

  const badChannel = applyShareCenterBatchAction(db(), U1, "delete", [{ channel: "ghost" as any, id: "x" }]);
  assert.deepEqual(badChannel, { succeeded: 0, failed: 1 });

  const deleted = applyShareCenterBatchAction(db(), U1, "delete", [{ channel: "attachment_share", id: "as-1" }]);
  assert.deepEqual(deleted, { succeeded: 1, failed: 0 });
  assert.equal(row("SELECT id FROM attachment_shares WHERE id = 'as-1'"), undefined);
});

test("批量设过期写回各行自己的 expiresAt", () => {
  const expiresAt = new Date(NOW + 3 * DAY_MS).toISOString();
  const result = applyShareCenterBatchAction(db(), U1, "expire", [
    { channel: "note_share", id: "sh-expired" },
    { channel: "file_share", id: "fs-1" },
    { channel: "notebook_invite", id: "il-1" },
  ], expiresAt);
  assert.deepEqual(result, { succeeded: 3, failed: 0 });
  assert.equal(row("SELECT expiresAt FROM shares WHERE id = 'sh-expired'").expiresAt, expiresAt);
  assert.equal(row("SELECT expiresAt FROM file_shares WHERE id = 'fs-1'").expiresAt, expiresAt);
  assert.equal(row("SELECT expiresAt FROM notebook_share_links WHERE id = 'il-1'").expiresAt, expiresAt);
  // expire 只是收窄有效期，链接仍然可用，经它加入的成员必须留下
  assert.equal(row("SELECT status FROM notebook_members WHERE id = 'nm-1'").status, "active");
});

test("撤销邀请链接连带移除经它加入的成员", () => {
  const result = applyShareCenterBatchAction(db(), U1, "disable", [{ channel: "notebook_invite", id: "il-1" }]);
  assert.deepEqual(result, { succeeded: 1, failed: 0 });
  assert.equal(row("SELECT enabled FROM notebook_share_links WHERE id = 'il-1'").enabled, 0);
  assert.equal(
    row("SELECT status FROM notebook_members WHERE id = 'nm-1'").status,
    "removed",
    "否则链接撤了人还在，目录权限并未收回",
  );
  assert.equal(findItem("notebook_invite", "il-1").status, "disabled");

  const deleted = applyShareCenterBatchAction(db(), U1, "delete", [{ channel: "notebook_invite", id: "il-1" }]);
  assert.deepEqual(deleted, { succeeded: 1, failed: 0 });
  assert.equal(row("SELECT id FROM notebook_share_links WHERE id = 'il-1'"), undefined);
});

test("GET /api/share-center 走通三层（路由 → 服务 → 库）", async () => {
  const res = await app.request("http://localhost/api/share-center?pageSize=100", {
    headers: { "X-User-Id": U1 },
  });
  assert.equal(res.status, 200);
  const payload = await res.json() as any;
  assert.ok(payload.counts.total > 0);
  assert.equal(payload.page, 1);
  assert.ok(Array.isArray(payload.items));
});

test("新建分享的默认有效期是 7 天，显式 null 才是永久", async () => {
  const { ensureStableFileShare } = await import("../src/services/file-shares");
  const { SHARE_DEFAULT_EXPIRY_DAYS } = await import("../src/lib/share-defaults");
  const before = Date.now();

  const post = async (path: string, body: unknown, userId = U1) => {
    const res = await app.request(`http://localhost${path}`, {
      method: "POST",
      headers: { "X-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as any };
  };

  // 笔记分享：留空 → 7 天
  const created = await post("/api/shares", { noteId: NOTE_LIVE, permission: "view" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const noteShare = row("SELECT expiresAt FROM shares WHERE id = ?", created.json.id);
  assert.ok(noteShare, "分享应已落库");
  const days = (Date.parse(noteShare.expiresAt) - before) / DAY_MS;
  assert.ok(Math.abs(days - SHARE_DEFAULT_EXPIRY_DAYS) < 0.1, `默认应为 ${SHARE_DEFAULT_EXPIRY_DAYS} 天，实际 ${days.toFixed(2)}`);

  // 笔记分享：显式永久
  const forever = await post("/api/shares", { noteId: NOTE_LIVE, permission: "view", expiresAt: null });
  assert.equal(forever.status, 201, JSON.stringify(forever.json));
  assert.equal(row("SELECT expiresAt FROM shares WHERE id = ?", forever.json.id).expiresAt, null);

  // 附件分享：文件管理"批量生成公开链接"传的就是空对象
  const attachRes = await post("/api/attachment-shares", { attachmentId: ATT_B });
  assert.equal(attachRes.status, 201);
  const attachDays = (Date.parse(attachRes.json.expiresAt) - before) / DAY_MS;
  assert.ok(Math.abs(attachDays - SHARE_DEFAULT_EXPIRY_DAYS) < 0.1, `附件分享默认应为 7 天，实际 ${attachDays.toFixed(2)}`);

  // 稳定文件直链：复制附件 URL 到剪贴板会静默走到这里
  const fileShare = ensureStableFileShare(ATT_B, U1, {});
  const fileDays = (Date.parse(fileShare.expiresAt!) - before) / DAY_MS;
  assert.ok(fileShare.expiresAt, "留空不该再落成永久外链");
  assert.ok(Math.abs(fileDays - SHARE_DEFAULT_EXPIRY_DAYS) < 0.1);
  assert.equal(ensureStableFileShare(ATT_B, U1, { expiresAt: null }).expiresAt, null);
});

test("附件裸直链是一个可点的分类，计数与列表同源", () => {
  const all = api();
  const bare = api("risk=bare");
  assert.equal(bare.total, all.counts.risks.bare, "徽标数必须等于点进去的条数");
  assert.ok(bare.items.length > 0);
  assert.ok(bare.items.every((item) => item.channel === "attachment_bare"));
  assert.ok(bare.items.every((item) => item.urlPath.startsWith("/api/attachments/") && !item.urlPath.includes("share=")));
  assert.ok(bare.items.every((item) => item.risks.includes("bare")));
  // 裸直链也在这个列表里（否则「全部」会比它的子分类还小），徽标与行数一致
  assert.equal(all.items.filter((item) => item.channel === "attachment_bare").length, all.counts.risks.bare);
});

test("徽标跟着筛选变：列表空了徽标就不能再有数字", () => {
  // 搜索一个不存在的词，列表与所有徽标必须同时归零
  const empty = api("q=zzz-not-exist");
  assert.equal(empty.total, 0);
  assert.equal(empty.counts.total, 0);
  assert.deepEqual(empty.counts.groups, { active: 0, attention: 0, disabled: 0 });
  assert.deepEqual(empty.counts.objects, { note: 0, file: 0, notebook: 0 });
  assert.deepEqual(empty.counts.risks, { open_ended: 0, orphan: 0, unused: 0, bare: 0 });

  // 选中对象维度时，其它徽标只在剩下这个约束内统计：
  // 每一行徽标 = 点它之后看到的条数。
  const notebook = api("objectKind=notebook");
  assert.equal(notebook.total, notebook.counts.objects.notebook, "对象徽标 = 点它看到的条数");
  assert.equal(api().total, notebook.counts.total, "「全部」徽标 = 不做分类筛选时的条数");
  for (const group of ["active", "attention", "disabled"] as const) {
    assert.equal(api(`objectKind=notebook&group=${group}`).total, notebook.counts.groups[group]);
  }
});

test("按被分享对象定位单条（列表行内入口跳抽屉用）", async () => {
  const get = async (query: string) => {
    const res = await app.request(`http://localhost/api/share-center/item?${query}`, {
      headers: { "X-User-Id": U1 },
    });
    return { status: res.status, json: await res.json() as any };
  };

  // 上一组用例给 ATT_B 建过附件分享，按 objectId 应该能精确拿回来
  const found = await get(`channel=attachment_share&objectId=${ATT_B}`);
  assert.equal(found.status, 200);
  assert.equal(found.json.item?.channel, "attachment_share");
  assert.equal(found.json.item?.objectId, ATT_B);

  const missing = await get(`channel=attachment_share&objectId=nope`);
  assert.equal(missing.status, 200);
  assert.equal(missing.json.item, null, "找不到就回 null，不能让前端 500");

  const invalid = await get(`channel=attachment_share`);
  assert.equal(invalid.status, 400, "缺 objectId 是参数错误");
});

test("抽屉访问明细：会话列表 + 失败尝试次数", async () => {
  const { initAuditTables } = await import("../src/services/audit");
  initAuditTables();
  // 真实路由在密码错时写的就是这条审计，抽屉里的「失败尝试」直接数它
  db().prepare(`INSERT INTO audit_logs (id, userId, category, action, level, targetType, targetId)
                VALUES ('al-sc-1', '', 'share', 'credential_failure', 'warn', 'share', 'sh-expired')`).run();

  const res = await app.request("http://localhost/api/share-center/note_share/sh-expired/visits?limit=3", {
    headers: { "X-User-Id": U1 },
  });
  assert.equal(res.status, 200);
  const payload = await res.json() as any;
  assert.equal(payload.supported, true);
  assert.equal(payload.total, 1);
  assert.equal(payload.visits.length, 1);
  assert.equal(payload.visits[0].session, "sess-1");
  assert.equal(payload.failedAttempts, 1);

  // 非属主看不到别人的明细（也不泄露失败次数）
  const foreign = await app.request("http://localhost/api/share-center/note_share/sh-expired/visits", {
    headers: { "X-User-Id": U2 },
  });
  const foreignPayload = await foreign.json() as any;
  assert.equal(foreignPayload.total, 0);
  assert.equal(foreignPayload.visits.length, 0);
  assert.equal(foreignPayload.failedAttempts, 0);
});
