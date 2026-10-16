import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NODE_ICON_SEMANTIC_COLORS, resolveNodeIconKind } from "../nodeIcons";
import type { KnowledgeTreeNode } from "../knowledgeTreeApi";

/**
 * B2-I 树节点图标体系契约（.cmp/PLAN-B2-TWO-AGENTS.md 第八节第 4 项）：
 *  - 节点类型 → 线性图标（lucide）+ 语义色，不使用 emoji；
 *  - 语义色定稿：文件夹琥珀 #D97706 · 文档蓝 #2563EB · Markdown 灰 #8B8B93
 *    · 导图紫 #7C3AED · 表格绿 #059669；
 *  - 用户自选 emoji 图标（文件夹 node.icon）保留，缩至 14px 同基线。
 *  - 桌面 / 移动树面板统一走 lib/nodeIcons 单一来源。
 */

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const NODE_ICONS = source("../nodeIcons.tsx");
const DESKTOP_PANEL = source("../../components/KnowledgeTreePanel.tsx");
const MOBILE_PANEL = source("../../components/MobileKnowledgeTreePanel.tsx");

function fakeNode(partial: Partial<KnowledgeTreeNode>): KnowledgeTreeNode {
  return {
    id: "n1", userId: "u", workspaceId: null, scopeKey: "s", parentId: null,
    nodeType: "note", resourceType: "note", resourceId: "r", title: "t",
    isExpanded: 0, isDeleted: 0, sortOrder: 0,
    ...partial,
  } as KnowledgeTreeNode;
}

describe("节点图标语义色规格", () => {
  it("五类语义色与用户定稿一致", () => {
    expect(NODE_ICON_SEMANTIC_COLORS.folder).toBe("#D97706");
    expect(NODE_ICON_SEMANTIC_COLORS.note).toBe("#2563EB");
    expect(NODE_ICON_SEMANTIC_COLORS.markdown).toBe("#8B8B93");
    expect(NODE_ICON_SEMANTIC_COLORS.mindmap).toBe("#7C3AED");
    expect(NODE_ICON_SEMANTIC_COLORS.sheet).toBe("#059669");
  });

  it("nodeType → 语义类别判定", () => {
    expect(resolveNodeIconKind(fakeNode({ nodeType: "folder" }))).toBe("folder");
    expect(resolveNodeIconKind(fakeNode({ nodeType: "markdown" }))).toBe("markdown");
    expect(resolveNodeIconKind(fakeNode({ nodeType: "note", resourceType: "mindmap" }))).toBe("mindmap");
    expect(resolveNodeIconKind(fakeNode({ nodeType: "mindmap" }))).toBe("mindmap");
    expect(resolveNodeIconKind(fakeNode({ nodeType: "note", noteType: "sheet" }))).toBe("sheet");
    expect(resolveNodeIconKind(fakeNode({ nodeType: "note" }))).toBe("note");
  });

  it("nodeIcons 自身不含 emoji 字符", () => {
    expect(NODE_ICONS).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("用户自选 emoji 分支保留且缩至 14px", () => {
    expect(NODE_ICONS).toContain("node.icon");
    expect(NODE_ICONS).toContain("USER_EMOJI_ICON_SIZE_PX = 14");
  });
});

describe("树面板统一接入 nodeIcons 单一来源", () => {
  it("桌面面板 nodeIcon/draftIcon 委托 NodeIcon/NodeKindIcon", () => {
    expect(DESKTOP_PANEL).toContain('from "@/lib/nodeIcons"');
    expect(DESKTOP_PANEL).toContain("return <NodeIcon node={node} size={15} />;");
    expect(DESKTOP_PANEL).toContain("return <NodeKindIcon kind={kind} size={15} />;");
    expect(DESKTOP_PANEL).not.toContain('className="text-emerald-500"');
    expect(DESKTOP_PANEL).not.toContain('className="text-sky-500"');
  });

  it("移动面板 nodeIcon 委托 NodeIcon（仅图标改造，结构不动）", () => {
    expect(MOBILE_PANEL).toContain('from "@/lib/nodeIcons"');
    expect(MOBILE_PANEL).toContain("return <NodeIcon node={node} size={18} />;");
    expect(MOBILE_PANEL).not.toContain('className="text-emerald-500"');
    expect(MOBILE_PANEL).not.toContain('className="text-sky-500"');
  });
});
