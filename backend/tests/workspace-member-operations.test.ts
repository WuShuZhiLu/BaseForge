/**
 * 工作区成员操作路由测试：站内搜索添加成员、Owner 转让、邀请码重置
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ws-member-ops-"));
process.env.DB_PATH = path.join(tempDir, "ws-member-ops.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

function request(
  pathname: string,
  input: { method?: string; body?: unknown; userId?: string } = {},
): Request {
  // workspacesRouter 直接挂载在 /api/workspaces（见 index.ts），router 自身不带前缀，
  // 调 router.request() 时须剥掉测试用例里书写的 /workspaces 前缀
  const routePath = pathname.replace(/^\/workspaces(?=\/)/, "");
  return new Request(`http://localhost${routePath}`, {
    method: input.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": input.userId === undefined ? "owner" : input.userId,
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

let db: import("node:sqlite").DatabaseSync;
let workspaces: (typeof import("../src/routes/workspaces.js"))["default"];

test("setup: 初始化数据库与测试数据", async () => {
  const { getDb, closeDb } = await import("../src/db/schema.js");
  workspaces = (await import("../src/routes/workspaces.js")).default;
  closeDatabase = closeDb;
  db = getDb();

  // 测试账号：均为普通用户（role 默认非 admin，不触发系统管理员旁路）
  const insertUser = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')",
  );
  for (const id of ["owner", "admin1", "editor1", "newbie", "newbie2", "outsider"]) {
    insertUser.run(id, id);
  }
  // 禁用账号：添加成员时必须被拒绝
  db.prepare("UPDATE users SET isDisabled = 1 WHERE id = 'newbie2'").run();

  db.prepare(
    "INSERT OR IGNORE INTO workspaces (id, name, ownerId) VALUES ('ws-ops', 'Ops WS', 'owner')",
  ).run();
  const insertMember = db.prepare(
    "INSERT OR IGNORE INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)",
  );
  insertMember.run("ws-ops", "owner", "owner");
  insertMember.run("ws-ops", "admin1", "admin");
  insertMember.run("ws-ops", "editor1", "editor");
});

// ===================== 站内搜索添加成员 =====================

test("非 admin 添加成员返回 403", async () => {
  const res = await workspaces.request(request("/workspaces/ws-ops/members", {
    method: "POST",
    body: { userId: "newbie", role: "viewer" },
    userId: "editor1",
  }));
  assert.equal(res.status, 403);
});

test("admin 添加成员成功，重复添加幂等返回 alreadyMember", async () => {
  const res = await workspaces.request(request("/workspaces/ws-ops/members", {
    method: "POST",
    body: { userId: "newbie", role: "viewer" },
    userId: "admin1",
  }));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { success: true });

  const again = await workspaces.request(request("/workspaces/ws-ops/members", {
    method: "POST",
    body: { userId: "newbie", role: "editor" },
    userId: "admin1",
  }));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { success: true, alreadyMember: true });

  // 幂等语义：角色未被第二次请求改成 editor
  const role = db
    .prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get("ws-ops", "newbie") as { role: string };
  assert.equal(role.role, "viewer");
});

test("添加成员不能直接授予 owner 角色", async () => {
  const res = await workspaces.request(request("/workspaces/ws-ops/members", {
    method: "POST",
    body: { userId: "outsider", role: "owner" },
    userId: "admin1",
  }));
  assert.equal(res.status, 400);
});

test("添加已禁用用户返回 404", async () => {
  const res = await workspaces.request(request("/workspaces/ws-ops/members", {
    method: "POST",
    body: { userId: "newbie2", role: "viewer" },
    userId: "admin1",
  }));
  assert.equal(res.status, 404);
});

// ===================== Owner 转让 =====================

test("仅 owner 可调用转让接口", async () => {
  const res = await workspaces.request(request("/workspaces/ws-ops/transfer-ownership", {
    method: "POST",
    body: { toUserId: "newbie" },
    userId: "admin1",
  }));
  assert.equal(res.status, 403);
});

test("转让后新成员成为 owner，原 owner 降为 admin", async () => {
  const res = await workspaces.request(request("/workspaces/ws-ops/transfer-ownership", {
    method: "POST",
    body: { toUserId: "newbie" },
    userId: "owner",
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });

  const newRole = db
    .prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get("ws-ops", "newbie") as { role: string };
  assert.equal(newRole.role, "owner");
  const oldRole = db
    .prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get("ws-ops", "owner") as { role: string };
  assert.equal(oldRole.role, "admin");

  // canonical owner 判定同步：workspaces.ownerId 必须指向新 owner
  // （knowledgeTreeCore 权限预设、删除空间时的内容归属都读这一列）
  const wsOwner = db
    .prepare("SELECT ownerId FROM workspaces WHERE id = ?")
    .get("ws-ops") as { ownerId: string };
  assert.equal(wsOwner.ownerId, "newbie");

  // 原 owner 已降为 admin，不再满足 owner 门槛（防重复转让的第一道拦截）
  const again = await workspaces.request(request("/workspaces/ws-ops/transfer-ownership", {
    method: "POST",
    body: { toUserId: "newbie" },
    userId: "owner",
  }));
  assert.equal(again.status, 403);

  // 新 owner 是唯一 owner，重复转让只能指向自己，被自转让拦截兜底
  const self = await workspaces.request(request("/workspaces/ws-ops/transfer-ownership", {
    method: "POST",
    body: { toUserId: "newbie" },
    userId: "newbie",
  }));
  assert.equal(self.status, 400);
});

test("目标不是成员时转让失败", async () => {
  const res = await workspaces.request(request("/workspaces/ws-ops/transfer-ownership", {
    method: "POST",
    body: { toUserId: "outsider" },
    userId: "newbie",
  }));
  assert.equal(res.status, 404);
});

// ===================== 邀请码重置 =====================

test("重置后旧邀请码 join 返回 404，新码可用", async () => {
  const created = await workspaces.request(request("/workspaces/ws-ops/invites", {
    method: "POST",
    body: { role: "viewer", maxUses: 10 },
    userId: "newbie",
  }));
  assert.equal(created.status, 201);
  const invite = (await created.json()) as { id: string; code: string; useCount: number };
  const oldCode = invite.code;

  const reset = await workspaces.request(request(
    `/workspaces/ws-ops/invites/${invite.id}/reset`,
    { method: "POST", userId: "newbie" },
  ));
  assert.equal(reset.status, 200);
  const resetInvite = (await reset.json()) as { code: string; useCount: number };
  assert.notEqual(resetInvite.code, oldCode);
  assert.equal(resetInvite.useCount, 0);

  const joinOld = await workspaces.request(request("/workspaces/join", {
    method: "POST",
    body: { code: oldCode },
    userId: "outsider",
  }));
  assert.equal(joinOld.status, 404);

  const joinNew = await workspaces.request(request("/workspaces/join", {
    method: "POST",
    body: { code: resetInvite.code },
    userId: "outsider",
  }));
  assert.equal(joinNew.status, 200);
});

test("重置不存在的邀请码返回 404", async () => {
  const res = await workspaces.request(request("/workspaces/ws-ops/invites/no-such/reset", {
    method: "POST",
    userId: "newbie",
  }));
  assert.equal(res.status, 404);
});
