# 项目管理插件（pm）设计与实现

> 分支：`feat/plugin-git-projects`（自 feat/plugin-remote-files 切出）· P1 已实现 · 2026-10-20

## 1. 定位（用户纠偏后的方向）

**不是 git 客户端，而是在笔记软件基础上通过插件变成项目管理系统**（类似禅道 / PingCode）：
- 核心：项目 → 工作项（需求 / 任务 / 缺陷）→ 状态流程
- 文档：笔记即交付物（工作项关联交付笔记，复用知识库编辑能力）
- git：工作项可引用仓库/分支/issue（P1 手工字段，P2 对接 GitHub/GitLab/Gitea API 自动同步）

## 2. 形态

独立内置插件（registry id `pm`）：Rail 徽章 + 主区全屏中心 PmCenter + 侧栏迷你面板
（各项目未完成计数）。可在插件管理停用。

## 3. 数据模型（v126，SQLite/PG 三层落地同 remote-files 先例）

- `pm_projects`：id/userId/name/description/color/workspaceId
- `pm_work_items`：projectId/type(需求·任务·缺陷)/title/description(markdown)/
  status(todo→doing→review→done，canceled 终止)/priority(urgent·high·medium·low)/
  dueDate/notebookId/noteId（交付笔记）/gitRepo·gitBranch·gitIssue（P1 引用）
- 仓库层：`src/repositories/pmRepository.ts`（按 userId 隔离，项目删除级联工作项）
- 路由：`/api/pm`（projects CRUD、items CRUD+过滤、projectStats）

## 4. UI

- 左列项目列表；右侧工具条（统计/类型筛选/看板|列表切换/新建）
- 看板：待处理 / 进行中 / 待验证 / 已完成 四列卡片（类型徽标、优先级、截止、笔记标记）
- 详情抽屉：状态流转按钮、描述、git 引用展示、**创建交付笔记并关联**（标题=【工作项】xxx，
  正文带描述，写入后可从编辑器打开继续编辑）、删除
- 侧栏迷你面板：项目列表 + 各项目未完成计数

## 5. P2 待办

- GitHub/GitLab/Gitea API 集成：issue ↔ 工作项双向同步（PAT 多源，remote-files 同款凭据加密模式）
- 看板拖拽排序（sortOrder 已预留）、工作项父子/阻塞关系
- 工作项描述转关联文档（notebookId 已预留）、@工作项 反向引用、成员协作

## 6. 验证记录

- pm-repository 单测：项目隔离 / 状态流转 / 类型·状态非法值回退 / 统计 / 级联删除 全过
- backend `npx tsc` 0 错误（首次全量类型检查）；三 provider 28/28 回归；bundle 构建 ✓
- 前端 `tsc -b` 0 错误
- 未验证（待实测）：真实页面交互、与加密笔记的组合