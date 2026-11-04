import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_API_CONTRACT_VERSION,
  CONTRIBUTION_CONTRACT_VERSION,
  CONTRIBUTION_CONTRACT,
  SIDEBAR_PANEL_CONTRIBUTION_LIMITS,
  EDITOR_COMMAND_CONTRIBUTION_LIMITS,
  NOWEN_PLUGIN_ERROR_CATALOG,
  createHostApiCallMock,
} from "../dist/index.js";

test("generated capability contracts expose V2.1 contributions without shrinking legacy errors", async () => {
  assert.equal(HOST_API_CONTRACT_VERSION, 4);
  const contributionIds = new Set(CONTRIBUTION_CONTRACT.map((entry) => entry.id));
  for (const id of ["inboundWebhooks", "noteThemes", "noteTemplates", "promptPacks", "uiComponents"]) assert.equal(contributionIds.has(id), true);
  const errorCodes = new Set(NOWEN_PLUGIN_ERROR_CATALOG.map((entry) => entry.code));
  assert.equal(errorCodes.has("EXTERNAL_FETCH_INVALID_URL"), true);
  assert.equal(errorCodes.has("PLUGIN_ACTION_MISMATCH"), true);
  assert.equal(errorCodes.has("PLUGIN_V21_FEATURE_DISABLED"), true);
  assert.equal(errorCodes.has("PLUGIN_UI_FEATURE_DISABLED"), true);

  const mock = createHostApiCallMock({
    "runtime.capabilities": async () => ({ apiVersion: 2, runtime: "sandbox-js" }),
  });
  assert.deepEqual(await mock.call("runtime.capabilities"), { apiVersion: 2, runtime: "sandbox-js" });
  assert.deepEqual(mock.calls, [{ method: "runtime.capabilities", input: {} }]);
  mock.reset();
  assert.equal(mock.calls.length, 0);
});

test("contribution contract v6 声明 sidebarPanels / mainViewPanels，且不再宣称未实现的 activityBadges", () => {
  assert.equal(CONTRIBUTION_CONTRACT_VERSION, 6);
  const contributionIds = new Set(CONTRIBUTION_CONTRACT.map((entry) => entry.id));
  assert.equal(contributionIds.has("sidebarPanels"), true);

  const sidebarPanels = CONTRIBUTION_CONTRACT.find((entry) => entry.id === "sidebarPanels");
  assert.equal(sidebarPanels.since, "2.2");
  assert.equal(sidebarPanels.declarative, true);
  // 契约原写 declarative-only，但宿主 manifest schema 与 contributions() 都不按 runtime 过滤，
  // sandbox-js / node-action 插件声明面板本来就能装上；契约按实际行为放开，避免"文档说不行、
  // 实际能装"的偏差。
  assert.deepEqual([...sidebarPanels.runtimes], ["declarative", "sandbox-js", "node-action"]);

  // activityBadges 已从契约移除：宿主 manifest schema 从未支持该字段（strict 会拒），
  // 契约却对外宣称可用，属于"承诺了但装不上"。等真正实现（schema + 渲染）再加回来。
  assert.equal(CONTRIBUTION_CONTRACT.find((entry) => entry.id === "activityBadges"), undefined);

  // mainViewPanels 反之：宿主 schema 早已支持（executable + declarative），契约却没列，
  // 导致 SDK 类型里写不出来。现在按 schema 的真实 runtimes 补进契约。
  const mainViewPanels = CONTRIBUTION_CONTRACT.find((entry) => entry.id === "mainViewPanels");
  assert.equal(mainViewPanels.since, "2.2");
  assert.equal(mainViewPanels.declarative, true);
  assert.deepEqual([...mainViewPanels.runtimes], ["declarative", "sandbox-js", "node-action"]);

  assert.equal(SIDEBAR_PANEL_CONTRIBUTION_LIMITS.maxPanelsPerPlugin, 10);
});

test("contribution contract v6 adds executable editorCommands（斜杠菜单 + 快捷键，执行走插件 action）", () => {
  const editorCommands = CONTRIBUTION_CONTRACT.find((entry) => entry.id === "editorCommands");
  assert.equal(editorCommands.since, "2.3");
  assert.equal(editorCommands.declarative, false);
  assert.deepEqual([...editorCommands.runtimes], ["sandbox-js", "node-action"]);
  assert.equal(EDITOR_COMMAND_CONTRIBUTION_LIMITS.maxCommandsPerPlugin, 50);
  assert.deepEqual([...EDITOR_COMMAND_CONTRIBUTION_LIMITS.when], ["editorFocused", "noteOpen"]);
});
