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
    expect(sidebar).toContain('(variant !== "mobile" || !mobileControlsCollapsed)');
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
    expect(sidebar).toContain("<KnowledgeTreePanel");
    expect(sidebar).toContain("<MobileKnowledgeTreePanel");
  });

  it("脑图中心不再出现在主导航（导图是树内文档）", () => {
    const rail = read("../../components/NavRail.tsx");
    expect(rail).not.toContain('mode: "mindmaps"');
  });

  it("桌面端 Rail 收敛工具组，工具入口在侧栏底部工具条", () => {
    const rail = read("../../components/NavRail.tsx");
    expect(rail).toContain('variant === "desktop" && item.group === "tools"');
    const sidebar = read("../../components/Sidebar.tsx");
    expect(sidebar).toContain('data-sidebar-toolbar=""');
    for (const mode of ["tasks", "diary", "ai-chat", "shares"]) {
      expect(sidebar).toContain(`mode: "${mode}" as const`);
    }
  });

  /**
   * 方案 B（B1）：Rail 只切侧栏面板，不替换主区。
   * 注意：侧栏底部工具条在 B2（主区页签 + 顶栏工具菜单）完成前必须保留，
   * 否则桌面端待办/小记/AI 会失去入口 —— 上面那条断言因此仍然有效。
   */
  it("方案 B·B1：五个侧栏面板 + 账号菜单集中账号级入口", () => {
    const rail = read("../../components/NavRail.tsx");
    expect(rail).toContain("RAIL_SIDEBAR_PANELS");
    expect(rail).toContain("actions.setSidebarPanel(panel.id)");
    for (const panel of ['id: "tree"', 'id: "tags"', 'id: "fav"', 'id: "trash"', 'id: "files"']) {
      expect(rail).toContain(panel);
    }

    const sidebar = read("../../components/Sidebar.tsx");
    expect(sidebar).toContain('state.sidebarPanel === "tags"');
    expect(sidebar).toContain("<SidebarTagsPanel");
    expect(sidebar).toContain("<SidebarFavoritesPanel");
    expect(sidebar).toContain("<SidebarTrashPanel");
    expect(sidebar).toContain("<SidebarAttachmentsPanel");

    const account = read("../../components/RailUserMenu.tsx");
    expect(account).toContain("OPEN_WORKSPACE_SWITCHER_EVENT");
    expect(account).toContain("OPEN_SHORTCUT_HELP_EVENT");
    // 收藏/回收站/附件已升为 Rail 面板，不再走账号菜单的整页入口；分享待 B2 页签接管。
    expect(account).not.toContain('openFullPage("favorites")');
    expect(account).not.toContain('openFullPage("trash")');
    expect(account).not.toContain('openFullPage("files")');
    expect(account).toContain('openFullPage("shares")');
  });
});
