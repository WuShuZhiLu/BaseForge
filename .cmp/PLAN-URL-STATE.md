# PLAN-URL-STATE：全应用状态 URL 化（除 PM 插件）

> 原则（架构铁律）：**新增任何可导航状态，必须同步设计 URL 形态**——URL 是
> 状态的唯一真相，刷新/前进后退/直开链接/AI 导航一律天然恢复。
> 范围：除 PM 插件（projects 及其内部状态）外的一切可导航 UI 状态。
> 基线：/notes /sheets /mindmaps /issues /favorites /trash /files /shares
> /projects /tasks /diary /ai /plugins /kb/:id[/notes/:n] 已入 URL（aec4416ac）。

## 批次 ①：搜索 URL 化（AI/API 价值最高）

- **URL**：`/search?q=关键词`（`q` 缺省 = 空搜索态）
- **读侧**：parseAppRoute 解析 → route `{kind:"search", q}` → 消费者
  （SidebarDesktop 搜索框）从 route 回灌 query 并展开结果弹层
- **写侧**：query 防抖变化 → reconcile `replace`（搜索是高频中间态，不污染历史）
- **范围联动**：知识库进入态下 `?scope=kb|all`（复用现有库内/全空间胶囊）
- **涉及**：appRoute.ts（SearchRoute + q 解析）、AppRouteSync（写侧 replace +
  search 视图分支）、SidebarDesktop（query 回灌、`t("sidebarNext.…")` 占位不变）

## 批次 ②：标签选中 `/tags/:tagId`

- 标签面板点击标签展开文档列表 → URL 跟随；直开链接恢复「该标签展开+滚动定位」
- 读侧：parseAppRoute `{kind:"tag", tagId}` → SidebarDesktop 回灌 tagOpen
- 写侧：toggleTag 展开时 push、折叠时 replace 回 `/panel/tags`
- **涉及**：appRoute.ts、AppRouteSync、SidebarDesktop（tagRows 区）

## 批次 ③：工具页签 `/tools/:toolKey`（B 线待办「工具页签持久化」的 URL 版）

- ToolTabKey：`tasks | diary | ai-chat | shares | files | trash`（projects 除外）
- 读侧：`/tools/:key` → setActiveToolTab(key) + viewMode 联动
- 写侧：setActiveToolTab 后 reconcile `push`（工具页签是显式导航）
- 与现有模块路径的关系：`/tasks` `/diary` 等模块路径保持兼容（别名），
  `/tools/:key` 作为规范形态逐步归一
- **涉及**：appRoute.ts、AppRouteSync、AppContext（activeToolTab 回灌）、ToolPageHost

## 批次 ④：query 参数类（挂现有资源路由之下）

统一机制先行：parseAppRoute 扩展 searchParams 解析；AppRouteSync.write 支持
query 组装；reconcile 各状态到 query 的映射表。

| 状态 | 形态 | 说明 |
|---|---|---|
| 编辑器分屏 | `/notes/:n?split=:otherId` | 读侧恢复双栏，关一侧 replace 移除参数 |
| 知识树筛选 | `/kb/:k?scope=note\|folder` | 现有筛选器入 query |
| 打开的页签集合 | **不入 URL** | 工作区会话概念，已有后端持久化；序列化进 URL 会让链接失去可分享性 |

## 明确排除

- **PM 插件内部状态**（项目列表选中、工作项详情、看板视图）——按你的要求排除；
  `/projects` `/tasks` 模块路径本身维持现状
- 弹窗类瞬态（导入对话框、模板选择、确认框）——不入 URL
- hover/草稿等纯瞬态——不入

## 实施约束（每批次共同）

1. 读侧唯一（AppRouteSync.dispatchRoute）+ 写侧唯一（reconcile），沿用
   自回声抑制；禁止组件内直写 history
2. 新路径必须同步 `serverUrl.ts` 路由后缀白名单（/kb 的教训）
3. 每批次：tsc + 相关契约测试 + playwright 实测（刷新/前进后退/直开）后单独提交
4. 契约测试同步：AppRouteSync.close / AppMindMapRoute / runtimeWiringContract

## 建议顺序

①搜索 → ②标签 → ③工具页签 → ④query 批次（分屏、scope）。
①价值最高且路径最短；④需先落统一 query 机制。

