/**
 * pmRepository 行为测试（DB 隔离：临时库，跑 v126 migration）
 */
import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-pm-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { pmRepository } from "../src/repositories/pmRepository";
import { getDb } from "../src/db/schema";

function clean() {
  const db = getDb();
  db.prepare("DELETE FROM pm_work_items").run();
  db.prepare("DELETE FROM pm_projects").run();
}

const USER = "user-pm";

test("项目 CRUD 与按用户隔离", () => {
  clean();
  const p1 = pmRepository.createProject(USER, { name: "官网改版", description: "Q4", color: "#3b82f6" });
  assert.equal(p1.name, "官网改版");
  assert.equal(p1.status === undefined, true);

  const other = pmRepository.createProject("user-other", { name: "别人的项目" });
  assert.equal(pmRepository.listProjects(USER).length, 1);
  assert.equal(pmRepository.listProjects("user-other").length, 1);

  const updated = pmRepository.updateProject(USER, p1.id, { name: "官网改版二期", color: "#10b981" });
  assert.equal(updated?.name, "官网改版二期");
  assert.equal(updated?.color, "#10b981");

  // 别的用户改不了我的项目
  assert.equal(pmRepository.updateProject("user-other", p1.id, { name: "hack" }), null);
  assert.equal(pmRepository.getProject("user-other", p1.id), null);

  assert.equal(other.id !== p1.id, true);
});

test("工作项创建/状态流转/过滤", () => {
  clean();
  const project = pmRepository.createProject(USER, { name: "PM 插件" });
  const item = pmRepository.createWorkItem(USER, project.id, {
    type: "bug",
    title: "登录页白屏",
    description: "复现步骤：…",
    priority: "urgent",
  });
  assert.equal(item.status, "todo");
  assert.equal(item.type, "bug");
  assert.equal(item.priority, "urgent");

  // 非法类型/优先级回退默认
  const fallback = pmRepository.createWorkItem(USER, project.id, { type: "hack", title: "x", priority: "hack" });
assert.equal(fallback.type, "requirement");
  assert.equal(fallback.priority, "medium");

  // 状态流转
  const doing = pmRepository.updateWorkItem(USER, item.id, { status: "doing" });
  assert.equal(doing?.status, "doing");
  const done = pmRepository.updateWorkItem(USER, item.id, { status: "done" });
  assert.equal(done?.status, "done");
  // 非法状态被拒（保持原值）
  const invalid = pmRepository.updateWorkItem(USER, item.id, { status: "hack" });
  assert.equal(invalid?.status, "done");

  // 过滤
  const task = pmRepository.createWorkItem(USER, project.id, { type: "task", title: "写设计文档" });
  const bugs = pmRepository.listWorkItems(USER, project.id, { type: "bug" });
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].id, item.id);
  const open = pmRepository.listWorkItems(USER, project.id, { status: "done" });
  assert.equal(open.length, 1);
  assert.equal(open[0].id, item.id);

  // 统计
  const stats = pmRepository.projectStats(USER, project.id);
  assert.equal(stats.done, 1);
  assert.equal(stats.todo, 2); // task + 非法类型回退默认的 fallback

  // 关联笔记字段
  const linked = pmRepository.updateWorkItem(USER, task.id, { noteId: "note-1", gitRepo: "acme/app", gitBranch: "feat/x", gitIssue: "#12" });
  assert.equal(linked?.noteId, "note-1");
  assert.equal(linked?.gitIssue, "#12");

  // 删除项目级联删工作项
  pmRepository.deleteProject(USER, project.id);
  assert.equal(pmRepository.listWorkItems(USER, project.id).length, 0);
  assert.equal(pmRepository.getWorkItem(USER, task.id), null);

  // 不存在的项目创建工作项报错
  assert.throws(() => pmRepository.createWorkItem(USER, "no-such", { title: "x" }));
});

