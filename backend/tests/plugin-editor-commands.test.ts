import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginManifest, validateKeybinding } from "../src/plugins/manifest.js";

const raw = {
  id: "baseforgelab.editor-kit",
  publisher: "baseforgelab",
  name: "Editor Kit",
  description: "",
  version: "1.0.0",
  apiVersion: 2,
  engines: { baseforge: ">=1.5.0" },
  categories: ["editor"],
  repository: "https://example.com/repo",
  license: "MIT",
  runtime: "sandbox-js",
  main: "index.js",
  permissions: [],
  actions: [
    { id: "insert-timestamp", name: "Insert timestamp", input: {} },
    { id: "insert-callout", name: "Insert callout", input: { style: { type: "string" } } },
  ],
  contributes: {
    editorCommands: [
      { id: "baseforgelab.editor-kit.timestamp", title: "插入时间戳", keywords: ["time", "时间"], keybinding: "Mod-Alt-K", action: "insert-timestamp" },
      { id: "baseforgelab.editor-kit.callout", title: "插入高亮块", when: "noteOpen", action: "insert-callout" },
    ],
  },
};

function firstIssue(value: unknown): string {
  try {
    parsePluginManifest(value);
  } catch (error) {
    const issues = (error as { issues?: Array<{ message: string }> }).issues;
    return issues?.[0]?.message || (error as Error).message;
  }
  return "";
}

test("editorCommands 与已声明 Action 一起通过 V2 校验", () => {
  const manifest = parsePluginManifest(raw);
  assert.equal(manifest.apiVersion === 2 && manifest.runtime !== "declarative" ? manifest.contributes?.editorCommands?.length : 0, 2);
});

test("editorCommands category：合法值保留，缺省与超长分别通过/拒绝", () => {
  const firstCategory = (value: unknown): string | undefined => {
    const manifest = parsePluginManifest(value);
    return manifest.apiVersion === 2 && manifest.runtime !== "declarative"
      ? manifest.contributes?.editorCommands?.[0]?.category
      : undefined;
  };

  // 合法：1-20 字的自定义分组名原样保留
  const withCategory = {
    ...raw,
    contributes: { editorCommands: [{ id: "baseforgelab.editor-kit.timestamp", title: "x", category: "示例", action: "insert-timestamp" }] },
  };
  assert.equal(firstCategory(withCategory), "示例");

  // 缺省：不报错，字段保持 undefined（前端展示层兜底为「插件」）
  const withoutCategory = {
    ...raw,
    contributes: { editorCommands: [{ id: "baseforgelab.editor-kit.timestamp", title: "x", action: "insert-timestamp" }] },
  };
  assert.equal(firstCategory(withoutCategory), undefined);

  // 超长：超过 20 字拒绝
  const tooLong = {
    ...raw,
    contributes: { editorCommands: [{ id: "baseforgelab.editor-kit.timestamp", title: "x", category: "a".repeat(21), action: "insert-timestamp" }] },
  };
  assert.match(firstIssue(tooLong), /at most 20/);

  // 空串：min(1) 拒绝
  const empty = {
    ...raw,
    contributes: { editorCommands: [{ id: "baseforgelab.editor-kit.timestamp", title: "x", category: "", action: "insert-timestamp" }] },
  };
  assert.match(firstIssue(empty), /at least 1 character/);
});

test("editorCommands id 必须是 插件id.动作 前缀命名", () => {
  const wrongPrefix = { ...raw, contributes: { editorCommands: [{ id: "other.plugin.timestamp", title: "x", action: "insert-timestamp" }] } };
  assert.match(firstIssue(wrongPrefix), /Editor Command id 必须形如 baseforgelab\.editor-kit\.<动作>/);
  const bareAction = { ...raw, contributes: { editorCommands: [{ id: "baseforgelab.editor-kit.ts", title: "x", action: "insert-timestamp" }] } };
  assert.equal(firstIssue(bareAction), "", "插件自身前缀的合法 id 不应报错");
});

test("editorCommands 只能引用本插件已声明的 Action", () => {
  const unknownAction = { ...raw, contributes: { editorCommands: [{ id: "baseforgelab.editor-kit.timestamp", title: "x", action: "missing-action" }] } };
  assert.match(firstIssue(unknownAction), /Editor Command Action 不存在: missing-action/);
});

test("keybinding 只接受带 Mod/Alt 的合法组合，并拒绝重复", () => {
  assert.equal(validateKeybinding("Mod-Alt-K"), null);
  assert.equal(validateKeybinding("Alt-Shift-1"), null);
  assert.match(validateKeybinding("K") ?? "", /修饰键/);
  assert.match(validateKeybinding("Ctrl-K") ?? "", /Mod \/ Alt \/ Shift/);
  assert.match(validateKeybinding("Shift-K") ?? "", /必须包含 Mod 或 Alt/);
  assert.match(validateKeybinding("Mod-Mod-K") ?? "", /不能重复/);
  assert.match(validateKeybinding("Mod-Alt-Escape") ?? "", /单个字母或数字/);
  assert.match(validateKeybinding("Mod-V") ?? "", /平台基础快捷键/);

  const badKeybinding = { ...raw, contributes: { editorCommands: [{ id: "baseforgelab.editor-kit.timestamp", title: "x", keybinding: "Shift-K", action: "insert-timestamp" }] } };
  assert.match(firstIssue(badKeybinding), /必须包含 Mod 或 Alt/);

  const duplicated = {
    ...raw,
    contributes: {
      editorCommands: [
        { id: "baseforgelab.editor-kit.timestamp", title: "x", keybinding: "Mod-Alt-K", action: "insert-timestamp" },
        { id: "baseforgelab.editor-kit.callout", title: "y", keybinding: "Mod-Alt-K", action: "insert-callout" },
      ],
    },
  };
  assert.match(firstIssue(duplicated), /快捷键不能重复/);
});

test("editorCommands 只能由可执行插件声明（声明式插件无 Action 通道）", () => {
  const declarative = {
    id: "baseforgelab.zero-code",
    publisher: "baseforgelab",
    name: "Zero Code",
    description: "",
    version: "1.0.0",
    apiVersion: 2,
    engines: { baseforge: ">=1.5.0" },
    categories: ["editor"],
    repository: "https://example.com/repo",
    license: "MIT",
    runtime: "declarative",
    permissions: [],
    contributes: { editorCommands: [{ id: "baseforgelab.zero-code.x", title: "x", action: "run" }] },
  };
  assert.notEqual(firstIssue(declarative), "");
  assert.doesNotMatch(firstIssue(declarative), /^$/, "声明式插件必须被拒绝");
});

test("V1 manifest 不受 editorCommands 影响，未声明时仍然解析", () => {
  const v1 = {
    id: "com.baseforge.hello",
    name: "Hello",
    version: "1.0.0",
    apiVersion: 1,
    engines: { baseforge: ">=1.0.0" },
    runtime: "node-action",
    main: "index.js",
    actions: [{ id: "ping", name: "Ping" }],
  };
  const manifest = parsePluginManifest(v1);
  assert.equal(manifest.apiVersion, 1);
});
