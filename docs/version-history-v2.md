# 版本历史 v2 设计（自动/手动版本 + 保留策略）

> 状态：设计稿，待评审 → P1 实施
> 关联代码：`backend/src/repositories/noteVersionsRepository.ts`、`backend/src/routes/notes.ts`（版本创建）、`backend/src/routes/version.ts`、`frontend/src/components/VersionHistoryPanel.tsx`、设置页存储模块

## 1. 背景与目标

现有版本历史只有一条隐式的"编辑即存版本"链路，用户无法主动标记重要版本，也没有保留策略，长期使用版本表只增不减。

v2 目标：

1. 版本分为**自动备份**（定时快照，防丢失）与**手动备份**（发版/定稿，带名称与描述）；
2. 主线版本**只增不改**（append-only），历史不可变；
3. 自动备份保留策略可配置（永久 / 最近 N 个 / N 天内）；
4. 版本删除时正确处理附件引用，不产生误删与泄漏。

## 2. 现状（实现事实）

- `note_versions` 表：`id, noteId, userId, title, content, contentText, contentFormat, version(int), changeType('edit'|'guest_edit'|'restore'), changeSummary, createdAt`，内容全量内联；
- 版本创建：`PUT /api/notes/:id` 保存时，内容有实质变更才插入，且 5 分钟合并窗口防抖（`notes.ts:1017-1055`）；
- 还原已实现，产生 `changeType='restore'` 的新版本；
- `changeType` 是现成的"操作来源"字段，`kind`（版本用途）是其正交概念；
- 附件反向索引 `attachment_references(attachmentId, noteId)` **只扫当前笔记内容**（`backend/src/lib/attachmentRefs.ts`），**不扫版本内容**——"仅被历史版本引用的附件"当前就会被孤儿扫描视为无引用；
- 后端已有定时任务体系（如备份任务、calendar-export scheduler），定时快照可直接挂载。

## 3. 核心语义

| 概念 | 定义 |
| --- | --- |
| 主线 | 每笔记一条版本单链，`version` 单调递增，任何操作都追加新版本 |
| 不可变 | 版本记录创建后不修改、不改写；"覆盖主线"即还原（追加 restore 版本） |
| 自动版本（auto） | 服务端定时快照产生，防丢失用途，受保留策略管辖 |
| 手动版本（manual） | 用户主动保存产生，带名称/描述，**永不参与自动清理** |
| 保存 ≠ 版本 | Ctrl+S / 自动保存只更新笔记当前内容，**不产生任何版本** |

## 4. 行为规格

### 4.1 自动备份（定时必存）

- 服务端全局定时任务（挂现有 scheduler），周期 `autoVersionIntervalMinutes` 可配置（默认 30，可选 5/10/15/30/60）；
- 每轮扫描：对「当前内容 hash ≠ 最近一个版本的 hash」且「距该笔记最近版本 ≥ 间隔」的笔记插入 `kind='auto'` 版本；
- **Ctrl+S / 手动保存不进入自动备份**：保存路径不再插入版本，现"保存时插版本 + 5 分钟合并窗口"逻辑整体移除；
- 会话结束快照（建议默认开启、可配置关闭）：客户端切走/关闭笔记前，若存在未快照的已保存变更，请求一次 auto 快照——补齐"定时器未到点就关页"的丢失窗口；
- 内容 hash 用 `contentText` 的 SHA-1 前 16 位（`content` 太大，hash 用轻量字段即可判断"实质变化"；`title` 变更也计入 hash 输入）。

### 4.2 手动备份（主动版本）

- 入口：编辑器「⋯」菜单 + 版本历史面板顶部「保存版本」；
- `POST /api/notes/:id/versions`，body 可带 `label`（名称，≤80 字）、`description`（描述，≤500 字）；名称留空时默认「手动备份 YYYY/MM/DD HH:mm」；
- 快照对象是**当前已保存**的笔记内容；若编辑器有未保存修改，先触发保存再建版本；
- 版本列表中手动版本带徽标，显示名称/描述。

### 4.3 还原

- 语义不变：追加 `changeType='restore'` 的新版本，内容取自目标版本；
- 面板确认弹窗补充说明：「当前内容会自动存为一个版本，可随时再还原回来」。

### 4.4 从版本创建副本（P1）

- `POST /api/notes/:id/versions/:versionId/duplicate`：以该版本内容新建笔记，标题追加「（副本）」，落在原笔记同一笔记本，附件引用随内容复制（引用同一附件 id，不复制 blob）；
- 权限：编辑权限即可。

### 4.5 保留策略（用户自选）

设置 → 存储，全局配置：

| 模式 | 参数 | 说明 |
| --- | --- | --- |
| 永久保留 | — | 默认值，行为与现状兼容 |
| 保留最近 N 个 | N（默认 50） | 只清 auto |
| 保留 N 天内 | N（默认 90） | 只清 auto |

- **manual 版本永不参与自动清理**；
- 执行时机：随每日定时任务 + 设置页「立即清理」按钮；
- 清理前输出预览数量，清理后写入审计日志（清理了多少条、释放约多少 MB）。

### 4.6 删除版本