test("自定义工单类型与标签", () => {
  const project = pmRepository.createProject(USER, { name: "类型配置项目" });
  // 更新项目 typeConfig：新增"故事"类型
  const updated = pmRepository.updateProject(USER, project.id, {
    typeConfig: [
      { key: "requirement", label: "需求" },
      { key: "story", label: "故事", color: "#8b5cf6" },
      { key: "task", label: "任务" },
      { key: "bug", label: "缺陷" },
    ],
  });
  assert.equal(updated?.typeConfig.length, 4);
  assert.equal(updated?.typeConfig[1].key, "story");

  // 用自定义类型建工作项 + 标签
  const story = pmRepository.createWorkItem(USER, project.id, {
    type: "story",
    title: "用户故事",
    tags: ["前端", "迭代2"],
  });
  assert.equal(story.type, "story");
  assert.deepEqual(story.tags, ["前端", "迭代2"]);

  // 非法类型回退第一个 typeConfig key
  const fallback = pmRepository.createWorkItem(USER, project.id, { type: "hack", title: "x" });
  assert.equal(fallback.type, "requirement");

  // 标签过滤
  const tagged = pmRepository.listWorkItems(USER, project.id, { tag: "前端" });
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].id, story.id);

  // 标签更新（覆盖）
  const retagged = pmRepository.updateWorkItem(USER, story.id, { tags: ["前端", "后端", "API"] });
  assert.deepEqual(retagged?.tags, ["前端", "后端", "API"]);

  // 非法/超界标签清洗
  const dirty = pmRepository.updateWorkItem(USER, story.id, { tags: ["ok", 123 as unknown as string, "", "x".repeat(30)] });
  assert.deepEqual(dirty?.tags, ["ok", "xxxxxxxxxxxxxxxxxxxxxxxx"]);

  // M3：删除被引用的类型 → 阻止（后端校验，配合前端禁用）
  // 先移走非 story 引用（fallback 回退为 requirement），使断言聚焦在 story 被引用这一条件上
  pmRepository.deleteWorkItem(USER, fallback.id);
  assert.throws(
    () => pmRepository.updateProject(USER, project.id, { typeConfig: [{ key: "task", label: "任务" }] }),
    /仍被 1 个工单使用/,
  );

  // 删除该 story 工单后类型可移除；移除后新建工单 type 回退第一个 key
  pmRepository.deleteWorkItem(USER, story.id);
  const removed = pmRepository.updateProject(USER, project.id, {
    typeConfig: [{ key: "task", label: "任务" }],
  });
  assert.equal(removed?.typeConfig.length, 1);
  const afterRemoval = pmRepository.createWorkItem(USER, project.id, { type: "story", title: "x" });
  assert.equal(afterRemoval.type, "task");
});

test("M3 父子工作项：一层嵌套 + 删父提升子项", () => {
  clean();
  const project = pmRepository.createProject(USER, { name: "父子项目" });
  const parent = pmRepository.createWorkItem(USER, project.id, { type: "requirement", title: "父需求" });
  const child1 = pmRepository.createWorkItem(USER, project.id, { type: "task", title: "子任务 1", parentId: parent.id });
  const child2 = pmRepository.createWorkItem(USER, project.id, { type: "task", title: "子任务 2", parentId: parent.id });
  assert.equal(child1.parentId, parent.id);
  assert.equal(child2.parentId, parent.id);

  // 校验：自指 / 不存在的父 / 两层嵌套（创建与更新两条路都要拦）
  assert.throws(() => pmRepository.updateWorkItem(USER, parent.id, { parentId: parent.id }), /自己的父项/);
  assert.throws(() => pmRepository.createWorkItem(USER, project.id, { title: "x", parentId: "no-such" }), /父工作项不存在/);
  // 两层嵌套：给已有父项的子项再挂子项 → 拒绝（创建路径）
  assert.throws(() => pmRepository.createWorkItem(USER, project.id, { type: "task", title: "孙任务", parentId: child1.id }), /一层父子嵌套/);
  // 更新路径：换父到顶层项允许；换父到子项（两层）拒绝
  const top2 = pmRepository.createWorkItem(USER, project.id, { type: "task", title: "顶层二" });
  const reparented = pmRepository.updateWorkItem(USER, child1.id, { parentId: top2.id });
  assert.equal(reparented?.parentId, top2.id);
  assert.throws(() => pmRepository.updateWorkItem(USER, child1.id, { parentId: child2.id }), /一层父子嵌套/);
  // 换回原父，进入「删父」阶段
  const reparentedBack = pmRepository.updateWorkItem(USER, child1.id, { parentId: parent.id });
  assert.equal(reparentedBack?.parentId, parent.id);

  // 完成度口径由前端聚合（canceled 不计入分母）——此处验证状态面
  pmRepository.updateWorkItem(USER, child1.id, { status: "done" });
  pmRepository.updateWorkItem(USER, child2.id, { status: "canceled" });

  // 删父 → 子项提升为顶层（parentId 置空，非破坏性）
  pmRepository.deleteWorkItem(USER, parent.id);
  assert.equal(pmRepository.getWorkItem(USER, child1.id)?.parentId, null);
  assert.equal(pmRepository.getWorkItem(USER, child2.id)?.parentId, null);
});

