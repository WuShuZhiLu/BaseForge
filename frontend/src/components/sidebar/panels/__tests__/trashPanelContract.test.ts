import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * B-9 回收站面板（内容层 v1）契约（.cmp/COLLAB-BOARD.md 6.10）：
 *  - 不自带头部（标题/计数/⋯ 由 SidebarPanelShell 提供）；
 *  - 行用公共件 PanelRow，整行点击 = 恢复（RotateCcw）；
 *  - 接框架刷新协议 usePanelRefresh("trash", …)，计数经 reportPanelCount("trash", n) 上报；
 *  - 全局跳转仅允许底部「打开完整页」actions.setViewMode("trash")。
 */

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const PANEL = source("../TrashPanel.tsx");

describe("B-9 TrashPanel 内容层契约", () => {
  it("不自带头部：不引入/不渲染旧 PanelShell，也不渲染面板头结构", () => {
    expect(PANEL).not.toMatch(/import .*PanelShell/);
    expect(PANEL).not.toContain("<PanelShell");
    expect(PANEL).not.toContain("data-sidebar-panel-title");
    expect(PANEL).not.toContain("data-sidebar-panel-body");
  });

  it("行用 PanelRow，恢复动作 = RotateCcw（整行点击恢复）", () => {
    expect(PANEL).toContain("PanelRow");
    expect(PANEL).toContain("RotateCcw");
    expect(PANEL).toContain('onClick={() => void restore(item.id)}');
  });

  it("接刷新协议 + 上报计数", () => {
    expect(PANEL).toContain('usePanelRefresh("trash"');
    expect(PANEL).toContain('reportPanelCount("trash", items.length)');
  });

  it("全局跳转仅 setViewMode(\"trash\")（打开完整页）", () => {
    expect(PANEL).not.toMatch(/setViewMode\("(?!trash")/);
    expect(PANEL).toContain('actions.setViewMode("trash")');
  });

  it("数据源照旧 useTrash（features/trash），品牌铁律：无 emoji", () => {
    expect(PANEL).toContain("useTrash(getCurrentWorkspace(");
    expect(PANEL).toContain('from "@/features/trash/useTrash"');
    expect(PANEL).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
