import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(path.resolve(__dirname, "../SidebarMobile.tsx"), "utf8");
const quickPanelSource = readFileSync(path.resolve(__dirname, "../MobileKnowledgeTreePanel.tsx"), "utf8");
const treePanelSource = readFileSync(path.resolve(__dirname, "../KnowledgeTreePanel.tsx"), "utf8");
const expansionSource = readFileSync(path.resolve(__dirname, "../../lib/knowledgeTreeExpansion.ts"), "utf8");
const settingsSource = readFileSync(path.resolve(__dirname, "../SettingsModal.tsx"), "utf8");
const modeSource = readFileSync(path.resolve(__dirname, "../../lib/mobileKnowledgeTreeViewMode.ts"), "utf8");
const zhSource = readFileSync(path.resolve(__dirname, "../../i18n/locales/zh-CN.json"), "utf8");

describe("desktop knowledge tree browsing mode", () => {
  it("defaults desktop to the recursive tree and persists independently from mobile", () => {
    expect(modeSource).toContain('export type DesktopKnowledgeTreeViewMode = "quick" | "tree"');
    expect(modeSource).toContain('DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY = "baseforge.desktopKnowledgeTree.viewMode.v1"');
    expect(modeSource).toContain('return value && DESKTOP_VALID_MODES.has(value) ? value : "tree"');
    expect(modeSource).toContain("DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT");
  });

  it("no longer exposes a desktop quick-browse switch in Settings", () => {
    // 该项唯一消费点是 SidebarMobile 的 variant="desktop" 分支，而该组件目前只以
    // variant="mobile" 挂在移动抽屉里，桌面端点开关没有任何效果。设置里已移除，
    // 只剩底层偏好读写函数给 SidebarMobile 使用。
    expect(settingsSource).not.toContain('data-settings-switch="desktop-knowledge-tree"');
    expect(settingsSource).not.toContain("saveDesktopKnowledgeTreeViewMode");
    expect(settingsSource).not.toContain("loadDesktopKnowledgeTreeViewMode");
    expect(settingsSource).not.toContain("desktopKnowledgeTreeMode");
    expect(zhSource).not.toContain('"desktopKnowledgeTreeMode"');
  });

  it("switches only the desktop sidebar surface", () => {
    expect(sidebarSource).toContain("loadDesktopKnowledgeTreeViewMode");
    expect(sidebarSource).toContain('desktopKnowledgeTreeMode === "quick"');
    expect(sidebarSource).toContain("<TreePanelContent");
    expect(sidebarSource).toContain('mode={desktopKnowledgeTreeMode === "quick" ? "quick" : "full"}');
    expect(quickPanelSource).toContain('variant = "mobile"');
    expect(quickPanelSource).toContain('data-baseforge-desktop-knowledge-tree={variant === "desktop" ? "quick-navigation" : undefined}');
  });

  it("keeps user expansion state authoritative across refreshes and remounts", () => {
    expect(treePanelSource).toContain("useSyncExternalStore");
    expect(treePanelSource).toContain("initializeKnowledgeTreeExpansion");
    expect(treePanelSource).not.toContain("ancestorIds.add(parent.id)");
    expect(expansionSource).toContain("hasUserHistory");
    expect(expansionSource).toContain("getKnowledgeTreeExpansionScope");
    expect(expansionSource).toContain("saveKnowledgeTreeExpansion");
  });

  it("records tree-view opens for the shared recent list", () => {
    expect(treePanelSource).toContain("saveMobileKnowledgeTreeRecentEntries");
    expect(treePanelSource).toContain("rememberOpened(node.id)");
  });

  it("shows the Ctrl+K search hint only in desktop quick browse", () => {
    expect(quickPanelSource).toContain('variant === "desktop" && !compactToolbar && (');
    expect(quickPanelSource).toContain('aria-label="快捷键 Ctrl+K"');
    expect(quickPanelSource).toContain("Ctrl K");
  });

  it("reveals quick-browse row actions only on hover outside mobile", () => {
    expect(quickPanelSource).toContain('const actionVisibility = multiSelectMode ? "hidden" : variant === "mobile" ? "flex" : "hidden group-hover:flex";');
    expect(quickPanelSource.match(/actionVisibility/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps desktop quick-browse hover rows limited to create and more actions", () => {
    expect(quickPanelSource).toContain('const desktopHoverHidden = variant === "desktop" ? "[@media(hover:hover)]:group-hover:hidden" : "";');
    expect(quickPanelSource.match(/desktopHoverHidden/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps folders first while building recursive tree sibling groups", () => {
    expect(treePanelSource).toContain("compareKnowledgeTreeFolderPriority(a, b)");
  });

  it("shows the current workspace notebook count in both desktop tree modes", () => {
    expect(treePanelSource).toContain('data-knowledge-tree-notebook-count=""');
    expect(quickPanelSource).toContain('data-mobile-knowledge-tree-notebook-count=""');
    expect(treePanelSource).toContain('aria-label={`当前空间共 ${ownedNoteCount} 条笔记`}');
    expect(quickPanelSource).toContain('aria-label={`当前空间共 ${ownedNoteCount} 条笔记`}');
  });

  it("shows descendant note counts on first-level directory rows", () => {
    expect(treePanelSource).toContain('data-knowledge-tree-first-level-note-count=""');
    expect(quickPanelSource).toContain('data-mobile-knowledge-tree-first-level-note-count=""');
    expect(treePanelSource).toContain("buildFirstLevelNoteCounts(visibleNodes)");
    expect(quickPanelSource).toContain("buildFirstLevelNoteCounts(visibleNodes)");
  });

  it("hides first-level note counts on mouse hover only", () => {
    expect(treePanelSource).toContain("[@media(hover:hover)]:group-hover:opacity-0");
    expect(quickPanelSource).toContain("[@media(hover:hover)]:group-hover:opacity-0");
  });

  it("uses tighter spacing for the mobile recursive tree", () => {
    expect(treePanelSource).toContain('const treeIndent = variant === "mobile" ? 12 : 16;');
    expect(treePanelSource).toContain('variant === "mobile" ? "h-6 w-4" : "h-7 w-5"');
    expect(treePanelSource).toContain('variant === "mobile" ? "gap-1 py-0.5 text-[11px] leading-4" : "gap-1.5 py-1.5 text-xs"');
  });
});
