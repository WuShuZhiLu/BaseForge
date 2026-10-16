# 插件贡献点：侧栏面板（sidebarPanels）与活动栏徽章（activityBadges）

> 契约版本：`contribution-contract.json` v5（since 2.2）。本文是**契约先行**说明：类型与约束已在
> `@nowen/plugin-sdk`（`packages/nowen-plugin-sdk`）落地；宿主运行链路（后端清单校验白名单、
> 前端面板/徽章渲染）由主线按此契约后续接线，插件在接线完成前声明这两类贡献点不会生效。

## 一、sidebarPanels（侧栏面板）

让插件向侧栏面板容器（VS Code 式：面板可折叠 / 排序 / 隐藏 / 添加）贡献一个**声明式面板**：
宿主负责渲染面板头（标题 / 折叠 / ⋯ 菜单）与布局位置，插件声明元数据与内容入口。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 插件内唯一；实际命名空间为 `<pluginId>/<contributionId>` |
| `title` | string | 面板标题（宿主面板头展示） |
| `icon` | string | 线性图标标识（宿主图标集内的名称，禁 emoji） |
| `entry` | string | 面板内容入口（宿主沙箱内加载的资源路径） |
| `mount` | string | 挂载方式（宿主当前支持 `host-rendered`；其他值预留） |
| `defaultVisible` | boolean | 首次安装后是否默认显示（默认 `false`） |
| `order` | number | 默认排序权重（越小越靠前） |

约束：每个插件最多 **10** 个面板（`SIDEBAR_PANEL_CONTRIBUTION_LIMITS.maxPanelsPerPlugin`）；
仅 `declarative` 运行时（无需执行插件代码，宿主直接渲染）。

## 二、activityBadges（活动栏徽章）

让插件在左侧活动栏「更多」折叠组里贡献一个**入口徽章**。徽章只是入口，不承载内容；
点击行为由 `target` 决定。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 插件内唯一（命名空间同上） |
| `title` | string | 徽章 tooltip / 无障碍名 |
| `icon` | string | 线性图标标识 |
| `target` | object | `{"panel": "<面板id>"}` 打开面板；或 `{"tool": "<工具页签key>"}` 打开工具页签 |
| `order` | number | 「更多」组内排序权重 |

约束：每个插件最多 **10** 个徽章（`ACTIVITY_BADGE_CONTRIBUTION_LIMITS.maxBadgesPerPlugin`）；
`target` 仅允许 `panel` / `tool` 两种（`ACTIVITY_BADGE_CONTRIBUTION_LIMITS.targets`）。
徽章可被用户移除（只移除入口，不删功能），与固定 5 徽章（文档树/标签/收藏/回收站/附件）互不影响。

## 三、示例 manifest 片段

```json
{
  "contributes": {
    "sidebarPanels": [
      {
        "id": "reading-list",
        "title": "阅读清单",
        "icon": "book-open",
        "entry": "panels/reading-list.html",
        "mount": "host-rendered",
        "defaultVisible": false,
        "order": 20
      }
    ],
    "activityBadges": [
      {
        "id": "reading-list-entry",
        "title": "阅读清单",
        "icon": "book-open",
        "target": { "panel": "reading-list" },
        "order": 20
      },
      {
        "id": "quick-todo-entry",
        "title": "待办",
        "icon": "check-square",
        "target": { "tool": "tasks" },
        "order": 30
      }
    ]
  }
}
```

## 四、接线状态（2026-10-16）

| 层 | 状态 |
|---|---|
| SDK 契约与类型（本包） | ✅ 已落地（contractVersion 5，手工同步自 `contribution-contract.json`，生成器脚本不在仓库内） |
| 后端清单校验（`backend/src/plugins/manifest.ts` 的 contributes 白名单） | ⏳ 待宿主接线（当前白名单不含新类型，声明不会通过校验） |
| 前端渲染（面板容器 / 活动栏徽章区消费插件贡献） | ⏳ 待宿主接线 |
