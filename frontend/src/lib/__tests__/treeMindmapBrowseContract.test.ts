import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * B-4 树内「浏览所有导图」契约（.cmp/COLLAB-BOARD.md 第二节 A 指派批次）：
 *  - 入口：树面板头部 ⋯「更多目录操作」菜单新增「浏览所有导图」（勾选态 = 浏览视图开关）；
 *  - 只做筛选展示：导图归一后按 contentFormat === "mindmap" 过滤笔记节点；
 *  - 点击条目走现有开笔记链路（openDocument：导图文档按笔记打开）；
 *  - 移动端树面板不加该入口（B3 未启动，移动端禁改）。
 */

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const PANEL = source("../../components/KnowledgeTreePanel.tsx");
const MOBILE = source("../../components/MobileKnowledgeTreePanel.tsx");

describe("B-4 树内「浏览所有导图」", () => {
  it("入口存在：⋯ 菜单新增 browse-mindmaps 项（带勾选态与动作分支）", () => {
    expect(PANEL).toContain(
      '{ value: "browse-mindmaps", label: "浏览所有导图", checked: mindmapBrowseOpen, separatorBefore: true }',
    );
    expect(PANEL).toContain('value === "browse-mindmaps"');
    expect(PANEL).toContain("setMindmapBrowseOpen((current) => !current)");
  });

  it("按 contentFormat === \"mindmap\" 过滤归一后的导图文档节点", () => {
    expect(PANEL).toContain('nodes.filter((node) => node.contentFormat === "mindmap")');
  });

  it("浏览视图在树面板体内渲染，点击走 openDocument 现有链路", () => {
    expect(PANEL).toContain('data-knowledge-tree-mindmap-browse=""');
    expect(PANEL).toContain("onClick={() => void openDocument(node)}");
  });

  it("移动端树面板未加该入口（B3 未启动，移动端禁改）", () => {
    expect(MOBILE).not.toContain("browse-mindmaps");
  });
});
