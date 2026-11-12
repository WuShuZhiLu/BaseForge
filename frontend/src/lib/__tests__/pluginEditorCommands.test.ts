// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execute, actions } = vi.hoisted(() => ({
  execute: vi.fn(async () => ({ success: true, executionId: "run", data: null })),
  actions: vi.fn(async () => [] as Array<{ pluginId: string; actionId: string; input?: Record<string, unknown> }>),
}));

vi.mock("@/lib/pluginApi", () => ({ pluginApi: { execute, actions } }));

import {
  buildEditorCommandInput,
  clearPluginEditorCommands,
  editorCommandMatchesContext,
  executePluginEditorCommand,
  keybindingMatchesEvent,
  listPluginEditorCommands,
  parseKeybinding,
  pluginEditorCommandsRevision,
  primePluginActionInputs,
  replacePluginEditorCommands,
  resetPluginActionInputs,
  subscribePluginEditorCommands,
} from "@/lib/pluginEditorCommands";

const contributions = [
  {
    pluginId: "baseforgelab.editor-kit",
    editorCommands: [
      { id: "baseforgelab.editor-kit.timestamp", title: "插入时间戳", keywords: ["time", "时间"], keybinding: "Mod-Alt-K", action: "insert-timestamp" },
      { id: "baseforgelab.editor-kit.summary", title: "生成摘要", when: "noteOpen", action: "summary" },
    ],
  },
];

afterEach(() => {
  clearPluginEditorCommands();
  resetPluginActionInputs();
  execute.mockClear();
  actions.mockClear();
});

describe("plugin editorCommands registry", () => {
  it("注册已启用插件的命令，并把 id 收敛到插件命名空间", () => {
    const count = replacePluginEditorCommands(contributions as never);
    expect(count).toBe(2);
    expect(listPluginEditorCommands().map((item) => [item.id, item.action, item.when])).toEqual([
      ["baseforgelab.editor-kit.timestamp", "insert-timestamp", undefined],
      ["baseforgelab.editor-kit.summary", "summary", "noteOpen"],
    ]);
    expect(listPluginEditorCommands()[0].chord).toEqual(["Mod", "Alt", "K"]);
  });

  it("插件停用或卸载后命令随之注销，并通知订阅者", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePluginEditorCommands(listener);
    replacePluginEditorCommands(contributions as never);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith();

    replacePluginEditorCommands([]);
    expect(listPluginEditorCommands()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);

    replacePluginEditorCommands(contributions as never);
    clearPluginEditorCommands();
    expect(listPluginEditorCommands()).toEqual([]);
    unsubscribe();
  });

  it("注册表版本号单调递增，供 useSyncExternalStore 订阅", () => {
    const before = pluginEditorCommandsRevision();
    replacePluginEditorCommands(contributions as never);
    expect(pluginEditorCommandsRevision()).toBeGreaterThan(before);
  });

  it("拒绝命名空间不符、Action 非法或缺少标题的声明", () => {
    replacePluginEditorCommands([
      { pluginId: "baseforgelab.editor-kit", editorCommands: [
        { id: "other.plugin.timestamp", title: "越权", action: "insert-timestamp" },
        { id: "baseforgelab.editor-kit.bad", title: "", action: "summary" },
        { id: "baseforgelab.editor-kit.bad-action", title: "非法 Action", action: "Insert Timestamp" },
        { id: "baseforgelab.editor-kit.ok", title: "合法", action: "summary" },
      ] },
      { pluginId: "INVALID", editorCommands: [{ id: "INVALID.x", title: "非法插件 id", action: "summary" }] },
    ] as never);
    expect(listPluginEditorCommands().map((item) => item.id)).toEqual(["baseforgelab.editor-kit.ok"]);
  });

  it("快捷键只接受 Mod/Alt 组合，并匹配跨平台事件", () => {
    expect(parseKeybinding("Mod-Alt-K")).toEqual(["Mod", "Alt", "K"]);
    expect(parseKeybinding("Shift-K")).toBeNull();
    expect(parseKeybinding("Mod-Mod-K")).toBeNull();
    expect(parseKeybinding("Mod-Alt-Escape")).toBeNull();
    expect(parseKeybinding("Mod-V")).toBeNull();
    expect(parseKeybinding(undefined)).toBeNull();

    const chord = parseKeybinding("Mod-Alt-K")!;
    expect(keybindingMatchesEvent(chord, { key: "k", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }, "windows")).toBe(true);
    expect(keybindingMatchesEvent(chord, { key: "k", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, "windows")).toBe(false);
    expect(keybindingMatchesEvent(chord, { key: "k", ctrlKey: false, altKey: true, shiftKey: false, metaKey: true }, "macos")).toBe(true);
  });

  it("when 条件缺省按 editorFocused 求值，noteOpen 不带焦点也生效", () => {
    expect(editorCommandMatchesContext({}, { editorFocused: false, noteOpen: true })).toBe(false);
    expect(editorCommandMatchesContext({}, { editorFocused: true, noteOpen: true })).toBe(true);
    expect(editorCommandMatchesContext({ when: "noteOpen" }, { editorFocused: false, noteOpen: true })).toBe(true);
    expect(editorCommandMatchesContext({ when: "noteOpen" }, { editorFocused: true, noteOpen: false })).toBe(false);
  });

  it("执行只传 Action 已声明的入参，避免未知参数被拒绝", async () => {
    expect(buildEditorCommandInput({ noteId: "n1", declaredInputs: ["noteId"] })).toEqual({ noteId: "n1" });
    expect(buildEditorCommandInput({ noteId: "n1", declaredInputs: [] })).toEqual({});
    expect(buildEditorCommandInput({ noteId: null, declaredInputs: ["noteId"] })).toEqual({});

    primePluginActionInputs([{ pluginId: "baseforgelab.editor-kit", actionId: "insert-timestamp", input: {} }]);
    await executePluginEditorCommand({ pluginId: "baseforgelab.editor-kit", action: "insert-timestamp" }, { noteId: "n1" });
    expect(execute).toHaveBeenCalledWith("baseforgelab.editor-kit", "insert-timestamp", {});

    primePluginActionInputs([{ pluginId: "baseforgelab.editor-kit", actionId: "summary", input: { noteId: { type: "string" } } }]);
    await executePluginEditorCommand({ pluginId: "baseforgelab.editor-kit", action: "summary" }, { noteId: "n1" });
    expect(execute).toHaveBeenLastCalledWith("baseforgelab.editor-kit", "summary", { noteId: "n1" });
  });
});

describe("plugin editorCommands 与斜杠菜单的接口", () => {
  beforeEach(() => {
    replacePluginEditorCommands(contributions as never);
  });

  it("斜杠菜单读取的是同一份注册表（含快捷键提示）", async () => {
    const { getPluginSlashCommands } = await import("@/components/SlashCommands");
    const items = getPluginSlashCommands("n1");
    expect(items.map((item) => item.id)).toEqual([
      "plugin:baseforgelab.editor-kit.timestamp",
      "plugin:baseforgelab.editor-kit.summary",
    ]);
    expect(items[0].label).toBe("插入时间戳");
    expect(items[0].description).toContain("baseforgelab.editor-kit");
    expect(items[0].description).toContain("Alt");
    expect(items[0].keywords).toContain("baseforgelab.editor-kit");
  });
});
