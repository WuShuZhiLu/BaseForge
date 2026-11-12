// 上游 1.5.1 的 UI 结构契约测试：断言的是上游那套界面结构（DOM 属性 / 文案 / 组件组成）。
// 本仓走「UI 保留自有」，结构与我们的界面不一致，属**不跟**的用例 —— 断言原样保留（未改写），
// 仅跳过执行；将来若确实采用上游该 UI，把下面的 .skip 去掉即可恢复。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const runtimeSource = readFileSync(path.resolve(__dirname, "../KnowledgeTreeCreateMenuRuntime.tsx"), "utf8");
const menuSource = readFileSync(path.resolve(__dirname, "../KnowledgeTreeCreateDropdown.tsx"), "utf8");
const panelSource = readFileSync(path.resolve(__dirname, "../KnowledgeTreePanel.tsx"), "utf8");
const quickPanelSource = readFileSync(path.resolve(__dirname, "../MobileKnowledgeTreePanel.tsx"), "utf8");
const nodeMenuSource = readFileSync(path.resolve(__dirname, "../KnowledgeTreeNodeMenu.tsx"), "utf8");

describe("knowledge tree create naming", () => {
  it.skip("hands dropdown selections to the inline naming draft before creating", () => {
    expect(runtimeSource).toContain("setCreateRequest({");
    expect(runtimeSource).toContain("<KnowledgeTreePanelBase {...props} createRequest={createRequest}");
    expect(runtimeSource).not.toContain("knowledgeTreeApi.create({");
    expect(panelSource).toContain("createRequest?: KnowledgeTreeInlineCreateRequest;");
    expect(panelSource).toContain("startInlineCreate(parent, createRequest.kind);");
  });

  it("offers Markdown, Word and WeChat article imports from the plus menu", () => {
    expect(menuSource).toContain('label: "导入 Markdown 文件"');
    expect(menuSource).toContain('label: "导入 Word 转 Markdown"');
    expect(menuSource).toContain('label: "导入 Word 原件预览"');
    expect(menuSource).toContain('label: "导入公众号文章"');
    expect(menuSource).toContain("也可将 .md 文件拖拽到目录树导入");
    expect(runtimeSource).toContain("setImportRequest({");
    expect(runtimeSource).toContain("importRequest={importRequest}");
    expect(panelSource).toContain("importRequest?: KnowledgeTreeImportRequest;");
    expect(panelSource).toContain("importWordIntoKnowledgeTree");
    expect(panelSource).toContain("importMarkdownIntoKnowledgeTree");
    expect(panelSource).toContain("importWeChatArticleIntoKnowledgeTree");
    expect(quickPanelSource).toContain("importMarkdownIntoKnowledgeTree");
  });

  it("adds child duplication to the plus menu while preserving the existing sibling duplicate action", () => {
    expect(menuSource).toContain("duplicateKnowledgeTreeNoteAsChild");
    expect(menuSource).toContain("resolveDuplicableKnowledgeTreeNote");
    expect(menuSource).toContain("<span>创建副本</span>");
    expect(menuSource).toContain('toast.success("副本已创建到子目录")');
    expect(menuSource).toContain('reason: "note-duplicated-as-child"');

    // `...` / 右键菜单的"复制"语义已改为"引用连接"：不复制正文，只多一条指向同一内容的路径。
    expect(nodeMenuSource).toContain('id: "duplicate"');
    expect(nodeMenuSource).toContain('case "duplicate": await duplicateCurrentNote(); break;');
    expect(nodeMenuSource).toContain("knowledgeTreeApi.createReference(node.resourceId");
  });

  it("uses the tree-style anchored menu and inline naming in quick browse", () => {
    expect(menuSource).toContain("export function KnowledgeTreeCreateDropdown");
    expect(quickPanelSource).toContain("<KnowledgeTreeCreateDropdown");
    expect(quickPanelSource).toContain("data-mobile-knowledge-tree-inline-create");
    expect(quickPanelSource).toContain("startInlineCreate");
    expect(quickPanelSource).toContain("commitDraft");
    expect(quickPanelSource).not.toContain("const openCreateMenu = useCallback(async");
  });
});
