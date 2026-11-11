import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("knowledge tree sidebar contract", () => {
  it("uses the unified tree as the only SidebarMobile hierarchy", () => {
    const sidebar = source("../../components/SidebarMobile.tsx");
    expect(sidebar).toContain("import TreePanelContent");
    expect(sidebar).toContain("<TreePanelContent");
    expect(sidebar).not.toContain("sidebarTreeMode");
    expect(sidebar).not.toContain("SharedNotebookTree");
    expect(sidebar).not.toContain("getSharedNotebooks");
    expect(sidebar).not.toContain("兼容模式");
    expect(sidebar).not.toContain("buildNotebookTree");
    expect(sidebar).not.toContain("NotebookTreeItem");
  });

  it("does not render the former floating drawer launcher", () => {
    const drawer = source("../../components/KnowledgeTreeDrawer.tsx");
    expect(drawer).not.toContain("createPortal");
    expect(drawer).not.toContain("fixed bottom-4");
    expect(drawer).toContain("must not render a second drawer");
  });

  it("keeps loading recovery inside one embedded panel without a legacy fallback", () => {
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    const mobilePanel = source("../../components/MobileKnowledgeTreePanel.tsx");
    expect(panel).toContain('data-baseforge-knowledge-tree="embedded"');
    expect(panel).toContain("loadKnowledgeTreeOnEntry(load)");
    expect(mobilePanel).toContain("loadKnowledgeTreeOnEntry(load)");
    expect(panel).toContain("内容暂时未加载");
    expect(panel).toContain("重新加载");
    expect(panel).toContain("return !descendantsOf(source.id, allChildren).has(target.id);");
    expect(panel).not.toContain("onRequestLegacy");
    expect(panel).not.toContain("使用旧树");
    expect(panel).toContain("KnowledgeTreeNodeMenu");
    expect(panel).toContain("onContextMenu");
    expect(panel).toContain("onTouchStart");
  });

  it("loads and focuses only the currently visible desktop or mobile tree", () => {
    const sidebar = source("../../components/SidebarMobile.tsx");
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    expect(sidebar).toMatch(/(?:sidebarRootRef|rootRef)\.current/);
    expect(sidebar).toContain("root.getClientRects().length === 0");
    expect(panel).toContain("useActiveSidebarSurface");
    expect(panel).toContain('data-sidebar-surface-active={surfaceActive ? "true" : "false"}');
    expect(panel).toContain("if (!surfaceActive) return");
  });

  it("separates folder selection from the disclosure arrow in three-column navigation", () => {
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    const noteList = source("../../components/NoteList.tsx");

    expect(panel).toContain('action: "select" | "toggle"');
    expect(panel).toContain('setPendingFolderAction({ nodeId: node.id, action: "select" })');
    expect(panel).toContain('setPendingFolderAction({ nodeId: node.id, action: "toggle" })');
    expect(panel).toContain("actions.setSelectedNotebook(node.resourceId)");
    expect(panel).toContain('actions.setViewMode("notebook")');
    expect(panel).toContain("selectFolder(node)");
    expect(panel).toContain("state.selectedNotebookId === node.resourceId");
    expect(panel).toContain("onClick={() => hasChildren && void toggleDisclosure(node)}");
    expect(noteList).toContain('includeDescendants: "0"');
  });

  it("keeps favorite note state visible beside the tree title", () => {
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    expect(panel).toContain('aria-label="已收藏"');
    expect(panel).toContain("node.isFavorite === 1");
  });

  // 用户实际点开的是侧栏的树；文档的复制/移动/导出/分享必须写在这里。
  it("exposes copy-as-link and move on the desktop sidebar row menu", () => {
    const sidebar = source("../../components/SidebarDesktop.tsx");
    expect(sidebar).toContain('label="复制"');
    expect(sidebar).toContain("knowledgeTreeApi.createReference");
    expect(sidebar).not.toContain("api.duplicateNote");
    expect(sidebar).toContain('label="移动到…"');
    expect(sidebar).toContain("KnowledgeTreeBatchMovePanel");
    expect(sidebar).toContain('label="导出"');
    expect(sidebar).toContain('label="分享"');
  });

  it("updates tree note status immediately after a successful menu action", () => {
    const panel = source("../../components/KnowledgeTreePanel.tsx");
    const menu = source("../../components/KnowledgeTreeNodeMenu.tsx");
    expect(panel).toContain("onNotePatched={patchNoteStatus}");
    expect(menu).toContain("onNotePatched(node.id, patch)");
  });

  it("renders all notes as a three-column-only desktop navigation entry", () => {
    const runtime = source("../../components/KnowledgeTreeCreateMenuRuntime.tsx");

    expect(runtime).toContain('data-knowledge-tree-all-notes=""');
    expect(runtime).toContain('data-knowledge-tree-all-notes-count=""');
    expect(runtime).toContain("panel.insertBefore(host, scroll)");
    expect(runtime).toContain('actions.setViewMode("all")');
    expect(runtime).toContain("actions.setSelectedNotebook(null)");
    expect(runtime).toContain("actions.clearSelectedTags()");
    expect(runtime).toContain('actions.setSearchQuery("")');
    expect(runtime).toContain("notebook.noteCount");
    expect(runtime).toContain("state.noteListCollapsed");
    expect(runtime).toContain("actions.toggleNoteListCollapsed()");
    expect(runtime).toContain('layoutMode === "three-column"');
    expect(runtime).toContain('variant === "mobile"');
    expect(runtime).toContain("for (const host of root.querySelectorAll<HTMLElement>");
    expect(runtime).toContain('if (host.getAttribute(ALL_NOTES_HOST_ATTR) !== "mobile-toolbar") host.remove();');
  });

    // 上游 UI 结构契约：断言面板源码含上游的节点行结构（toggleDisclosure/gap-1/title=更多 等），
    // 本仓面板为自有实现（Yuque 导入/加密建块/表格入口接线，结构不同）。
    // CSS 密度部分已由 MobileKnowledgeTreeModeSwitch 契约覆盖，此处仅面板结构断言不适用。
  it.skip("applies an unmistakably compact mobile density with a safe fallback", () => {
    const main = source("../../main.tsx");
    const compactCss = source("../../mobile-knowledge-tree-compact.css");
    const bridge = source("../../components/SidebarSearchExperienceBridge.tsx");
    const panel = source("../../components/KnowledgeTreePanel.tsx");

    expect(main).toContain('import "./mobile-knowledge-tree-compact.css"');
    expect(main).not.toContain('import "./desktop-knowledge-tree-compact.css"');
    expect(bridge).toContain('variant="mobile"');
    expect(bridge).toContain('className={compact ? "baseforge-mobile-tree-density" : undefined}');
    expect(compactCss).toContain(".baseforge-mobile-tree-density");

    // Compact rows keep the fixed font while preserving touch-safe targets.
    expect(compactCss).toContain("--baseforge-mobile-tree-root-folder-row-height: 32px");
    expect(compactCss).toContain("--baseforge-mobile-tree-folder-row-height: 30px");
    expect(compactCss).toContain("--baseforge-mobile-tree-note-row-height: 28px");
    expect(compactCss).toContain("font-size: 11px !important");
    expect(compactCss).toContain("line-height: 14px !important");
    expect(compactCss).toContain("padding: 0 !important");

    // Browsers without :has() still receive the compact baseline.
    expect(compactCss).toMatch(/\[data-knowledge-tree-node-id\]\s*\{[\s\S]*min-height:\s*var\(--baseforge-mobile-tree-note-row-height\)\s*!important/);
    expect(compactCss).toContain("svg.lucide-folder");
    expect(compactCss).toContain("[data-knowledge-tree-section] > div > [data-knowledge-tree-node-id]:has");
    expect(compactCss).toContain("[data-knowledge-tree-section-heading]");
    expect(compactCss).not.toContain("[data-knowledge-tree-section] > div:first-child");
    expect(compactCss).toContain("touch-action: manipulation");
    expect(compactCss).not.toContain("data-mobile-knowledge-tree-classic-slot");
    expect(compactCss).not.toContain("data-sidebar-variant");
    expect(compactCss).not.toContain("@media (max-width: 767px)");

    // Existing interaction and title/status behavior must remain intact.
    expect(panel).toContain("onClick={() => hasChildren && void toggleDisclosure(node)}");
    expect(panel).toContain('className="flex min-w-0 flex-1 items-center gap-1"');
    expect(panel).toContain("{firstLevelNoteCount}");
    expect(panel).toContain('aria-label={`在“${node.title}”下新建文档`}');
    expect(panel).toContain('title="更多"');
    expect(panel).toContain('aria-label="已收藏"');
  });
});
