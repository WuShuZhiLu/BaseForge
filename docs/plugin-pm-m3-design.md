# PM 插件 M3 设计：工作项模型深化

> 依据：`docs/plugin-pm-analysis.md` §五 M3（需求表 B5 / B8 / B9 / B10 / C2）· 2026-10-21
> 工作方式：**本文确认后再动代码**；实现于分支 `feat/plugin-git-projects`
> 范围说明：itemNo 编号（B7）已在 v128 交付，不在本批。

---

## 一、本批范围（5 项）

| # | 功能 | 需求编号 | 层 |
|---|---|---|---|
| 1 | 类型管理 UI（项目设置抽屉） | B5 | 前端为主 + 后端删类型校验 |
| 2 | 父子工作项 | B8 | 迁移 + 后端 + 前端 |
| 3 | 活动流（变更历史） | B9 | 迁移 + 后端 + 前端 |
| 4 | 描述 markdown 预览 | B10 | 前端 |
| 5 | 多文档关联 | C2 | 迁移 + 后端 + 前端 |

---

## 二、数据模型与迁移（**v129**，单迁移覆盖全部 schema 变更）

### 2.1 pm_work_items 新增列

```sql
ALTER TABLE pm_work_items ADD COLUMN "parentId" TEXT REFERENCES pm_work_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pm_work_items_parent ON pm_work_items("projectId", "parentId");
```
- 删父项 → 子项 `parentId` 自动置 NULL（提升为顶层，不级联删子项——非破坏性铁律）。
- 只允许**一层嵌套**（父不能再有父，对齐 PingCode「需求→子任务」；防环校验见 §四）。

### 2.2 新表 pm_work_item_logs（活动流）

```sql
CREATE TABLE IF NOT EXISTS pm_work_item_logs (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL REFERENCES pm_work_items(id) ON DELETE CASCADE,
  "projectId" TEXT NOT NULL,
  field TEXT NOT NULL,          -- 变更字段名；'__created__' 表示创建
  oldValue TEXT,                -- 超 200 字符截断加 '…'（数组/对象 JSON 序列化）
  newValue TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pm_logs_item ON pm_work_item_logs("itemId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_pm_logs_project ON pm_work_item_logs("projectId", "createdAt" DESC);
```
- 保留策略：每工单仅保留最近 **200** 条（INSERT 后裁剪），防膨胀。
- 删除工单不单独记日志（历史随 CASCADE 消失，语义一致）。

### 2.3 新表 pm_item_notes（多文档关联）

```sql
CREATE TABLE IF NOT EXISTS pm_item_notes (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL REFERENCES pm_work_items(id) ON DELETE CASCADE,
  "noteId" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE("itemId", "noteId")
);
CREATE INDEX IF NOT EXISTS idx_pm_item_notes_note ON pm_item_notes("noteId");
```
- **迁移兼容**：`INSERT INTO pm_item_notes SELECT ... FROM pm_work_items WHERE "noteId" IS NOT NULL`（旧单 noteId 自动成为关联之一，幂等 `WHERE NOT EXISTS`）。
- `pm_work_items.noteId` 列**保留**，语义升级为「主交付文档」（详情抽屉置顶标记），新旧并存、API 向后兼容。

### 2.4 Postgres 幂等块

`backend/src/db/postgres/schema.sql` 追加同构块（`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` / `INSERT … WHERE NOT EXISTS`），与 v126/v127/v128 现行写法一致。

---

## 三、活动流实现（B9）——记录点在仓库层

**关键设计**：diff 日志记在 `pmRepository.updateWorkItem` **内部**（旧值对比新值，逐字段写日志）。
自动覆盖所有调用方——包括 `routes/pm-git.ts` 的拉取/推送/平台状态回写（gitIssueState 等变更同样进历史，无需 pm-git 改动）。

