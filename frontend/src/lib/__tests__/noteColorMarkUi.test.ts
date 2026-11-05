import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOTE_COLOR_MARK_OPTIONS, getNoteColorMarkHex, isNoteColorMark } from "../noteColorMark";
const source = (relativePath: string) => readFileSync(path.resolve(__dirname, relativePath), "utf8");

describe("note color marks (#749)", () => {
  it("keeps a fixed semantic palette independent from note themes", () => {
    expect(NOTE_COLOR_MARK_OPTIONS.map((item) => item.value)).toEqual([
      null, "red", "orange", "yellow", "green", "blue", "purple", "gray",
    ]);
    expect(getNoteColorMarkHex("blue")).toBe("#3b82f6");
    expect(getNoteColorMarkHex(null)).toBeNull();
    expect(isNoteColorMark("purple")).toBe(true);
    expect(isNoteColorMark("custom")).toBe(false);
  });

  /**
   * 与上游的刻意分歧（2026-10-13 用户裁定）：色标从"小圆点"改为"竖线"。
   * 圆点在密集树/列表里不够显眼，且与列表卡片既有的左侧指示条重复。
   * 现在统一成色条：树行左侧绝对定位色条、列表卡片左侧指示条取色标色。
   * （顶部页签行已随「启用顶部笔记标签页」开关一并移除，它那一处不再计入口径。）
   */
  it("renders marks as bars in list and both knowledge-tree surfaces", () => {
    expect(source("../../components/NoteList.tsx")).toContain("getNoteColorMarkHex(note.colorMark)");
    expect(source("../../components/KnowledgeTreePanel.tsx")).toContain("<NoteColorMarkBar value={node.colorMark}");
    expect(source("../../components/MobileKnowledgeTreePanel.tsx")).toContain("<NoteColorMarkBar value={node.colorMark}");
    expect(source("../../components/EditorPane.tsx")).toContain("<NoteColorMarkPicker");

    // 圆点已从这三个渲染面撤下（组件本体保留，供将来需要圆点的位置使用）。
    for (const file of [
      "../../components/NoteList.tsx",
      "../../components/KnowledgeTreePanel.tsx",
      "../../components/MobileKnowledgeTreePanel.tsx",
    ]) {
      expect(source(file)).not.toContain("<NoteColorMarkDot");
    }
  });

  it("uses the canonical colorMark mutation path", () => {
    const list = source("../../components/NoteList.tsx");
    const editor = source("../../components/EditorPane.tsx");
    expect(list).toContain("api.updateNote(targetId, { colorMark: nextColor }");
    expect(editor).toContain("api.updateNote(activeNote.id, { colorMark }");
    expect(list).toContain('emitKnowledgeTreeRefresh("note-color-mark-changed")');
  });
});
