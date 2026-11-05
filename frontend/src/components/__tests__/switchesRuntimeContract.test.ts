import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「设置 → 开关」面板的运行时契约。
 *
 * 这四条都是用户拍板的裁决，容易被后续改动悄悄改回去，所以钉成测试：
 *   1. 桌面端快捷浏览开关已删除（唯一消费点在不会渲染的分支里，点了没反应）；
 *   2. 移动端专有项只在移动端运行时出现，桌面端不再列出用不上的开关；
 *   3. 「关闭网页端页面」是站点级配置，只有管理员可见；
 *   4. 顶部页签栏与其开关已删除，打开列表只由侧栏「打开的编辑器」承载。
 */
const settingsSource = readFileSync(path.resolve(__dirname, "../SettingsModal.tsx"), "utf8");
const zhSource = readFileSync(path.resolve(__dirname, "../../i18n/locales/zh-CN.json"), "utf8");
const enSource = readFileSync(path.resolve(__dirname, "../../i18n/locales/en.json"), "utf8");
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), "utf8");

function switchesPanelSource(): string {
  const start = settingsSource.indexOf("function SwitchesPanel()");
  const end = settingsSource.indexOf("function AppearancePanel()");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return settingsSource.slice(start, end);
}

describe("settings switches panel runtime contract", () => {
  it("no longer ships the desktop quick-browse switch", () => {
    const panel = switchesPanelSource();
    expect(panel).not.toContain("desktop-knowledge-tree");
    expect(panel).not.toContain("desktopKnowledgeTreeMode");
    expect(panel).not.toContain("DesktopKnowledgeTreeViewMode");
    // 底部偏好读写函数仍归 SidebarMobile 使用，但设置里不得再出现这两个文案键。
    expect(zhSource).not.toContain('"desktopKnowledgeTreeMode"');
    expect(enSource).not.toContain('"desktopKnowledgeTreeMode"');
  });

  it("renders mobile-only switches only in a mobile runtime", () => {
    const panel = switchesPanelSource();
    expect(panel).toContain("const isMobileRuntime = isAndroidNativeRuntime() || narrowViewport");
    expect(panel).toContain('window.matchMedia("(max-width: 767px)")');
    // 两个移动端开关必须整体被 isMobileRuntime 包住，而不是各自散落在外面。
    const gate = panel.indexOf("{isMobileRuntime && (");
    const firstMobileSwitch = panel.indexOf('data-settings-switch="mobile-knowledge-tree"');
    const secondMobileSwitch = panel.indexOf('data-settings-switch="mobile-knowledge-tree-compact"');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(firstMobileSwitch).toBeGreaterThan(gate);
    expect(secondMobileSwitch).toBeGreaterThan(firstMobileSwitch);
  });

  it("shows the site-level web UI toggle to admins only", () => {
    const panel = switchesPanelSource();
    const adminGate = panel.indexOf("{isAdmin && (");
    const toggle = panel.indexOf('data-settings-switch="web-ui-enabled"');
    expect(adminGate).toBeGreaterThanOrEqual(0);
    expect(toggle).toBeGreaterThan(adminGate);
    // 非管理员连站点配置都不该请求。
    expect(panel).toContain("if (!admin) return;");
    expect(panel).toContain("api.getSiteSettings()");
  });

  it("drops the top note-tabs switch and keeps open-list ownership in the sidebar", () => {
    // 开关与文案键都已移除，设置里不能再出现。
    expect(switchesPanelSource()).not.toContain("enableNoteTabs");
    expect(zhSource).not.toContain('"enableNoteTabs"');
    expect(enSource).not.toContain('"enableNoteTabs"');

    // 页签栏组件本身删除，分屏视图不再挂载它。
    expect(existsSync(path.resolve(__dirname, "../NoteTabsBar.tsx"))).toBe(false);
    const splitView = read("../EditorSplitView.tsx");
    expect(splitView).not.toContain("<NoteTabsBar");
    expect(splitView).not.toContain("data-editor-split-tabs");

    // 打开列表恒记录，不再被偏好门控——否则去掉开关后侧栏面板会永远是空的。
    expect(read("../AppRouteSync.tsx")).not.toContain("prefs.enableNoteTabs");
    const noteList = read("../NoteList.tsx");
    expect(noteList).not.toContain("userPrefs.prefs.enableNoteTabs");

    // 能力归属：侧栏「打开的编辑器」照旧提供切换与关闭。
    const openEditors = read("../sidebar/panels/OpenEditorsPanel.tsx");
    expect(openEditors).toContain("data-open-note-row={tab.id}");
    expect(openEditors).toContain("actions.closeNoteTab(");
  });
});
