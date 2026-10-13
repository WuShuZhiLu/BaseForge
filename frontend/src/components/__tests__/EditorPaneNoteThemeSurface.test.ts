import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const editorPaneSource = readFileSync(path.resolve(__dirname, "../EditorPane.tsx"), "utf8");
const mainSource = readFileSync(path.resolve(__dirname, "../../main.tsx"), "utf8");

/**
 * 回归：笔记主题（per-note theme）的可视化链路。
 *
 * 两个曾经缺失的环节让「笔记主题」里选任何主题都毫无反应：
 *   1) 编辑器主区没有 `.note-theme-surface` / `data-note-id` 标记 ——
 *      NoteAppearanceBridge 靠这两个属性找应用主题的目标，没有标记就永远找不到；
 *   2) `note-appearance.css` 没有被 main.tsx 导入 —— 即便打上了标记，
 *      也没有任何规则去消费 `--pm-text` / `--note-theme-surface` 这些 token。
 */
describe("note theme surface wiring", () => {
  it("marks the editor surface so the appearance bridge can apply per-note themes", () => {
    expect(editorPaneSource).toContain("note-theme-surface");
    expect(editorPaneSource).toContain("data-note-id={activeNote.id}");
  });

  it("imports the note appearance stylesheet so the theme tokens are consumed", () => {
    expect(mainSource).toContain('import "./note-appearance.css";');
  });
});
