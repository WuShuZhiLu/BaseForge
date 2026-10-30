# 方案：统一路由所有者（墓碑根治）

> 状态：待用户审批。批准前不动代码。
> 背景：`8c9f2a769` 的墓碑（1.5s 窗口）只是补丁。本文是根治方案。

## 1. 病根

当前「状态 ⇄ URL」是**多所有者双向绑**，三套写侧 effect 互相设防：

| 写侧（状态 → URL） | 位置 | 职责 |
|---|---|---|
| W1 | NoteDeepLinkBridge effect-2 | activeNote/viewMode → `/notes/:id` 或清 `/` |
| W2 | App.tsx ×4 effect | mindmaps/sheets/issues/module 路径各自同步、离开各清 `/` |
| W3 | 命令式散点 | pushSheetAppPath ×6 文件、pushMindMapAppPath、pushNoteAppPath、WorkspaceIssues 等 |

读侧（URL → 状态）也有两个监听者：`NoteDeepLinkBridge.applyRoute`（/notes 加载）与 `App.tsx applyRoute`（sheets/mindmaps/issues/module）。

**复活加载的机制**：关光页签 → activeNote=null → W1 想把 URL 清回 `/`，但同一提交里读侧 applyRoute（事件或 effect 重跑）抢先看到仍是 `/notes/:id` 的 URL，把它当**深链意图**重新 loadNote → 笔记复活、pending 又拦住 W1 的清理。墓碑 = 用时间窗猜「这不是意图」，猜错边界就是下一个 bug（popstate 特赦就是这么来的）。

本质：URL 的「意图」和「回声」没有区分。谁写的 URL、为什么写，读侧一律当意图处理。

## 2. 目标架构：单一 RouteOwner（单向流 + 自回声抑制）

```
用户点击 ──push/replace──▶ URL ──事件──▶ RouteOwner.parse ──▶ dispatch 状态
                                                             │
状态变化 ──▶ RouteOwner.urlFromState(state) ──reconcile──▶ URL（若不一致才写）
```

- **唯一读侧**：RouteOwner 订阅 popstate + APP_PATH_CHANGED_EVENT，把 pathname 解析为 union Route：
  `{kind:"note"|"sheet"|"mindmap"|"issue"|"module"|"home", id?}`
  按 kind 单点分发（note→loadNote 深链；sheet→viewMode all+activeNote null；mindmap/issues/module→setViewMode；home+popstate→清 activeNote）。
- **唯一写侧**：`urlFromState(state)` 纯函数，由状态派生期望 URL（优先级 activeNote>/notes/:id → sheet → mindmap → issue → module 路径 → `/`），单一 effect reconcile。
- **自回声抑制**：`APP_PATH_CHANGED_EVENT` 的 detail 里已有 `appPath`。RouteOwner 记住自己刚写的期望 URL，事件 appPath === 期望值时不回灌状态（外部导航 popstate / 他人命令式 push 不等于期望值，正常处理）。**墓碑与 1.5s 时间窗整体删除**。
- 命令式入口（pushSheetAppPath 等 6 文件调用点）**不动**——它们 push URL 后由 RouteOwner 统一消费，天然收敛。

## 3. 分阶段落地

### 阶段 1（本次，预计一批提交）
1. 新增 `lib/appRoute.ts`：Route union + `parseAppRoute(pathname)` + `urlFromRoute`；迁移 App.tsx 的 MODULE_APP_PATHS/VIEW_MODE_APP_PATHS 与三个 deepLink 的 parse。
2. 新增 `state.route`（AppContext）：`{ kind, id }`，reducer SET_ROUTE。App.tsx 的 sheetRoute/issueRoute/mindMapRoute 本地 state 全部收编（isSheetView 等读 state.route）。
3. 新增 `components/AppRouteSync.tsx` 取代 NoteDeepLinkBridge（深链加载逻辑原样搬入 owner 分发支路）。
4. 删 App.tsx 的 4 个写侧 effect + applyRoute、NoteDeepLinkBridge 两 effect 与墓碑、`noteClosedAtRef`。
5. 契约测试同步：AppMindMapRoute.test（锁 App.tsx 字面量）、NoteDeepLinkBridge.close.test、runtimeWiringContract 相关断言。

**验收**：关光页签 → URL 与主区同时归位（无墓碑依赖）；刷新/前进/后退恢复各视图不回归；复测原 bug 路径（逐条关页签、深链 404、sheet/mindmap 进出、/issues 详情）。

### 阶段 2（另批，不在本次）
- 工具页签（ToolTabKey）纳入 URL；移动端 mobileView 纳入；导航 API 化后 `navigateToAppPath` 整页重载仅剩 public 路由。

## 4. 风险与对策

- **回声抑制漏判**（写完 URL 又当外部事件回灌 → 循环）：抑制按「appPath === 期望值」精确匹配，popstate 无 detail 恒走意图分支；jsdom 契约测试覆盖。
- **React 提交时序**（原 pendingRouteNoteIdRef 解决的「onSuccess 清早了」）：owner 内保留 pending 语义，但只服务 note 深链支路，不再与其它 effect 竞争。
- **改动面**：App.tsx 路由块、NoteDeepLinkBridge（整体吸收）、AppContext（+route state）、6 个命令式调用点零改动。
- **不破坏**：非破坏性铁律——所有入口行为保持（打开/关闭/刷新/后退表现不变，只有 URL 复活这一 bug 行为被移除）。
