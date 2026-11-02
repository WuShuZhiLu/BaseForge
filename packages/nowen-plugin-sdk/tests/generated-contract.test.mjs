import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_API_CONTRACT_VERSION,
  CONTRIBUTION_CONTRACT_VERSION,
  CONTRIBUTION_CONTRACT,
  ACTIVITY_BADGE_CONTRIBUTION_LIMITS,
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

test("contribution contract v5+ adds declarative sidebarPanels + activityBadges（B-7 契约先行，运行链路由宿主后续接线）", () => {
  assert.equal(CONTRIBUTION_CONTRACT_VERSION, 6);
  const contributionIds = new Set(CONTRIBUTION_CONTRACT.map((entry) => entry.id));
  assert.equal(contributionIds.has("sidebarPanels"), true);
  assert.equal(contributionIds.has("activityBadges"), true);

  const sidebarPanels = CONTRIBUTION_CONTRACT.find((entry) => entry.id === "sidebarPanels");
  assert.equal(sidebarPanels.since, "2.2");
  assert.equal(sidebarPanels.declarative, true);
  assert.deepEqual([...sidebarPanels.runtimes], ["declarative"]);

  const activityBadges = CONTRIBUTION_CONTRACT.find((entry) => entry.id === "activityBadges");
  assert.equal(activityBadges.since, "2.2");
  assert.equal(activityBadges.declarative, true);
  assert.deepEqual([...activityBadges.runtimes], ["declarative"]);

  assert.deepEqual([...ACTIVITY_BADGE_CONTRIBUTION_LIMITS.targets], ["panel", "tool"]);
  assert.equal(ACTIVITY_BADGE_CONTRIBUTION_LIMITS.maxBadgesPerPlugin, 10);
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
