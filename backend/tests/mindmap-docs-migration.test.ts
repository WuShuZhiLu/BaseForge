import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { mindmapDocsMigration } from "../src/db/mindmapDocsMigration";
import { getDb } from "../src/db/schema";

const USER_ID = "mm-owner";
const OTHER_ID = "mm-other";
const FOLDER_ID = "mm-folder-1";
const PSEUDO_NOTEBOOK_ID = `__nowen_mindmap_folder__:${FOLDER_ID}`;
const MAP_IN_FOLDER = "11111111-1111-4111-8111-111111111111";
const MAP_TRASHED = "22222222-2222-4222-8222-222222222222";
const MAP_LOOSE = "33333333-3333-4333-8333-333333333333";

const mapData = (root: string, child: string) =>
  JSON.stringify({ root: { id: "root", text: root, children: [{ id: "n1", text: child, children: [] }] } });

/** 在已跑完全量迁移（v131 触发器已卸载、表为空）的隔离库上，重建 v131 之前的库态。
 *  同一文件的多个测试共享隔离库，全部用幂等写入。 */
function seedPreV131State(db: ReturnType<typeof getDb>): void {
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, "mm-owner", "x");
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(OTHER_ID, "mm-other", "x");

  // 导图文件夹的伪 notebook（v105 的投影结果；notebooks 树节点由触发器自动建立）
  db.prepare(`
    INSERT OR IGNORE INTO notebooks (id, userId, workspaceId, parentId, name, icon)
    VALUES (?, ?, NULL, NULL, '脑图夹', '🧠')
  `).run(PSEUDO_NOTEBOOK_ID, USER_ID);

  const insertMap = db.prepare(
    "INSERT INTO mindmaps (id, userId, workspaceId, title, data, starred, folderId, createdAt, updatedAt) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)",
  );
  insertMap.run(MAP_IN_FOLDER, USER_ID, "星图计划", mapData("星图计划", "编排子任务"), 1, FOLDER_ID, "2026-10-01 10:00:00", "2026-10-02 11:00:00");
  insertMap.run(MAP_TRASHED, USER_ID, "废弃草稿", mapData("废弃草稿", "旧节点"), 0, FOLDER_ID, "2026-10-01 09:00:00", "2026-10-01 09:30:00");
  insertMap.run(MAP_LOOSE, USER_ID, "随手图", mapData("随手图", "自由节点"), 0, null, "2026-10-03 08:00:00", "2026-10-03 08:05:00");

  // 手工重建 v104 投影的 mindmap: 树节点（迁移此刻已在全量链中跑过、触发器已卸载）
  const insertNode = db.prepare(`
    INSERT OR IGNORE INTO knowledge_tree_nodes (
      id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
      resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    ) VALUES (?, ?, NULL, ?, ?, 'mindmap', 'mindmap', ?, ?, 1, ?, ?, ?, ?)
  `);
  insertNode.run(`mindmap:${MAP_IN_FOLDER}`, USER_ID, `personal:${USER_ID}`, `notebook:${PSEUDO_NOTEBOOK_ID}`, MAP_IN_FOLDER, 3, 0, null, "2026-10-01 10:00:00", "2026-10-02 11:00:00");
  insertNode.run(`mindmap:${MAP_TRASHED}`, USER_ID, `personal:${USER_ID}`, null, MAP_TRASHED, 0, 1, "2026-10-05 00:00:00", "2026-10-01 09:00:00", "2026-10-05 00:00:00");
  insertNode.run(`mindmap:${MAP_LOOSE}`, USER_ID, `personal:${USER_ID}`, null, MAP_LOOSE, 0, 0, null, "2026-10-03 08:00:00", "2026-10-03 08:05:00");
}

