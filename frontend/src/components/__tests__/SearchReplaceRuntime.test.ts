import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSearchReplaceExtension,
  searchReplacePluginKey,
} from "@/components/SearchReplacePanel";
import type { RuntimeSearchState } from "@/components/SearchReplacePanelRuntime";
import { resolveEditorRuntimeDecision } from "@/lib/editorRuntimePolicy";
import {
  clearActiveEditorRuntimeDecision,
  setActiveEditorRuntimeDecision,
} from "@/lib/editorRuntimeStore";

function lightweightDecision() {
  return resolveEditorRuntimeDecision({
    content: `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${"x".repeat(400_000)}"}]}]}`,
    contentFormat: "tiptap-json",
  });
}

function createEditor(text: string) {
  return new Editor({
    extensions: [Document, Paragraph, Text, createSearchReplaceExtension()],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  });
}

function runQuery(editor: Editor, query: string) {
  editor.view.dispatch(editor.state.tr.setMeta(searchReplacePluginKey, {
    query,
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
  }));
  return searchReplacePluginKey.getState(editor.state) as RuntimeSearchState;
}

afterEach(() => {
  clearActiveEditorRuntimeDecision();
});

describe("runtime-aware rich-text search", () => {
  it("bounds matches and paints only the active result in lightweight mode", () => {
    setActiveEditorRuntimeDecision("search-lightweight", lightweightDecision());
    const editor = createEditor(Array.from({ length: 800 }, () => "needle").join(" "));
    try {
      const state = runQuery(editor, "needle");
      expect(state.matches).toHaveLength(500);
      expect(state.truncated).toBe(true);
      expect(state.deco.find()).toHaveLength(1);
    } finally {
      editor.destroy();
    }
  });

  it("maps existing results instead of rescanning the whole document on each edit", () => {
    setActiveEditorRuntimeDecision("search-map", lightweightDecision());
    const editor = createEditor("needle alpha needle beta");
    try {
      const initial = runQuery(editor, "needle");
      expect(initial.matches).toHaveLength(2);
      expect(initial.stale).toBe(false);

      editor.view.dispatch(editor.state.tr.insertText("prefix ", 1));
      const mapped = searchReplacePluginKey.getState(editor.state) as RuntimeSearchState;
      expect(mapped.matches).toHaveLength(2);
      expect(mapped.matches[0].from).toBeGreaterThan(initial.matches[0].from);
      expect(mapped.stale).toBe(true);
      expect(mapped.deco.find()).toHaveLength(1);
    } finally {
      editor.destroy();
    }
  });

  it("keeps complete matching and decorations in normal mode", () => {
    const editor = createEditor(Array.from({ length: 620 }, () => "needle").join(" "));
    try {
      const state = runQuery(editor, "needle");
      expect(state.matches).toHaveLength(620);
      expect(state.truncated).toBe(false);
      expect(state.deco.find()).toHaveLength(620);
    } finally {
      editor.destroy();
    }
  });

  it("debounces the full rescan in realtime mode: maps matches during edits, rescans once after pause", () => {
    vi.useFakeTimers();
    try {
      const editor = createEditor("needle alpha needle beta");
      try {
        const initial = runQuery(editor, "needle");
        expect(initial.matches).toHaveLength(2);
        expect(initial.stale).toBe(false);

        // 连续派发多个纯文档变更事务：插入一个新命中（重扫会得到 3 个，映射只有 2 个）
        editor.view.dispatch(editor.state.tr.insertText("needle gamma ", 1));
        vi.advanceTimersByTime(150);
        editor.view.dispatch(editor.state.tr.insertText("tail ", 25));
        // 距第一个事务已超过 200ms，但停顿期被第二个事务重置（防抖），不应触发全量扫描
        vi.advanceTimersByTime(150);
        const mapped = searchReplacePluginKey.getState(editor.state) as RuntimeSearchState;
        expect(mapped.stale).toBe(true);
        expect(mapped.matches).toHaveLength(2);
        expect(mapped.matches[0].from).toBeGreaterThan(initial.matches[0].from);
        expect(mapped.deco.find()).toHaveLength(2);

        vi.advanceTimersByTime(100);
        const rescanned = searchReplacePluginKey.getState(editor.state) as RuntimeSearchState;
        expect(rescanned.stale).toBe(false);
        expect(rescanned.matches).toHaveLength(3);
        expect(rescanned.deco.find()).toHaveLength(3);
      } finally {
        editor.destroy();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