test("M3 活动流：字段级 diff + 创建记录 + 200 条裁剪 + 用户隔离", () => {
  clean();
  const project = pmRepository.createProject(USER, { name: "活动流项目" });
  const item = pmRepository.createWorkItem(USER, project.id, { title: "原始标题", priority: "medium" });

  let logs = pmRepository.listWorkItemLogs(USER, item.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].field, "__created__");
  assert.equal(logs[0].newValue, "原始标题");

  // 一次 patch 三个字段 → 3 条日志
  pmRepository.updateWorkItem(USER, item.id, { status: "doing", priority: "high", dueDate: "2026-11-01" });
  logs = pmRepository.listWorkItemLogs(USER, item.id);
  assert.equal(logs.length, 4);
  const statusLog = logs.find((l) => l.field === "status");
  assert.equal(statusLog?.oldValue, "todo");
  assert.equal(statusLog?.newValue, "doing");
  const priorityLog = logs.find((l) => l.field === "priority");
  assert.equal(priorityLog?.oldValue, "medium");
  assert.equal(priorityLog?.newValue, "high");

  // 无变化不记日志
  pmRepository.updateWorkItem(USER, item.id, { status: "doing" });
  assert.equal(pmRepository.listWorkItemLogs(USER, item.id).length, 4);

  // 200 条裁剪：再改 200 次 status，总数不超过 200 且最新在前
  for (let i = 0; i < 200; i++) {
    pmRepository.updateWorkItem(USER, item.id, { status: i % 2 === 0 ? "todo" : "doing" });
  }
  logs = pmRepository.listWorkItemLogs(USER, item.id);
  assert.ok(logs.length <= 200);
  assert.equal(logs[0].field, "status");
  assert.equal(logs[0].newValue, "doing");

  // 用户隔离
  assert.equal(pmRepository.listWorkItemLogs("user-other", item.id).length, 0);
});

test("M3 多文档关联：关联/去重/解除/主交付文档清空", () => {
  clean();
  const db = getDb();
  // notes/notebooks 对 users(id) 有外键 → 先落测试用户
  db.prepare(`INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES ('user-pm', 'pm-test', 'x')`).run();
  // notes.notebookId 对 notebooks 有外键 → 先造笔记本
  db.prepare(`INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES ('nb-1', ?, 'M3 测试笔记本')`).run(USER);
  const project = pmRepository.createProject(USER, { name: "关联项目" });
  const noteId = "note-m3-1";
  db.prepare(`INSERT OR IGNORE INTO notes (id, userId, notebookId, title, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`)
    .run(noteId, USER, "nb-1", "设计文档", "2026-10-21T00:00:00.000Z", "2026-10-21T00:00:00.000Z");
  const noteId2 = "note-m3-2";
  db.prepare(`INSERT OR IGNORE INTO notes (id, userId, notebookId, title, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`)
    .run(noteId2, USER, "nb-1", "会议纪要", "2026-10-21T00:00:00.000Z", "2026-10-21T00:00:00.000Z");

  const item = pmRepository.createWorkItem(USER, project.id, { title: "带交付文档的工作项", noteId });
  // 主交付文档自动进关联
  let notes = pmRepository.listItemNotes(USER, item.id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].noteId, noteId);
  assert.equal(notes[0].title, "设计文档");

  // 关联第二篇 + 重复关联去重
  pmRepository.addItemNote(USER, item.id, noteId2);
  assert.equal(pmRepository.listItemNotes(USER, item.id).length, 2);
  const dup = pmRepository.addItemNote(USER, item.id, noteId2);
  assert.equal(dup.duplicate, true);
  assert.equal(pmRepository.listItemNotes(USER, item.id).length, 2);

  // 不存在的笔记
  assert.throws(() => pmRepository.addItemNote(USER, item.id, "no-such"), /笔记不存在/);

  // 解除非主文档
  const removed = pmRepository.removeItemNote(USER, item.id, noteId2);
  assert.equal(removed.success, true);
  assert.equal(removed.wasPrimary, false);
  assert.equal(pmRepository.listItemNotes(USER, item.id).length, 1);

  // 解除主交付文档 → noteId 同步清空
  const removedPrimary = pmRepository.removeItemNote(USER, item.id, noteId);
  assert.equal(removedPrimary.wasPrimary, true);
  assert.equal(pmRepository.getWorkItem(USER, item.id)?.noteId, null);
  assert.equal(pmRepository.listItemNotes(USER, item.id).length, 0);

  // 活动流包含 noteUnlinked / noteId；手动关联才有 noteLinked（主交付文档为自动写入，不记）
  const logs = pmRepository.listWorkItemLogs(USER, item.id);
  assert.ok(logs.some((l) => l.field === "noteLinked" && l.newValue === noteId2));
  assert.ok(logs.some((l) => l.field === "noteUnlinked" && l.oldValue === noteId2));
  assert.ok(logs.some((l) => l.field === "noteUnlinked" && l.oldValue === noteId));
  assert.ok(logs.some((l) => l.field === "noteId" && l.oldValue === noteId && l.newValue === null));
});
