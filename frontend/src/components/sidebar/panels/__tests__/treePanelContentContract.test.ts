import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * B-10 文档树内容（内容层 v1）契约（.cmp/COLLAB-BOARD.md 6.10）：
 *  - 形态：({ mode }: { mode: "quick" | "full" })，按既有 desktopKnowledgeTreeMode 语义分派；
 *  - 树渲染走委托链（quick → MobileKnowledgeTreePanel / full → KnowledgeTreePanel），
 *    本组件不复制树内部逻辑、不改旧组件文件；
 *  - 筛选行由被委托组件自带（data-knowledge-tree-search，输入 + 目录/内容范围切换），
 *    本组件不重复实现第二份筛选输入，也不整体隐藏旧工具栏；
 *  - 无重复动作按钮：与面板头 ⋯ 重复的旧树内部动作按钮（＋新建/全部展开收起/刷新/更多目录操作）
 *    由作用域样式隐藏，动作统一收在面板头（A 的 Shell）。
 */

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const CONTENT = source("../TreePanelContent.tsx");
const OLD_TREE = source("../../../KnowledgeTreePanel.tsx");

describe("B-10 TreePanelContent 内容层契约", () => {
  it("形态契约：({ mode }) quick | full，根元素带 data-sidebar-tree-content", () => {
    expect(CONTENT).toContain('{ mode }: { mode: TreePanelContentMode }');
    expect(CONTENT).toContain('export type TreePanelContentMode = "quick" | "full"');
    expect(CONTENT).toContain('data-sidebar-tree-content=""');
  });

  it("树渲染委托链：quick → MobileKnowledgeTreePanel，full → KnowledgeTreePanel（不改旧文件）", () => {
    expect(CONTENT).toContain('<MobileKnowledgeTreePanel variant="desktop" />');
    expect(CONTENT).toContain('<KnowledgeTreePanel variant="desktop" />');
  });

  it("筛选行随委托自带且保持可用：不隐藏旧搜索行、不造第二份筛选输入", () => {
    expect(OLD_TREE).toContain('data-knowledge-tree-search=""');
    expect(CONTENT).not.toContain("<input");
    // 作用域样式不得整条隐藏旧工具栏（旧筛选行随工具栏渲染），只能按按钮 title 精确隐藏
    expect(CONTENT).not.toContain("> div:first-child{display:none}");
    expect(CONTENT).toContain('[data-sidebar-tree-content] button[title="${title}"]{display:none}');
    expect(CONTENT).toContain('"新建根文件夹"');
    expect(CONTENT).toContain('"刷新内容树"');
    expect(CONTENT).toContain('"全部展开"');
  });

  it("无重复动作按钮：本组件不含 ＋/⋯/展开收起等动作实现", () => {
    expect(CONTENT).not.toContain("startInlineCreate");
    expect(CONTENT).not.toContain("toggleAll");
    expect(CONTENT).not.toContain("MoreHorizontal");
  });

  it("按用户口径：不给旧组件加抑制开关（无 suppress 类 prop）", () => {
    expect(CONTENT).not.toContain("suppressInlineToolbarActions");
  });
});
