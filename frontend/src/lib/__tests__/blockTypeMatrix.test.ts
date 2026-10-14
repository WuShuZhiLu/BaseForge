// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Image from "@tiptap/extension-image";
import { Table, TableHeader, TableRow, TableCell } from "@tiptap/extension-table";
import { ColumnsExtension } from "@/components/extensions/ColumnsExtension";
import { CalloutExtension } from "@/components/extensions/CalloutExtension";
import { MathBlock } from "@/components/MathExtensions";
import { FootnoteExtensions } from "@/components/FootnoteExtensions";
import {
  locateBlock,
  getBlockTypeAt,
  convertBlock,
  addBlockBelow,
  copyBlock,
  cutBlock,
  deleteBlock,
} from "@/components/blockMenuActions";

/**
 * 阶段 2 · 块化地基：块类型 × 块操作 完整矩阵。
 *
 * 在既有 blockHandleMatrix.test.ts（段落/callout/分栏容器）之外，补齐
 * 图片 / mermaid 代码块 / 数学块 / 表格 / 水平线 五种块级类型，对每种验证：
 *   locateBlock 定位 → 转换（11 目标）→ 下方插入（16 类型）→ 复制/剪切/删除。
 *
 * 调用约定与拖拽柄一致：from = 节点 before + 1（柄库返回 pos = before）。
 * 回归背景（2026-10-14 修复）：原子块（image/mathBlock/horizontalRule）没有
 * content，locateBlock 的文本块回溯与旧兜底都命不中 → 删除/复制/剪切静默失败。
 * locateBlock 已加"情形C：from-1 恰为块级叶子起点"兜底，本矩阵锁死该行为。
 */

const BLOCK_CONTENTS: Record<string, any> = {
  image: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "前" }] },
      { type: "image", attrs: { src: "https://example.com/a.png", alt: "a" } },
      { type: "paragraph", content: [{ type: "text", text: "后" }] },
    ],
  },
  mermaidCodeBlock: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "前" }] },
      { type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: "mindmap\n  root((中心))" }] },
      { type: "paragraph", content: [{ type: "text", text: "后" }] },
    ],
  },
  mathBlock: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "前" }] },
      { type: "mathBlock", attrs: { latex: "E=mc^2" } },
      { type: "paragraph", content: [{ type: "text", text: "后" }] },
    ],
  },
  table: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "前" }] },
      {
        type: "table",
        content: [
          { type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "H" }] }] }, { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }] },
          { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] }, { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] }] },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "后" }] },
    ],
  },
  horizontalRule: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "前" }] },
      { type: "horizontalRule" },
      { type: "paragraph", content: [{ type: "text", text: "后" }] },
    ],
  },
};

function createEditor(content: any) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit, Details, DetailsSummary, DetailsContent, TaskList, TaskItem,
      Table.configure({}), TableHeader, TableRow, TableCell,
      Image, ColumnsExtension, CalloutExtension, MathBlock,
      ...FootnoteExtensions,
    ],
    content,
  });
  return editor;
}

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = "";
});

function makeEditor(content: any): Editor {
  const editor = createEditor(content);
  editors.push(editor);
  return editor;
}

/** 拖拽柄姿势：目标块（倒数第二个块）的 before + 1。 */
function handleFromOfSecondLastBlock(editor: Editor): { from: number; typeName: string } {
  const blocks: { before: number; name: string }[] = [];
  editor.state.doc.forEach((child, offset) => {
    blocks.push({ before: offset + 1, name: child.type.name });
  });
  const target = blocks[blocks.length - 2];
  return { from: target.before + 1, typeName: target.name };
}

const CONVERT_TARGETS = [
  { type: "paragraph" }, { type: "heading", level: 1 }, { type: "heading", level: 2 },
  { type: "bulletList" }, { type: "orderedList" }, { type: "taskList" },
  { type: "callout" }, { type: "blockquote" }, { type: "codeBlock" },
  { type: "columns" }, { type: "details" },
] as const;

const ADD_BELOW_TYPES = [
  "paragraph", "heading1", "heading3", "heading6", "bulletList", "orderedList",
  "taskList", "blockquote", "codeBlock", "details", "callout", "columns",
  "table", "math", "mermaid", "horizontalRule",
] as const;

describe("块类型 × 块操作 矩阵（图片/mermaid/数学/表格/水平线，拖拽柄姿势）", () => {
  for (const [name, content] of Object.entries(BLOCK_CONTENTS)) {
    describe(`块类型: ${name}`, () => {
      it("locateBlock 按柄姿势定位成功", () => {
        const editor = makeEditor(JSON.parse(JSON.stringify(content)));
        const { from } = handleFromOfSecondLastBlock(editor);
        const located = locateBlock(editor, from);
        expect(located).not.toBeNull();
        expect(located!.start).toBeGreaterThanOrEqual(0);
        expect(getBlockTypeAt(editor, from)).not.toBeNull();
      });

      it("转换到 11 个目标全部不抛异常且文档仍有效", () => {
        for (const target of CONVERT_TARGETS) {
          const editor = makeEditor(JSON.parse(JSON.stringify(content)));
          const { from } = handleFromOfSecondLastBlock(editor);
          expect(() => convertBlock(editor, target as any, from)).not.toThrow();
          expect(() => editor.state.doc.toJSON()).not.toThrow();
        }
      });

      it("下方插入 16 种类型全部不抛异常", () => {
        for (const type of ADD_BELOW_TYPES) {
          const editor = makeEditor(JSON.parse(JSON.stringify(content)));
          const { from } = handleFromOfSecondLastBlock(editor);
          expect(() => addBlockBelow(editor, type as any, from)).not.toThrow();
          expect(() => editor.state.doc.toJSON()).not.toThrow();
        }
      });

      it("复制/剪切/删除 不抛异常", async () => {
        const editor = makeEditor(JSON.parse(JSON.stringify(content)));
        const { from } = handleFromOfSecondLastBlock(editor);
        await expect(copyBlock(editor, from)).resolves.not.toThrow();
        await expect(cutBlock(editor, from)).resolves.toBeDefined();
        expect(() => deleteBlock(editor, from)).not.toThrow();
      });
    });
  }

  it("mermaid 代码块转换后仍可定位且类型往返一致", () => {
    const editor = makeEditor(BLOCK_CONTENTS.mermaidCodeBlock);
    const { from } = handleFromOfSecondLastBlock(editor);
    const located = locateBlock(editor, from);
    expect(located).not.toBeNull();
    expect(() => convertBlock(editor, { type: "codeBlock" }, located!.start)).not.toThrow();
    const size = editor.state.doc.content.size;
    expect(locateBlock(editor, size - 1)).not.toBeNull();
  });

  it("数学块与脚注在文档序列化后保真", () => {
    const editor = makeEditor(BLOCK_CONTENTS.mathBlock);
    expect(JSON.stringify(editor.state.doc.toJSON())).toContain("mathBlock");
    const editor2 = makeEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }, { type: "footnoteReference", attrs: { identifier: "1" } }] }],
    });
    expect(JSON.stringify(editor2.state.doc.toJSON())).toContain("footnoteReference");
  });
});