- 记录字段：title / description / status / priority / dueDate / type / tags / noteId / gitRepo / gitBranch / gitIssue / gitIssueState / parentId（新增后）。
- 值格式：数组/对象 JSON 序列化；所有值超 200 字符截断加 `…`；一次 patch 改 N 个字段记 N 条。
- 创建工单记一条 `field='__created__', newValue=title`。
- API：`GET /api/pm/items/:id/logs` → `{ logs: [{ field, oldValue, newValue, createdAt }] }`（按时间倒序，limit 100；项目级聚合放 M4/M5）。

---

## 四、父子工作项（B8）

- `createWorkItem` 增 `parentId` 入参；`updateWorkItem` 增 `parentId` patch。校验：
  1. 父项存在且**同项目**；
  2. 父项自身 `parentId` 为空（一层嵌套）；
  3. 不能把自己设为自己的父。
- 聚合口径：父卡片显示子项完成度 **x/y**——`y` = 非 canceled 子项数，`x` = 其中 status='done' 的数量。
- 前端：看板父卡片加进度徽标（如 `2/5` + 迷你进度条）；列表视图子项行缩进 + 缩短标题；详情抽屉加「子工作项」区（列表 + 添加子项）。
- 查询：`listWorkItems` 不变（平铺返回），前端按 parentId 分组；父卡片进度由前端聚合（数据已在内存，不加后端端点）。

---

## 五、类型管理 UI（B5）

- 入口：PmCenter 工具条项目下拉 → 现有「编辑项目」对话框升级为**「项目设置」抽屉**（复用现有 Overlay），两区：
  1. 基本信息（名称/描述/颜色——现有能力平移）；
  2. **工单类型管理**：列表（色点 + label + 只读 key）+ 新增 + 编辑 label + 删除 + 上移/下移（数组顺序 = 看板列/表单下拉/筛选器的顺序）+ 颜色（预设 8 色板点选，零依赖）。
- 校验（前后端双重）：
  - `key` 前端生成（`t_` + 随机 6 位）且**不可编辑**——已有工单按 key 关联，改 key 断链；
  - `label` 必填 ≤24 字符（与后端 parseTypeConfig 一致）；
  - **删除被引用类型 → 阻止**：前端按当前项目工单统计禁用删除按钮并提示；后端 `updateProject` 同步校验（被引用 key 从 typeConfig 移除时返回 400）。
- 至少保留 1 个类型（全部删除会被 parseTypeConfig 回退默认值，UI 直接禁止最后一条删除）。

---

## 六、描述 markdown 预览（B10）

- ItemDrawer 描述区：只读态加「渲染 / 源码」切换（默认**渲染**）。
- 渲染复用 `frontend/src/components/MarkdownPreview.tsx`（知识库现成组件，零新依赖）；编辑态仍为 ItemForm 的 textarea（富文本 P2）。

---

## 七、多文档关联（C2）

- 后端 repository 新方法：`listItemNotes(userId, itemId)`（JOIN 核心笔记表取 title，过滤已删除笔记）、`addItemNote(userId, itemId, noteId)`（去重）、`removeItemNote(userId, itemId, noteId)`。
- API：
  - `GET /api/pm/items/:id/notes` → `{ notes: [{ id, noteId, title, createdAt }] }`
  - `POST /api/pm/items/:id/notes` `{ noteId }` → 关联既有笔记（活动流记 `noteLinked`）
  - `DELETE /api/pm/items/:id/notes/:noteId` → 解除关联（活动流记 `noteUnlinked`）
  - 主交付文档（noteId）创建/变更时**自动写入** pm_item_notes（保持一致性）。
- 前端 ItemDrawer 关联区改造：
  - 旧「交付笔记」单行 → **「关联文档」列表**：主文档标记 📌（仅排序置顶，不新增字段）、打开（复用 `nowen:open-note-by-id`）、解除关联；
  - 「+ 关联既有笔记」：按标题搜索核心笔记（复用现有搜索 API）勾选关联；
  - 「+ 新建交付文档」：复用现有 createDeliveryNote 逻辑（写 noteId + 自动进关联列表）。

