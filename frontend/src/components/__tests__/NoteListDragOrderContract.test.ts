import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(path.resolve(__dirname, "../KnowledgeTreePanel.tsx"), "utf8");
const noteListSource = readFileSync(path.resolve(__dirname, "../NoteList.tsx"), "utf8");

describe("note list manual drag order contract", () => {
  it("persists manual drag order from the displayed order", () => {
    expect(noteListSource).not.toContain("reorderNotesWithinNotebook(state.notes");
    expect(noteListSource.match(/reorderNotesWithinNotebook\(sortedNotes/g)).toHaveLength(2);
    expect(sidebarSource).toContain("KNOWLEDGE_TREE_SORT_OPTIONS");
    expect(sidebarSource).toContain('value: `sort:${option.value}`');
  });
});
