// @vitest-environment jsdom

/**
 * PluginsWorkspace 详情页冒烟测试：
 * - 内置插件：localStorage 预选 → 渲染名称/版本/功能贡献区；
 * - 已安装插件：mock pluginApi.list → 页内选中 → 渲染唯一 ID/版本历史/权限区。
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installed: [] as Array<Record<string, unknown>>,
  catalog: [] as Array<Record<string, unknown>>,
  setViewMode: vi.fn(),
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: {} }),
  useAppActions: () => ({ setViewMode: mocks.setViewMode }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getMe: vi.fn(() => Promise.resolve({ role: "admin" })),
  },
}));

vi.mock("@/lib/pluginApi", () => ({
  PLUGIN_CONTRIBUTIONS_CHANGED_EVENT: "nowen:plugin-contributions-changed",
  pluginApi: {
    list: vi.fn(() => Promise.resolve(mocks.installed)),
    registryCatalog: vi.fn(() => Promise.resolve(mocks.catalog)),
    registrySources: vi.fn(() => Promise.resolve([])),
    getRuntimePolicy: vi.fn(() => Promise.resolve({ allowNodeRuntime: true })),
    grant: vi.fn(() => Promise.resolve({})),
    enable: vi.fn(() => Promise.resolve({})),
    disable: vi.fn(() => Promise.resolve({})),
    rollback: vi.fn(() => Promise.resolve({})),
    uninstall: vi.fn(() => Promise.resolve({})),
    installFromRegistry: vi.fn(() => Promise.resolve({ success: true, plugin: {} })),
  },
}));

import PluginsWorkspace from "../PluginsWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function flush() {
  // 等待 mount 时的异步加载（getMe / pluginApi.list）落定并触发重渲染
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderWorkspace() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // render 与异步数据落定放在同一 act 作用域，避免微任务状态更新落在 act 之外
  await act(async () => {
    root.render(<PluginsWorkspace />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { host, root };
}

function text(host: HTMLElement): string {
  return host.textContent || "";
}

beforeEach(() => {
  mocks.installed = [];
  mocks.catalog = [];
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("PluginsWorkspace 插件详情页", () => {
  it("内置插件：渲染名称、版本与功能贡献区", async () => {
    localStorage.setItem("nowen-plugins-workspace-selected", "tasks");
    const { host, root } = await renderWorkspace();

    const content = text(host);
    expect(content).toContain("待办事项");
    expect(content).toContain("v1.0.0");
    expect(content).toContain("官方内置 · tasks");
    expect(content).toContain("功能与贡献");
    expect(content).toContain("侧栏迷你面板：待办");
    expect(content).toContain("已启用");

    act(() => { root.unmount(); });
  });

  it("已安装插件：页内选中后渲染唯一 ID、版本历史与权限区", async () => {
    mocks.installed = [{
      id: "acme.notesync",
      name: "Note Sync",
      description: "第三方笔记同步插件",
      version: "1.2.0",
      runtime: "sandbox-js",
      status: "enabled",
      trustLevel: "community",
      signatureState: "verified",
      publisher: "acme",
      repository: "https://github.com/acme/notesync",
      homepage: "https://acme.example/notesync",
      license: "MIT",
      previousVersion: "1.1.0",
      permissions: [
        { permission: "notes:read", configJson: "{}", granted: 1 },
        { permission: "notes:write", configJson: "{}", granted: 0 },
      ],
      contributes: {
        commands: [{ id: "sync", title: "立即同步", action: "sync" }],
        settings: [{ key: "endpoint", title: "同步地址", type: "string" }],
      },
      versions: [
        { version: "1.2.0", checksum: "a".repeat(64), source: "official-v2", trustLevel: "community", status: "enabled", installedAt: "2026-10-01T00:00:00Z" },
        { version: "1.1.0", checksum: "b".repeat(64), source: "official-v2", trustLevel: "community", status: "enabled", installedAt: "2026-09-01T00:00:00Z" },
      ],
    }];
    const { host, root } = await renderWorkspace();

    // 切到「已安装」分组 → 点击插件进入详情
    const tabs = Array.from(host.querySelectorAll("button"));
    const installedTab = tabs.find((button) => button.textContent === "已安装");
    expect(installedTab).toBeTruthy();
    click(installedTab!);
    await flush();

    const row = Array.from(host.querySelectorAll("button")).find((button) => text(button).includes("acme.notesync"));
    expect(row).toBeTruthy();
    click(row!);
    await flush();

    const content = text(host);
    expect(content).toContain("Note Sync");
    expect(content).toContain("acme.notesync"); // publisher.extension 唯一 ID
    expect(content).toContain("v1.2.0");
    expect(content).toContain("版本历史");
    expect(content).toContain("当前版本");
    expect(content).toContain("读取笔记"); // 权限中文标签
    expect(content).toContain("创建和修改笔记");
    expect(content).toContain("回滚到 v1.1.0"); // 管理员操作
    expect(content).toContain("仓库"); // Overview 外链

    act(() => { root.unmount(); });
  });
});