- 版本列表面板：auto 可单删/多选批量删；manual 删除需二次确认；仅笔记所有者/管理员可删；
- 协作者（编辑权限）：可还原、可创建副本、可保存手动版本，不可删除版本。

## 5. 数据模型变更

```sql
ALTER TABLE note_versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto';      -- 'auto' | 'manual'
ALTER TABLE note_versions ADD COLUMN label TEXT;                             -- 手动版本名称
ALTER TABLE note_versions ADD COLUMN description TEXT;                       -- 手动版本描述
ALTER TABLE note_versions ADD COLUMN contentHash TEXT;                       -- 内容指纹（sha1(contentText+title) 前 16 位）

-- 版本级附件引用倒排（复用 attachmentRefs 的解析函数）
CREATE TABLE version_attachment_refs (
  versionId TEXT NOT NULL,
  attachmentId TEXT NOT NULL,
  PRIMARY KEY (versionId, attachmentId)
);
```

- 存量数据迁移：现有全部版本行 `kind='auto'`（它们本就是保存自动产生），`contentHash` 惰性回填（下次定时轮询时补）；
- 版本创建（auto/manual/restore）统一走一个入口，创建时同步写 `version_attachment_refs`；
- 删除版本时同步删对应 ref 行。

## 6. API 变更

| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/notes/:id/versions` | 新增：手动保存版本（label/description） |
| `POST /api/notes/:id/versions/:versionId/duplicate` | 新增：从版本创建副本笔记 |
| `DELETE /api/notes/:id/versions/:versionId` | 新增：删除单个版本（权限：所有者/管理员） |
| `POST /api/notes/:id/versions/batch-delete` | 新增：批量删除（仅 auto） |
| `GET /api/notes/:id/versions` | 扩展：`kind` 筛选参数；返回 label/description/占用字节 |
| `GET/PUT /api/settings` | 扩展：`autoVersionIntervalMinutes`、`retention.mode/count/days`、`sessionEndSnapshot` |

`PUT /api/notes/:id` 中现有"保存时插版本"代码移除（`notes.ts:1017-1055`）。

## 7. 前端变更

- **VersionHistoryPanel 改版**：顶部「保存版本」+ 筛选 Tab（全部/手动/自动）+ 类型徽标 + 手动版本名称/描述展示 + 单删/批量删 + 占用统计（共 N 个版本 ≈ X MB）；
- **编辑器「⋯」菜单**：加「保存版本…」；
- **设置 → 存储**：自动备份间隔、保留策略（三模式单选 + N 输入）、会话结束快照开关、「立即清理」；
- 版本预览（只读）保持现状；还原确认弹窗文案按 4.3 调整。

## 8. 附件引用与清理（关键安全点）

现状风险：附件孤儿判定只看当前笔记内容，"仅被历史版本引用的附件"会被视为无引用；版本删除/保留策略上线后必须先补齐引用源，否则回滚后图片丢失。

P1 方案：

1. 版本创建时解析 `content` 中 `/api/attachments/<uuid>` 引用（复用 `extractAttachmentIdsFromContent`），写入 `version_attachment_refs`；
2. 附件"被引用"判定扩展为：**当前内容引用（attachment_references）∪ 版本引用（version_attachment_refs）**；
3. 删除版本 → 事务内同步删 ref 行 → 之后孤儿扫描自然不再把该附件计入被版本引用；
4. P1 不做 blob 物理删除的两阶段宽限期（P2：待清理队列 + 7 天宽限 + 审计），P1 依赖现有孤儿扫描的手动清理入口兜底。

## 9. 迁移与兼容

- 新增列均有默认值，SQLite `ALTER TABLE` 直接加；PostgreSQL 适配同步（该表如无 PG 侧定义则跳过）；
- 存量版本全部标 `auto`，不回填 label；
- 移除"保存时插版本"后，`getLastEditByNoteId` 的合并窗口逻辑一并下线；
- 加密笔记：版本内容存储走现有加密转换体系，P1 实现时单独验证一条加密笔记的手动/自动版本全流程；
- 协同（Yjs）：定时快照基于已保存内容，实时协同中的未保存段落不入版本，行为与现状一致。

## 10. 验收清单

- [ ] Ctrl+S 保存后版本列表不变；到点定时快照后出现 auto 版本
- [ ] 内容无变化时定时器不产生版本（hash 去重）
- [ ] 手动版本带名称/描述/徽标，列表筛选正确
- [ ] 还原产生 restore 版本且历史完整；从版本创建副本成功且附件可显示
- [ ] 保留策略三种模式各自生效，manual 版本永不清除
- [ ] 删除"仅某版本引用附件"的版本后，附件引用判定不再计入该版本；笔记还原到该版本前附件未被清理
- [ ] 加密笔记全流程（手动/自动/还原/副本）通过
- [ ] 后端与前端相关测试补充并通过

## 11. 分期

- **P1（本次）**：第 4-8 节全部内容（类型、定时快照、手动版本、副本、保留策略、版本删除、版本级附件引用）；
- **P2（后续）**：附件 blob 两阶段 GC（宽限期 + 审计）、版本间 diff 视图、存储配额展示。