## 批次 ⑥：知识库根具名 `/kb` + 文档 URL 携带知识库层级（2026-10-28）

背景：用户指出 `/` 作为知识库根是「唯一匿名模块」，且裸 /notes/:n 丢失库层级。
**第一版误用 /dashboard——用户纠正：语雀的 /dashboard 是独立工作台页，不是知识库；
本产品默认主区就是知识库，根路径应为 /kb。** 已改为 KB_ROOT_APP_PATH="/kb"，
/dashboard 与 / 一样降级为遗留入口。

### 改动

1. **知识库根具名 `/kb`**（appRoute.ts KB_ROOT_APP_PATH）
   - parseAppRoute：`/kb`、`/dashboard`、`/` 同解析为 home（后两者遗留只读不写）
   - 写侧一律写 /kb：AppRouteSync (0)(A0)(A 残留)(A2)(B)(C)、App.tsx 登录回跳/
     SheetEditor 关闭、SidebarDesktop exitKb/兜底、WorkspaceIssues、PublicNotebookView
   - (A2) 遗留根规整：home 且 pathname 为 / 或 /dashboard → replace /kb
   - (C) kb 层级保留条件 target===KB_ROOT_APP_PATH
   - serverUrl.ts 白名单加 kb、dashboard（遗留瞬态）
   - 层级贯通：/kb（库列表态）→ /kb/:k（进入库）→ /kb/:k/notes/:n（文档）
2. **文档深链规范化**（SidebarDesktop，树数据所有者处）
   - 裸 /notes/:n 且 docRootMap 有归属库且**本次加载未发生应用内前进导航**
     （hasInAppForwardNavigationOccurred，push/popstate 置位、replace 不计）→
     replace 成 /kb/:k/notes/:n
   - popstate 回退/退出库写入的裸路径不重写（不破坏后退链）
   - 刷新后规范化带来的副作用：退出库状态刷新会重新带上 kb 前缀（URL 即真相，接受）

### 测试

- AppRouteSync.close 用例①期望 /dashboard → /kb（已同步）
- AppMindMapRoute 契约断言 write("/", "replace") → write(KB_ROOT_APP_PATH, "replace")

### 未做（与用户对齐的取舍）

- 空间不进 URL：笔记/库 ID 全局唯一，深链可由 ID 反查空间；多空间协作化时再评估
  /w/:spaceId 前缀方案（方案 A）
- 文件夹层级不进 URL（语雀同样不含）

## 批次 ⑦：空间域进 URL（有空间归属的模块才带）

用户定则：**模块在前，空间在后；有空间归属的才带空间段，全局模块不带**。

| 形态 | 含义 |
|---|---|
| `/kb/:space` | 知识库模块根（space = personal / workspace uuid） |
| `/kb/:space/:kbId` | 进入某库 |
| `/kb/:space/:kbId/notes/:n` | 库内文档（完整层级） |
| `/kb/:space/notes/:n` | 空间内文档（退出库后仍开着文档） |
| `/trash/:space` `/favorites/:space` | 有空间归属（回收站/收藏查询按空间过滤） |
| `/issues/:space[/:issueId]` | issue 天生空间实体（workspaceId NOT NULL） |
| `/files` `/shares` `/projects` `/tasks` `/diary` `/ai` `/plugins` | 无空间归属，不加段 |
| `/search` `/tags` `/tools` `/settings` `/login` | 功能路由，不加段 |

配套机制：
- **空间真相 = URL**：读侧 applyRoute 发现路由 space ≠ 当前空间 → setCurrentWorkspace + 派发 nowen:workspace-changed（跨空间深链自动落到正确空间）
- **写侧规整**：(A2) `/`、`/dashboard`、`/kb`、旧树节点 id 深链（notebook: 前缀）→ `/kb/:space`；(A3) 空间域模块短形态补空间段
- **切空间 = 改写 URL 空间段**（SidebarDesktop.switchSpace），并收起旧空间的打开文档；无空间域路径上切空间只改本地状态
- issue 路径统一 `buildIssueAppPath(issueId, workspaceId)`（/issues/:space[/:id]）
- serverUrl 反代前缀白名单同步：`/kb/:space[/:kbId[/notes/:n]]`、`/(favorites|trash)/:space`、`/issues/:space[/:id]`