test("mindmap-docs migration moves maps into notes and preserves identity/position/trash", () => {
  const db = getDb();
  seedPreV131State(db);

  mindmapDocsMigration.up(db);

  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(MAP_IN_FOLDER) as {
    id: string; contentFormat: string; content: string; contentText: string;
    notebookId: string; isFavorite: number; isTrashed: number; title: string;
  };
  assert.ok(note, "migrated mindmap doc should exist as a note");
  assert.equal(note.contentFormat, "mindmap");
  assert.equal(note.isFavorite, 1);
  assert.equal(note.isTrashed, 0);
  assert.equal(note.title, "星图计划");
  assert.equal(note.notebookId, PSEUDO_NOTEBOOK_ID);
  assert.match(note.content, /编排子任务/);
  assert.equal(note.contentText, "星图计划 编排子任务");

  // 树节点重建为 note:<id>，位置对齐旧导图节点；mindmap: 节点清空
  const node = db.prepare("SELECT id, parentId, sortOrder, isDeleted, nodeType, resourceType FROM knowledge_tree_nodes WHERE resourceId = ? AND resourceType = 'note'").get(MAP_IN_FOLDER) as {
    id: string; parentId: string; sortOrder: number; isDeleted: number; nodeType: string; resourceType: string;
  };
  assert.equal(node.id, `note:${MAP_IN_FOLDER}`);
  assert.equal(node.parentId, `notebook:${PSEUDO_NOTEBOOK_ID}`);
  assert.equal(node.sortOrder, 3);
  assert.equal(node.isDeleted, 0);
  assert.equal(node.nodeType, "note");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM knowledge_tree_nodes WHERE resourceType = 'mindmap'").get() as { c: number }).c,
    0,
  );

  // 回收站导图：isTrashed=1 + trashedAt 沿用节点 deletedAt，树节点保持墓碑
  const trashedNote = db.prepare("SELECT isTrashed, trashedAt FROM notes WHERE id = ?").get(MAP_TRASHED) as { isTrashed: number; trashedAt: string };
  assert.equal(trashedNote.isTrashed, 1);
  assert.equal(trashedNote.trashedAt, "2026-10-05 00:00:00");
  const trashedNode = db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE id = ?").get(`note:${MAP_TRASHED}`) as { isDeleted: number };
  assert.equal(trashedNode.isDeleted, 1);

  // 无文件夹导图挂靠兜底笔记本（名称"思维导图"）
  const looseNote = db.prepare("SELECT notebookId FROM notes WHERE id = ?").get(MAP_LOOSE) as { notebookId: string };
  const fallback = db.prepare("SELECT id FROM notebooks WHERE name = '思维导图'").get() as { id: string };
  assert.ok(fallback);
  assert.equal(looseNote.notebookId, fallback.id);

  // 旧表清空、导图树投影触发器卸载（v105 的 folder 触发器保留，精确匹配三个名字）
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM mindmaps").get() as { c: number }).c,
    0,
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger'
        AND name IN ('knowledge_tree_mindmaps_ai', 'knowledge_tree_mindmaps_au', 'knowledge_tree_mindmaps_ad')
    `).get() as { c: number }).c,
    0,
  );
});

test("mindmap facade routes read and write the migrated note docs", async () => {
  const db = getDb();
  seedPreV131State(db);
  mindmapDocsMigration.up(db);

  const { default: mindmapsRouter } = await import("../src/routes/mindmaps");
  const app = new Hono();
  app.route("/api/mindmaps", mindmapsRouter);

  // 列表：映射 starred，回收站与匿名不出现（旧列表契约不含 data 字段）
  const listRes = await app.request("/api/mindmaps", { headers: { "X-User-Id": USER_ID } });
  assert.equal(listRes.status, 200);
  const list = await listRes.json() as Array<{ id: string; starred: number; folderId: string | null }>;
  const listed = list.find((row) => row.id === MAP_IN_FOLDER);
  assert.ok(listed, "active mindmap doc should be listed");
  assert.equal(listed.starred, 1);
  assert.equal(listed.folderId, null);
  assert.ok(list.every((row) => row.id !== MAP_TRASHED));

  // 单读：带 data / canEdit / isUnlisted
  const getRes = await app.request(`/api/mindmaps/${MAP_IN_FOLDER}`, { headers: { "X-User-Id": USER_ID } });
  assert.equal(getRes.status, 200);
  const got = await getRes.json() as { id: string; data: string; canEdit: boolean; isUnlisted: number };
  assert.equal(got.data, mapData("星图计划", "编排子任务"));
  assert.equal(got.canEdit, true);
  assert.equal(got.isUnlisted, 0);

  // 他人不可读
  const forbidden = await app.request(`/api/mindmaps/${MAP_IN_FOLDER}`, { headers: { "X-User-Id": OTHER_ID } });
  assert.equal(forbidden.status, 403);

  // 更新：乐观锁不一致 → 409 MINDMAP_CONFLICT
  const stalePut = await app.request(`/api/mindmaps/${MAP_IN_FOLDER}`, {
    method: "PUT",
    headers: { "X-User-Id": USER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ data: mapData("星图计划", "编排子任务"), expectedUpdatedAt: "2000-01-01 00:00:00" }),
  });
  assert.equal(stalePut.status, 409);
  assert.equal((await stalePut.json() as { code: string }).code, "MINDMAP_CONFLICT");

  // 正常更新：写 notes.content + contentText，返回新 updatedAt
  const putRes = await app.request(`/api/mindmaps/${MAP_IN_FOLDER}`, {
    method: "PUT",
    headers: { "X-User-Id": USER_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ data: JSON.stringify({ root: { id: "root", text: "改名后", children: [] } }) }),
  });
  assert.equal(putRes.status, 200);
  const put = await putRes.json() as { data: string; updatedAt: string };
  assert.match(put.data, /改名后/);
  const stored = db.prepare("SELECT content, contentText, updatedAt FROM notes WHERE id = ?").get(MAP_IN_FOLDER) as {
    content: string; contentText: string; updatedAt: string;
  };
  assert.match(stored.content, /改名后/);
  assert.equal(stored.contentText, "改名后");
  assert.equal(stored.updatedAt, put.updatedAt);
});
