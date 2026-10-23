# 交接文档：项目管理插件（pm）与远程文件插件（remote-files）

> 交接时间：2026-10-21 · 交接人：AutoClaw 会话 · 接手 agent 请**全文读完再动代码**
> 工作目录：`C:\Users\27339\WorkBuddy\note\BaseForge`

---

## 一、仓库与分支路径

- 仓库根：`C:\Users\27339\WorkBuddy\note\BaseForge`
- **当前分支：`feat/plugin-git-projects`**（HEAD = `877cd64f`，工作区干净，**未推送**）
- 祖先链（同分支上，按时间序）：
  1. `2450a248` PM 插件 P1（项目/工作项/看板）
  2. `6382dd49` 侧栏文件视图「远程」入口
  3. `5581d5cb` 标签 + 自定义类型 + git 三平台同步
  4. `1b23496c` PmCenter 布局重构（统一工具条）
  5. `f703b0ec` JSX 语法破损修复
  6. `2fec7339` 分析书文档
  7. `877cd64f` 侧栏项目面板 + 看板拖拽 + itemNo 编号 + 搜索
- **另一分支 `feat/plugin-remote-files`**（15 个提交，含远程文件插件全部 + Rail 徽章自定义，同样未推送）。
  注意：PM 插件分支是从它切出的，**推送顺序**：先 `feat/plugin-remote-files` 再 `feat/plugin-git-projects`。
  ```
  git push -u origin feat/plugin-remote-files
  git push -u origin feat/plugin-git-projects
  ```

## 二、关键文件路径

### PM 插件（本交接主线）
| 层 | 路径 |
|---|---|
| 迁移（v126/v127/v128） | `backend/src/db/pmMigration.ts`、`backend/src/db/pmTagsMigration.ts`、`backend/src/db/pmItemNoMigration.ts` |
| 迁移注册 | `backend/src/db/migrations.ts`（import + MIGRATIONS 数组） |
| SQLite schema | `backend/src/db/schema.ts`（搜索 `pm_projects`） |
| Postgres schema | `backend/src/db/postgres/schema.sql`（搜索 `pm_projects`，幂等块） |
| 数据层 | `backend/src/repositories/pmRepository.ts` |
| 路由 | `backend/src/routes/pm.ts`（/api/pm）、`backend/src/routes/pm-git.ts`（/api/pm/git） |
| 路由挂载 | `backend/src/index.ts`（搜 `pmRouter` / `pmGitRouter`，~574 行附近） |
| git 平台 provider | `backend/src/services/pm-git/`（types/github/gitlab/gitea/index） |
| 前端主区 | `frontend/src/components/PmCenter.tsx`（~700 行，注意 623-691 为看板/列表条件渲染区） |
| 前端接线 | `frontend/src/App.tsx`（isPmView 分支）、`frontend/src/components/NavRailNext.tsx`（pm 徽章）、`frontend/src/components/SidebarNext.tsx`（ProjectsSidePanel + sbx 视图 `sidebarView === "projects"`）、`frontend/src/plugins/builtin/registry.ts`（id "pm"）、`frontend/src/plugins/builtin/MiniPanels.tsx`（PmMiniPanel） |
| 类型 | `frontend/src/types/index.ts`（搜 `PmProject` / `PmWorkItem` / `PmGitSource`；ViewMode 含 "projects"） |
| API | `frontend/src/lib/api.impl.ts`（搜 `listPmProjects` / `pullPmItem`） |
| 测试 | `backend/tests/pm-repository.test.ts` |

### remote-files 插件（前序交付，参考实现）
- 后端：`backend/src/routes/remote-files.ts`、`backend/src/services/remote-files/`（types/credentials/webdav/baidu/smb/index）
- 前端：`frontend/src/components/RemoteFilesCenter.tsx`、`backend/src/routes/files.ts`（upload-from-remote 端点）
- 凭据加密复用：`backend/src/services/remote-files/credentials.ts`（encryptSecret/decryptSecret，PM 的 git token 也用它）

### 文档
- `docs/plugin-pm-analysis.md` ← **分析书 + 功能需求表（30+ 项）+ M1-M6 改进计划（接手者必读）**
- `docs/plugin-remote-files.md`

## 三、运行与验证命令

```bash
# 后端（在 backend/ 下）
npx tsc                                   # 全量类型检查（必须 0 错误；esbuild build 不查类型！）
ELECTRON_RUN_AS_NODE=1 ../node_modules/electron/dist/electron.exe --import tsx --test tests/pm-repository.test.ts tests/remote-files-webdav.test.ts tests/remote-files-baidu.test.ts tests/remote-files-smb.test.ts
ELECTRON_RUN_AS_NODE=1 ../node_modules/electron/dist/electron.exe build.bundle.mjs

# 前端（在 frontend/ 下）
npx tsc -b          # 0 错误
npx vitest run      # 基线：2 failed | 494 passed（releaseI18nCoverage 27 缺失键 + androidNativeHttpBridge——既有失败，非本插件）
npx eslint src/components/PmCenter.tsx   # 注意：no-explicit-any 全仓大量既有报错，只关注新增文件

# dev（根目录）
npm run dev          # 前端 5173 / 后端 3000（用户环境实证）
```

## 四、已完成功能（截至 877cd64f）

