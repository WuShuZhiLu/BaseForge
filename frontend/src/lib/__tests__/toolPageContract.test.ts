import { readFileSync } from "node:fs";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { isToolPageElementActive, TOOL_PAGE_ACTIVE_ATTRIBUTE, useToolPageActive } from "../toolPage";

/**
 * B2 工具页页签契约自检（.cmp/PLAN-B2-TWO-AGENTS.md 第四节）。
 *
 * 逐页断言（源码扫描式，与 aiChatLayoutContract 同风格）：
 *  - 契约 1：根元素自适应 —— 全文件无 h-screen / min-h-screen；
 *    根容器含 flex-1 + min-h-0（min-w-0）。
 *  - 契约 3：导出 TOOL_PAGE_HEADER_MODE（默认 "own"，页面自带标题行）。
 *  - 契约 5：不自行切换全局视图 —— 无 actions.setViewMode(<工具视图>)。
 *
 * 已记录的例外（非遗漏）：
 *  - TaskWorkspaceImpl 根元素保留 `taskFullscreen && "fixed inset-0 ..."`：
 *    这是用户主动点击的「全屏显示」既有功能（非破坏性铁律，不得删除），
 *    默认根类为 TASK_WORKSPACE_ROOT_CLASS + min-h-0 flex-1，符合自适应。
 *  - daily-records/DailyJournalView 的 actions.setViewMode("notebook")
 *    为「跳转到笔记」链路，待迁移（见 .cmp/COLLAB-QUEUE.md）。
 *  - FileManager / ShareManagementPage 已完成 P3 迁移：
 *    无任何 actions.setViewMode，跳笔记改派发 navigateToolPage。
 */

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

/** 各工具页入口 → 其根容器类（用于契约 1 断言）。 */
const TOOL_PAGES: Array<{ file: string; rootClass: string }> = [
  { file: "../../components/ShareManagementPage.tsx", rootClass: '"min-h-0 min-w-0 flex-1 overflow-y-auto bg-app-bg"' },
  { file: "../../components/FileManager.tsx", rootClass: '"flex min-h-0 min-w-0 flex-1 flex-col h-full bg-app-bg overflow-hidden relative"' },
  { file: "../../components/AIChatPanel.tsx", rootClass: '"flex h-full min-h-0 min-w-0 flex-1 max-w-full bg-app-bg"' },
  { file: "../../features/trash/TrashPage.tsx", rootClass: '"flex min-h-0 min-w-0 flex-1 flex-col bg-app-bg text-tx-primary"' },
  { file: "../../components/daily-records/DailyRecordsHub.tsx", rootClass: '"flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-bg"' },
];

const TOOL_VIEW_MODES = /actions\.setViewMode\(\s*"(tasks|diary|diaryCenter|ai-chat|aiChat|shares|files|trash|notifications|mindmaps|notebook-all)"\s*\)/;

describe("B2 工具页页签契约（toolPageContract）", () => {
  for (const page of TOOL_PAGES) {
    describe(page.file, () => {
      const src = source(page.file);

      it("契约1：无 h-screen / min-h-screen", () => {
        expect(src).not.toMatch(/h-screen/);
      });

      it("契约1：根元素自适应（flex-1 + min-h-0）", () => {
        expect(src).toContain(`className=${page.rootClass}`);
      });

      it("契约3：导出 TOOL_PAGE_HEADER_MODE 且默认 own", () => {
        expect(src).toContain('export const TOOL_PAGE_HEADER_MODE: ToolPageHeaderMode = "own"');
      });

      it("契约5：不自行切换到工具视图（setViewMode 禁用工具目标）", () => {
        expect(src).not.toMatch(TOOL_VIEW_MODES);
      });
    });
  }

  describe("P3 跨页导航迁移（.cmp/COLLAB-BOARD.md 协议 v1）", () => {
    it("FileManager：无 actions.setViewMode，跳笔记走 navigateToolPage", () => {
      const src = source("../../components/FileManager.tsx");
      expect(src).not.toContain("actions.setViewMode(");
      expect(src).toContain('navigateToolPage({ kind: "note", noteId })');
      expect(src).toContain('from "@/components/toolTabs"');
    });

    it("ShareManagementPage：无 actions.setViewMode，跳笔记走 navigateToolPage", () => {
      const src = source("../../components/ShareManagementPage.tsx");
      expect(src).not.toContain("actions.setViewMode(");
      expect(src).toContain('navigateToolPage({ kind: "note", noteId: item.objectId })');
      expect(src).toContain('from "@/components/toolTabs"');
    });

    it("AIChatPanel：无全局视图切换（关闭/跳转由宿主 props 承接，P5）", () => {
      const src = source("../../components/AIChatPanel.tsx");
      expect(src).not.toContain("actions.setViewMode(");
      expect(src).not.toMatch(TOOL_VIEW_MODES);
    });
  });

  describe("components/TaskWorkspace.tsx（根入口）", () => {
    const entry = source("../../components/TaskWorkspace.tsx");

    it("契约3：导出 TOOL_PAGE_HEADER_MODE 且默认 own", () => {
      expect(entry).toContain('export const TOOL_PAGE_HEADER_MODE: ToolPageHeaderMode = "own"');
    });

    it("契约1：Impl 根类含 min-h-0 flex-1（全屏切换为既有功能保留）", () => {
      const impl = source("../../components/TaskWorkspaceImpl.tsx");
      expect(impl).toContain('cn(TASK_WORKSPACE_ROOT_CLASS, "min-h-0 flex-1", taskFullscreen && "fixed inset-0 z-[80] bg-app-bg")');
      expect(impl).not.toMatch(/h-screen/);
    });

    it("契约5：不自行切换到工具视图", () => {
      expect(entry).not.toMatch(TOOL_VIEW_MODES);
      expect(source("../../components/TaskWorkspaceImpl.tsx")).not.toMatch(TOOL_VIEW_MODES);
    });
  });

  describe("lib/toolPage.ts（共享契约类型）", () => {
    it("导出 ToolPageHeaderMode = own | host 与默认值", () => {
      const src = source("../toolPage.ts");
      expect(src).toContain('export type ToolPageHeaderMode = "own" | "host"');
      expect(src).toContain('export const DEFAULT_TOOL_PAGE_HEADER_MODE: ToolPageHeaderMode = "own"');
    });
  });
});