---

## 八、前端 API 层（api.impl.ts 新增）

`listPmItemLogs` / `listPmItemNotes` / `addPmItemNote` / `removePmItemNote` / `updatePmWorkItem` 增 `parentId` / `updatePmProject` 的 typeConfig 已通。

---

## 九、验收标准

| 项 | 验收 |
|---|---|
| 迁移 | v129 在全新库与 v128 旧库都能升级；Postgres 幂等块同步；`npx tsc` 0 错误 |
| 活动流 | 改 status/dueDate/tags 各产生一条日志（旧值→新值正确）；pm-git 推送/拉取自动产生日志；GET logs 倒序返回；超 200 条裁剪 |
| 父子 | 建子项校验（同项目/一层/防环）；父卡片 2/5 进度正确；canceled 子项不计入分母；删父 → 子项提升为顶层 |
| 类型 UI | 增/删/改/排序/改色即时生效并持久化；删除被引用类型被前后端双重阻止；最后一条类型不可删 |
| 描述预览 | 渲染/源码切换即时；渲染复用 MarkdownPreview |
| 多文档 | 关联/解除/打开可用；v128 旧数据（单 noteId）迁移后自动出现在关联列表并标为主文档；重复关联被 UNIQUE 拦截 |
| 测试 | `backend/tests/pm-repository.test.ts` 扩展（父子/活动流/多文档/类型删除校验），沿用开头 `clean()` 防双重收集；`ELECTRON_RUN_AS_NODE=1` electron 单跑 |
| 门禁 | backend `npx tsc` 0 错误；frontend `npx tsc -b` 0 错误；全量基线不新增失败（既有 2 失败不动） |

---

## 十、改动清单与预估

| 层 | 文件 | 内容 | 预估 |
|---|---|---|---|
| 迁移 | `backend/src/db/pmM3Migration.ts`（新）+ `migrations.ts` 注册 | v129：parentId 列 + 两张新表 + noteId 数据迁移 | ~110 行 |
| Postgres | `backend/src/db/postgres/schema.sql` | 幂等块同步 | ~40 行 |
| 数据层 | `backend/src/repositories/pmRepository.ts` | parentId 校验 + updateWorkItem 内建 diff 日志 + logs/notes 方法 + updateProject 删类型校验 | ~250 行 |
| 路由 | `backend/src/routes/pm.ts` | GET logs / GET·POST·DELETE notes | ~70 行 |
| 前端 | `frontend/src/components/PmCenter.tsx` | 项目设置抽屉（类型管理）+ 抽屉改造（活动流时间线 / 描述预览切换 / 关联文档区）+ 看板父卡片进度 | ~420 行 |
| 前端 | `frontend/src/lib/api.impl.ts` | 4 个新接口 + parentId 透传 | ~60 行 |
| 测试 | `backend/tests/pm-repository.test.ts` | 父子/日志/多文档/类型校验用例 | ~180 行 |

---

## 十一、决策点（请拍板，默认值=推荐项）

| # | 决策 | 推荐 | 备选 |
|---|---|---|---|
| 1 | 活动流范围 | 本批只做工单级时间线（项目级聚合放 M4） | 本批连项目级聚合一起做 |
| 2 | 类型删除策略 | 被引用即禁止删除（前后端双重） | 强制迁移到指定类型（多一步交互） |
| 3 | 类型颜色 | 预设 8 色板点选（零依赖） | 完整颜色选择器（+依赖） |
| 4 | 父子嵌套 | 仅一层（对齐 PingCode） | 任意深度（递归聚合复杂） |
| 5 | 描述渲染 | 复用 MarkdownPreview（零依赖） | tiptap 只读渲染（更重，P2） |
| 6 | 迁移号 | v129（M3 单迁移） | 拆 v129/v130/v131 三迁移 |