### PM 插件
- 项目 CRUD（色点/描述）+ 工作项 CRUD（类型/状态/优先级/截止/标签）
- **项目级自定义工单类型**（typeConfig JSON，默认需求/任务/缺陷，可增删改+颜色）
- **标签**（多选、自动配色、按标签筛选）
- **状态机**：todo → doing → review → done（canceled 终止）
- **itemNo 项目内自增编号**（v128），卡片显示 #n
- **看板**：四列色头、优先级左色条、标签 chips、逾期红字、**原生 HTML5 拖拽改状态**（仿 TaskBoardView）
- **列表视图**：类型徽标/标签/优先级/状态/截止（逾期红）
- 统一工具条：项目下拉（色点+新建/编辑）+ 统计胶囊 + 类型/标签筛选 + 搜索 + 视图切换 + 新建/平台/刷新
- **详情抽屉**：状态流转、标签、交付笔记（创建/关联/打开）、git 同步（拉取/推送/平台打开/关联建单）、删除
- **侧栏项目面板**（SidebarNext `ProjectsSidePanel`）：项目 chips + 工单状态分组速览 + 行内快改完成 + 主区打开
- Rail 徽章 + MiniPanel（项目未完成计数）
- **git 双向同步**：三平台 provider（GitHub Bearer / GitLab PRIVATE-TOKEN / Gitea token，自建实例 apiBase 可配）+ 平台源管理（PAT 加密）+ 批量导入（按平台编号 upsert）+ 单项拉取/推送 + 平台建单关联

### remote-files 插件（前序）
- WebDAV 全功能 / 百度网盘（分片 + OAuth 自动续期）/ SMB（@marsaud/smb2）
- 文件管理「本地/远程」Tab 内嵌 + 侧栏「☁ 远程」chip 入口
- 三动作桥接：导入为笔记 / 转本地附件 / 附件另存到远程
- Rail 徽章自定义体系（右键隐藏/空白添加/插件组折叠/详情）——PM 徽章同样受这套管理

## 五、后续计划（接手者按此继续）

### 立即项
1. **推送两个分支**（用户实测后执行）：
   `git push -u origin feat/plugin-remote-files && git push -u origin feat/plugin-git-projects`
2. **用户实测**：PM（项目/工作项/拖拽/同步）、远程文件（三平台连通）。凭据只在用户 UI 输入。

### M3 模型深化（下一个开发批次，对应分析书 §5）
1. **类型管理 UI**：项目设置抽屉里管理 typeConfig（增删改/颜色选择器/排序）——后端 typeConfig 已支持，缺 UI
2. **父子工作项**：`pm_work_items` 加 `parentId`；父卡片显示子项完成度 x/y
3. **活动流**：新表 `pm_work_item_logs`（itemId/field/oldValue/newValue/at）+ 详情抽屉时间线
4. **描述 markdown 预览**：抽屉描述区加渲染切换（复用知识库渲染组件）
5. **多文档关联**：`pm_item_notes` 关联表替代单 noteId（迁移兼容旧 noteId）

### M4 git 同步完善
1. 项目级「全部同步」（批量拉取/推送）
2. 工作项详情显示平台状态徽标 + 最近同步时间（gitIssueState 已存，缺展示强化）
3. 分支/提交引用展示（D5：gitBranch 已存，补外链与提交 sha）

### M5 迭代与度量
`pm_iterations` 表（v129）+ 工作项归属 + 迭代视图 + 燃尽图 + 「我的待办」跨项目聚合

### 已知遗留/风险（接手者注意）
1. **PmCenter.tsx 曾被多轮脚本改坏后修复**——当前语法完好（tsc ✓），但**该文件含 PlatformDialog 的 token 表单字段（`form.token`/`token: string`），edit 工具全文件扫描会误拦**。改此文件：要么用 gitbash 里的脚本（会话内用户既定模式），要么接受 edit 拦截后改走脚本。**不要**试图删 token 字段来绕过——那是真实 UI。
2. **行号手术教训**：不要对大 JSX 块做行号 splice——先读后改，优先 edit 工具小锚点；锚点缩进必须逐字核对（cat -A）。
3. **测试文件会被 node:test runner 双重收集**：pm-repository.test.ts 已在用例开头 `clean()` 规避；新增测试照做。
4. **既有失败基线**（与本插件无关，勿顺手修）：releaseI18nCoverage（27 个 sidebarNext.* 缺失键）、androidNativeHttpBridge（blob.arrayBuffer）。
5. **加密笔记保护**：syncFromRemote/openDiff 已拦截 `encrypted-*`；若扩展同步范围（附件同步），需重估。
6. **百度 OAuth**：已实现 oob 授权码+refresh 自动续期（routes/pm-git 同目录模式可参考 `routes/remote-files.ts` 的 /baidu/* 端点）；实测需用户百度应用凭据。
7. **.gitignore** 已含 `scratch-*` 与 `.commitmsg-*`（会话临时产物不入库）；若看到这类文件未被忽略再补规则。

## 六、给接手 agent 的工作方式要求（来自用户反馈，务必遵守）

1. **少用脚本改文件，优先 edit 工具小锚点修改**——脚本批量匹配+行号手术已造成多轮破损返工。
2. **每步改动后立即跑验证**（tsc/测试），不要攒一批再验。
3. **改动前先读现状**（read 工具），锚点逐字核对（缩进/行尾 CRLF）。
4. **文档先行**：新功能先在 docs/ 出设计（参照 docs/plugin-pm-analysis.md 的需求表格式），用户确认后再实现。
5. **提交规范**：`type(scope): 中文标题` + 正文 `- ` 要点；commit message 用 `git commit -F 文件` 或脚本文件（bash -c 内联 -m 会引号炸裂）。