describe("隐藏态治理（keepAlive · .cmp/COLLAB-BOARD.md 第二节 B 批次）", () => {
  it("激活态属性名与宿主 ToolPageHost 写入的一致（属性名 A 已固定）", () => {
    expect(TOOL_PAGE_ACTIVE_ATTRIBUTE).toBe("data-tool-page-active");
    const host = source("../../components/ToolPageHost.tsx");
    expect(host).toContain("data-tool-page-active=");
  });

  it("isToolPageElementActive：宿主内读容器属性，宿主外视为激活", () => {
    const host = document.createElement("div");
    host.setAttribute(TOOL_PAGE_ACTIVE_ATTRIBUTE, "false");
    const child = document.createElement("div");
    host.appendChild(child);
    document.body.appendChild(host);
    try {
      expect(isToolPageElementActive(child)).toBe(false);
      host.setAttribute(TOOL_PAGE_ACTIVE_ATTRIBUTE, "true");
      expect(isToolPageElementActive(child)).toBe(true);
      expect(isToolPageElementActive(document.createElement("div"))).toBe(true);
      expect(isToolPageElementActive(null)).toBe(true);
    } finally {
      host.remove();
    }
  });

  it("useToolPageActive 跟随宿主属性翻转（MutationObserver）", async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    host.setAttribute(TOOL_PAGE_ACTIVE_ATTRIBUTE, "false");
    const mount = document.createElement("div");
    host.appendChild(mount);
    document.body.appendChild(host);
    const rootRef = { current: null as HTMLDivElement | null };
    const seen: boolean[] = [];
    const ActiveProbe = (props: { rootRef: typeof rootRef }) => {
      seen.push(useToolPageActive(props.rootRef));
      return createElement("div", { ref: props.rootRef });
    };
    const root = createRoot(mount);
    try {
      await act(async () => {
        root.render(createElement(ActiveProbe, { rootRef }));
      });
      expect(seen.at(-1)).toBe(false);

      host.setAttribute(TOOL_PAGE_ACTIVE_ATTRIBUTE, "true");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(seen.at(-1)).toBe(true);

      host.setAttribute(TOOL_PAGE_ACTIVE_ATTRIBUTE, "false");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(seen.at(-1)).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    }
  });

  it("工具页不得在模块顶层 setInterval（行首裸调用）", () => {
    const files = [
      ...TOOL_PAGES.map((page) => page.file),
      "../../components/TaskWorkspaceImpl.tsx",
      "../../components/AIChatReliabilityShell.tsx",
    ];
    for (const file of files) {
      expect(source(file), file).not.toMatch(/(^|\n)setInterval\(/);
    }
  });

  it("AI 工具页状态轮询受激活态门控（非激活暂停 / 重激活补一次）", () => {
    const src = source("../../components/AIChatReliabilityShell.tsx");
    expect(src).toContain("useToolPageActive(pageProbeRef)");
    const gateAt = src.indexOf("if (!pageActive) return;");
    const timerAt = src.indexOf("window.setInterval(() => void refreshStatus(), 30_000)");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(timerAt).toBeGreaterThan(gateAt);
    expect(src).toContain("[pageActive, refreshStatus]");
  });

  it("FileManager / TaskWorkspaceImpl 重新激活补一次刷新", () => {
    const fm = source("../../components/FileManager.tsx");
    expect(fm).toContain("useToolPageActive(pageRootRef)");
    expect(fm).toContain("if (pageActive) loadList();");
    expect(fm).toContain("previousPageActiveRef.current = pageActive;");

    const tc = source("../../components/TaskWorkspaceImpl.tsx");
    expect(tc).toContain("useToolPageActive(pageRootRef)");
    expect(tc).toContain("previousPageActiveRef.current = pageActive;");
    expect(tc).toContain("重新激活时补一次刷新");
  });
});
