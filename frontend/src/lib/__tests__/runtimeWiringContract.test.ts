import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(path.resolve(__dirname, relative), "utf8");

/**
 * 接线契约：1.5.1 里那些"文件搬了、但没有任何地方调用"的基础设施。
 *
 * 这些点在 tsc 与功能测试里都不会报错 —— 模块存在、类型正确，只是没人 import / 没人调：
 *   1) runtimePrelude（原始运行时垫片）必须在 runtimeCompatibility 之前执行；
 *   2) runtimeCompatibility 负责外观运行时引导 + 两个外观 CSS + 旧外观中和 + 字体守卫；
 *   3) HtmlPreviewPane 的样式表要跟着组件一起加载；
 *   4) 树面板用 isActiveKnowledgeTreeDocument 判定激活态（含导图节点）。
 * 一旦被摘掉，界面表现是"功能看不见/样式不对"，排查代价极高，故用契约锁住。
 */
describe("1.5.1 runtime wiring contract", () => {
  it("boots the runtime prelude before the compatibility graph", () => {
    const main = read("../../main.tsx").trimStart();
    expect(main.startsWith('import "./lib/runtimePrelude";')).toBe(true);
    expect(main.indexOf('import "./lib/runtimeCompatibility";')).toBeGreaterThan(
      main.indexOf('import "./lib/runtimePrelude";'),
    );
  });

  it("keeps the app appearance bootstrap chain wired in runtimeCompatibility", () => {
    const runtime = read("../runtimeCompatibility.ts");
    expect(runtime).toContain('import "../app-appearance.css";');
    expect(runtime).toContain('import "../app-appearance-neutral-compat.css";');
    expect(runtime).toContain("installRuntimePrelude();");
    expect(runtime).toContain("bootstrapAppAppearanceRuntime();");
    expect(runtime).toContain("installLegacyNoteAppearanceNeutralizer();");
    expect(runtime).toContain("installEditorFontAppearanceGuard();");
  });

  it("loads the HTML preview stylesheet with the component", () => {
    expect(read("../../components/HtmlPreviewPane.tsx")).toContain('import "./HtmlPreviewPane.css";');
  });

  it("marks tree nodes active through the shared model (notes and mind maps)", () => {
    for (const file of [
      "../../components/KnowledgeTreePanel.tsx",
      "../../components/MobileKnowledgeTreePanel.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain("isActiveKnowledgeTreeDocument");
      expect(source).toContain("getCurrentMindMapAppId");
    }
  });

  it("opens mind map nodes from the knowledge tree", () => {
    for (const file of [
      "../../components/KnowledgeTreePanel.tsx",
      "../../components/MobileKnowledgeTreePanel.tsx",
    ]) {
      expect(read(file)).toContain("pushMindMapAppPath(node.resourceId)");
    }
  });
});

describe("additive 1.5.1 feature wiring (user-approved)", () => {
  it("offers mind map creation in the tree create menu and opens it after create", () => {
    const menu = read("../../components/KnowledgeTreeCreateMenuRuntime.tsx");
    expect(menu).toContain('kind: "mindmap"');
    // 轻量表格本就有独立的菜单项（onCreateSheet：弹标题→建节点→跳 /sheets/:id），
    // 不得再往 CREATE_ITEMS 里加第二个（回归：曾因此出现重复菜单项）。
    expect(menu.split("<span>轻量表格</span>").length - 1).toBe(1);
    expect(menu).toContain("onCreateSheet");

    // 导图建完自动打开（另一条已锁行为，勿在此项改动时丢失）。
    for (const file of [
      "../../components/KnowledgeTreePanel.tsx",
      "../../components/MobileKnowledgeTreePanel.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain('snapshot.kind === "mindmap"');
      expect(source).toContain("pushMindMapAppPath(created.resourceId)");
    }

    // 表格数据 → Markdown 笔记导入（1.0.0：完善现有功能）。
    expect(menu).toContain('kind: "spreadsheet"');
    for (const file of [
      "../../components/KnowledgeTreePanel.tsx",
      "../../components/MobileKnowledgeTreePanel.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain('importSpreadsheetIntoKnowledgeTree');
      expect(source).toContain('"spreadsheet"');
    }
  });

  it("wires the mobile rail hide/restore loop", () => {
    expect(read("../../components/NavRail.tsx")).toContain('data-mobile-rail-hide=""');
    expect(read("../../App.tsx")).toContain("!mobileRailHidden && <NavRail variant=\"mobile\"");
    const sidebar = read("../../components/Sidebar.tsx");
    expect(sidebar).toContain('data-mobile-rail-show=""');
    expect(sidebar).toContain("useMobileRailHidden");
  });

  it("wires the mobile sidebar controls collapse", () => {
    const sidebar = read("../../components/Sidebar.tsx");
    expect(sidebar).toContain("setMobileControlsCollapsed(!mobileControlsCollapsed)");
    expect(sidebar).toContain('{variant === "mobile" && !mobileControlsCollapsed && (');
    expect(sidebar).not.toContain('{"Base Notes"');
    expect(read("../../components/KnowledgeTreePanel.tsx")).toContain('controlsCollapsed && "hidden"');
  });

  it("wires the sidebar text style setting end to end", () => {
    expect(read("../../components/settings/SidebarDisplaySettings.tsx")).toContain("setSidebarTextStyle");
    expect(read("../../components/SettingsModal.tsx")).toContain("<SidebarDisplaySettings />");
    for (const file of [
      "../../components/Sidebar.tsx",
      "../../components/NavRail.tsx",
      "../../components/KnowledgeTreePanel.tsx",
      "../../components/MobileKnowledgeTreePanel.tsx",
      "../../components/NoteList.tsx",
    ]) {
      expect(read(file)).toContain("classicText");
    }
  });
});

describe("sync domain wiring contract (runtime audit 2026-10-13)", () => {
  const be = (relative: string) =>
    readFileSync(path.resolve(__dirname, "../../../../backend/src/" + relative), "utf8");

  it("guards yjs collaboration for encrypted notes and blocks", () => {
    for (const file of ["services/yjs.ts", "services/yjs-subdocuments.ts"]) {
      const source = be(file);
      expect(source).toContain("assertEncryptedBlockCollaborationAllowed");
      expect(source).toContain("ENCRYPTED_NOTE_COLLABORATION_FORBIDDEN");
    }
  });

  it("accepts the proxy-compatible websocket aliases and the probe frame", () => {
    const realtime = be("services/realtime.ts");
    expect(realtime).toContain('"/public/ws"');
    expect(realtime).toContain('url.searchParams.get("probe") === "1"');
  });

  it("reconnects the realtime channel when the server endpoint changes", () => {
    const source = read("../../lib/realtime.ts");
    expect(source).toContain("getResolvedWebSocketUrl");
    expect(source).toContain("SERVER_ENDPOINT_CHANGED_EVENT");
    expect(source).toContain("reconnectForEndpoint");
  });
});

describe("知识库优先 IA 契约（2026-10-14 用户拍板）", () => {
  it("侧栏主体是知识树面板（桌面/移动各自变体）", () => {
    const sidebar = read("../../components/Sidebar.tsx");
    expect(sidebar).toContain("<TreePanelContent");
    expect(sidebar).toContain("mode={desktopKnowledgeTreeMode");
  });

  it("脑图中心不再出现在主导航（导图是树内文档）", () => {
    const rail = read("../../components/NavRail.tsx");
    expect(rail).not.toContain('mode: "mindmaps"');
  });

  it("桌面端 Rail 收敛工具组；工具入口在活动栏徽章区（原型口径：侧栏底部不再有工具条）", () => {
    const rail = read("../../components/NavRail.tsx");
    expect(rail).toContain('variant === "desktop" && item.group === "tools"');
    // 侧栏底部工具条已按原型移除（工具入口 = 固定 5 徽章 + 「更多」组里的工具徽章）
    const sidebar = read("../../components/Sidebar.tsx");
    expect(sidebar).not.toContain('data-sidebar-toolbar');
    const badges = read("../../components/sidebar/ActivityBarBadges.tsx");
    for (const mode of ["tasks", "diary", "ai-chat", "shares"]) {
      expect(badges).toContain(`id: "${mode}"`);
    }
  });

  /**
   * 方案 B（B1）：Rail 只切侧栏面板，不替换主区。
   * 注意：侧栏底部工具条在 B2（主区页签 + 顶栏工具菜单）完成前必须保留，
   * 否则桌面端待办/小记/AI 会失去入口 —— 上面那条断言因此仍然有效。
   */
  it("方案 B·B1：侧栏面板 + 账号菜单集中账号级入口 + 活动栏徽章区", () => {
    const rail = read("../../components/NavRail.tsx");
    // S2：桌面活动栏徽章区由 B 线实现（ActivityBarBadges），Rail 不再内置单选面板清单
    expect(rail).toContain("<ActivityBarBadges");
    // 左下角设置入口必须保留（用户 2026-10-16 明确）
    expect(rail).toContain("setShowSettings(true)");

    const badges = read("../../components/sidebar/ActivityBarBadges.tsx");
    // 固定徽章 = 文档树/标签/收藏/回收站/附件；其余收进可折叠「更多」
    expect(badges).toContain("FIXED_BADGE_IDS");
    expect(badges).toContain("updateSidebarBadges");
    expect(badges).toContain("extraCollapsed");
    expect(badges).toContain('data-activity-badges');
    expect(badges).toContain('data-activity-badge-more');
    expect(badges).toContain('data-activity-badge-add');

    const sidebar = read("../../components/Sidebar.tsx");
    // 面板框架 S1 接管后：Sidebar 通过容器渲染面板；B1 的「单选 sidebarPanel」退化为兼容桥
    // （切到某面板 → 在容器中显示并展开它），标签面板仍由 Sidebar 注入交互回调。
    expect(sidebar).toContain("<SidebarPanelContainer");
    expect(sidebar).toContain("<TagsPanelContent");
    expect(sidebar).toContain("updateSidebarPanel(id as never, { visible: true, collapsed: false })");
    // 移动端分支保持原样（B3 未启动）
    expect(sidebar).toContain("<MobileKnowledgeTreePanel />");

    const account = read("../../components/RailUserMenu.tsx");
    expect(account).toContain("OPEN_WORKSPACE_SWITCHER_EVENT");
    expect(account).toContain("OPEN_SHORTCUT_HELP_EVENT");
    // B2 页签系统接管后，账号菜单不再承担任何整页入口（分享/附件/回收站/收藏全部走页签或 Rail 面板）
    expect(account).not.toContain("openFullPage");
    expect(account).not.toContain("data-account-full-pages");
  });

  /**
   * 方案 B（B2）：主区页签系统。
   * 用户 2026-10-14 明确：**不要第二行顶栏、不要新增搜索框**——
   * 工具页签并进编辑器既有页签行（NoteTabsBar），顶栏沿用既有抬头（仅风格统一）。
   */
  it("方案 B·B2：工具页签并入既有页签行（单行，无独立顶栏）", () => {
    const ctx = read("../../store/AppContext.tsx");
    expect(ctx).toContain("export type ToolTabKey");
    expect(ctx).toContain("openToolTabs: ToolTabKey[]");
    expect(ctx).toContain("activeToolTab: ToolTabKey | null");
    expect(ctx).toContain('case "OPEN_TOOL_TAB"');
    expect(ctx).toContain('case "CLOSE_TOOL_TAB"');
    expect(ctx).toContain("openToolTab: (key: ToolTabKey)");

    // 页签搬到侧栏「打开的」面板（VS Code OPEN EDITORS）；面板框架 S1 后它只是面板内容之一。
    const openEditors = read("../../components/sidebar/panels/OpenEditorsPanel.tsx");
    expect(openEditors).toContain("data-open-note-row={tab.id}");
    expect(openEditors).toContain("data-open-tool-row={key}");
    expect(openEditors).toContain("actions.closeNoteTab(tab.id)");
    expect(openEditors).toContain("actions.closeToolTab(key)");
    expect(openEditors).toContain("actions.setActiveToolTab(key)");
    // 内容-only：不再自带标题/折叠（由面板框架 Shell 提供）
    expect(openEditors).not.toContain("COLLAPSED_KEY");

    // 面板内容层 v1（新实现，替换旧挂载；旧文件保留）
    const contentIndex = read("../../components/sidebar/panels/index.tsx");
    expect(contentIndex).toContain("PANEL_CONTENT");
    for (const id of ["openEditors", "fav", "files"]) {
      expect(contentIndex).toContain(id + ": ");
    }
    const shared = read("../../components/sidebar/panels/shared.tsx");
    expect(shared).toContain("export function usePanelRefresh");
    expect(shared).toContain("export function PanelRow");
    expect(shared).toContain("nowen:sidebar-panel-refresh");
    expect(read("../../components/sidebar/panels/openNote.ts")).toContain("openNoteFromSidebarPanel");

    // 面板框架（S1）：布局 store + 容器 + 外壳 + 注册表
    const store = read("../../lib/sidebarPanels.ts");
    expect(store).toContain("export function readSidebarLayout");
    expect(store).toContain("export function updateSidebarPanel");
    expect(store).toContain("export function updateSidebarBadges");
    expect(store).toContain("export function subscribeSidebarLayout");
    expect(store).toContain("SIDEBAR_LAYOUT_EVENT");
    expect(store).toContain("nowen.sidebar.layout.v1");
    // 文档树固定：不可隐藏
    expect(store).toContain('next.panels.tree.visible = true');

    const registry = read("../../components/sidebar/panelRegistry.tsx");
    // 原型口径：文档树头部 = 新建 ＋ 更多（fixed 不可关）；顺序 = 打开的在上、文档树其次
    // 迁移期：树自身工具栏保留 ＋/⋯，面板头不重复（actions 为空数组）
    expect(registry).toContain("actions: [],");
    expect(store).toContain("openEditors: { visible: true, collapsed: true, order: 0 }");
    expect(store).toContain("tree: { visible: true, collapsed: false, order: 1 }");
    // 动作按特性：文档树 fixed/closable:false 且只有 more；打开的只有 refresh
    expect(registry).toContain("closable: false");
    expect(registry).toContain("fixed: true");
    expect(registry).toContain('actions: ["refresh"]');

    const container = read("../../components/sidebar/SidebarPanelContainer.tsx");
    expect(container).toContain('data-sidebar-panels-container=""');
    expect(container).toContain('data-sidebar-panel-list-button=""');
    expect(container).toContain('data-sidebar-panel-reset=""');
    expect(container).toContain("resetSidebarLayout()");
    expect(container).toContain("reorderSidebarPanels(order)");
    expect(container).toContain("PANEL_CONTENT[id]");
    // 面板头计数必须真的传下去（曾因改写丢失 count={count} 导致计数不显示）
    expect(container).toContain("count={count}");
    expect(container).toContain("reportedCounts[definition.id]");

    const shell = read("../../components/sidebar/SidebarPanelShell.tsx");
    expect(shell).toContain("data-sidebar-panel-head={definition.id}");
    for (const action of ["new", "refresh", "more"]) {
      expect(shell).toContain(`data-sidebar-panel-action="${action}"`);
    }
    // 头部不得出现 ✕（关闭在 ⋯ 菜单里）
    expect(shell).not.toContain("关闭面板\"\n            className");

    const sidebar = read("../../components/Sidebar.tsx");
    expect(sidebar).toContain("<SidebarPanelContainer");

    // 主区不得再渲染横向页签行（顶栏与格式化工具栏必须直接相邻）
    const editorForTabs = read("../../components/EditorPane.tsx");
    expect(editorForTabs).not.toContain("<NoteTabsBar");

    // 不得再引入独立顶栏组件（MainTopBar 已删除）；App 只保留既有编辑器抬头
    const app = read("../../App.tsx");
    expect(app).not.toContain("MainTopBar");
    expect(app).toContain("state.activeToolTab ? (");
    expect(app).toContain("<ToolPageHost tool={state.activeToolTab} />");

    // 既有编辑器抬头：风格与页签/工具统一（py-1.5、hover pill、圆角图标组）
    const editor = read("../../components/EditorPane.tsx");
    expect(editor).toContain("px-4 py-1.5 border-b border-app-border bg-app-surface/30");
    expect(editor).toContain("rounded-lg px-2 text-[12.5px] text-tx-secondary transition-colors hover:bg-app-hover");
    expect(editor).toContain("gap-0.5 bg-app-hover/50 rounded-lg px-1 py-0.5");

    const host = read("../../components/ToolPageHost.tsx");
    // keepAlive 挂载：所有已打开工具页签同时挂载，非激活用 hidden 隐藏
    expect(host).toContain('data-tool-page={key}');
    expect(host).toContain('data-tool-page-active');
    expect(host).toContain("TOOL_PAGE_NAVIGATE_EVENT");
    for (const component of [
      "<TaskCenter />",
      "<DiaryCenter />",
      "<AIChatPanel",
      "<ShareManagementPage />",
      "<FileManager />",
      "<TrashPage />",
    ]) {
      expect(host).toContain(component);
    }
  });
});
