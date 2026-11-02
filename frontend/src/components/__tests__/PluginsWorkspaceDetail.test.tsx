// @vitest-environment jsdom

/**
 * PluginsWorkspace 详情页冒烟测试：
 * - 内置插件：nowen:plugin-selected 事件选中 → 渲染名称/版本/功能贡献区；
 * - 已安装插件：mock pluginApi.list → 页内选中 → 渲染唯一 ID/版本历史/权限区。
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installed: [] as Array<Record<string, unknown>>,
  catalog: [] as Array<Record<string, unknown>>,
  role: "admin" as string,
  setViewMode: vi.fn(),
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: {} }),
  useAppActions: () => ({ setViewMode: mocks.setViewMode }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getMe: vi.fn(() => Promise.resolve({ role: mocks.role })),
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
    // 详情页「设置与运行」分区与管理分组会在挂载时拉取这些数据
    settings: vi.fn(() => Promise.resolve({})),
    executions: vi.fn(() => Promise.resolve([])),
    connections: vi.fn(() => Promise.resolve([])),
    getDeveloperMode: vi.fn(() => Promise.resolve({ enabled: false, available: false })),
    checkUpdates: vi.fn(() => Promise.resolve([])),
    setRegistrySource: vi.fn(() => Promise.resolve([])),
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

/** 完整的已安装插件记录：详情页会读 runtime/contributes/versions，字段缺失会渲染成空态 */
function installedPlugin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme.notesync",
    name: "Note Sync",
    description: "第三方笔记同步插件",
    version: "1.2.0",
    runtime: "sandbox-js",
    status: "enabled",
    trustLevel: "community",
    signatureState: "verified",
    publisher: "acme",
    permissions: [],
    contributes: {},
    versions: [
      { version: "1.2.0", checksum: "a".repeat(64), source: "official-v2", trustLevel: "community", status: "enabled", installedAt: "2026-10-01T00:00:00Z" },
    ],
    ...overrides,
  };
}

/** 分组导航在侧栏，主区通过事件切分组 */
async function openGroup(group: "builtin" | "installed" | "catalog" | "admin") {
  await act(async () => {
    window.dispatchEvent(new CustomEvent("nowen:plugin-group", { detail: { group } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 已安装分组：点列表行进入插件详情 */
async function openInstalledDetail(host: HTMLElement, pluginId: string) {
  await openGroup("installed");
  const row = Array.from(host.querySelectorAll("button")).find((button) => text(button).includes(pluginId));
  expect(row).toBeTruthy();
  click(row!);
  await flush();
}

/** 市场分组：点列表行进入插件详情（市场目录首次进入才懒加载） */
async function openCatalogDetail(host: HTMLElement, pluginId: string) {
  await openGroup("catalog");
  await flush();
  const row = Array.from(host.querySelectorAll("button")).find((button) => text(button).includes(pluginId));
  expect(row).toBeTruthy();
  click(row!);
  await flush();
}

beforeEach(() => {
  mocks.installed = [];
  mocks.catalog = [];
  mocks.role = "admin";
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("PluginsWorkspace 插件详情页", () => {
  it("内置插件：渲染名称、版本与功能贡献区", async () => {
    const { host, root } = await renderWorkspace();

    // 选中态只由显式事件设置：侧栏点行 → nowen:plugin-selected 直达详情
    await act(async () => {
      window.dispatchEvent(new CustomEvent("nowen:plugin-selected", { detail: { id: "tasks" } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const content = text(host);
    expect(content).toContain("待办事项");
    expect(content).toContain("v1.0.0");
    expect(content).toContain("内置插件 · tasks");
    // 来源按实际标注（待办沿用 nowen note 实现），不再用含糊的"官方内置"
    expect(content).toContain("来自 nowen note");
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

    // 侧栏切到「已安装」分组 → 点击插件进入详情
    await openGroup("installed");

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
    // 设置入口合并到插件中心：详情页直接能改插件自有设置项
    expect(content).toContain("设置与运行");
    expect(content).toContain("插件设置");
    expect(content).toContain("同步地址");

    act(() => { root.unmount(); });
  });

  it("管理分组：管理员可装载本地包、检查更新与 Registry 来源", async () => {
    const { host, root } = await renderWorkspace();

    // 主区不再带分组 tab，分组只由侧栏事件驱动
    expect(Array.from(host.querySelectorAll("button")).map((button) => button.textContent)).not.toContain("管理");
    await openGroup("admin");

    const content = text(host);
    expect(content).toContain("安装插件包");
    expect(content).toContain("检查更新");
    expect(content).toContain("Registry 来源与国内镜像");
    expect(content).toContain("开发者模式");

    act(() => { root.unmount(); });
  });

  it("非管理员进入管理分组只看到权限提示", async () => {
    mocks.role = "user";
    const { host, root } = await renderWorkspace();

    await openGroup("admin");

    const content = text(host);
    expect(content).toContain("插件管理仅对管理员开放");
    expect(content).not.toContain("安装插件包");

    act(() => { root.unmount(); });
  });

  it("已安装插件：external:fetch 展示会访问的域名，超过 6 条折叠", async () => {
    const hosts = [
      "api.openai.com", "api.anthropic.com", "cf.example.com",
      "d.example.com", "e.example.com", "f.example.com",
      "g.example.com", "h.example.com",
    ];
    mocks.installed = [installedPlugin({
      permissions: [{ permission: "external:fetch", configJson: "{}", granted: 0, hosts }],
    })];
    const { host, root } = await renderWorkspace();

    await openInstalledDetail(host, "acme.notesync");

    const content = text(host);
    expect(content).toContain("将访问以下域名：");
    expect(content).toContain("api.openai.com");
    expect(content).toContain("f.example.com"); // 第 6 条仍在内
    expect(content).not.toContain("g.example.com"); // 第 7 条起折叠
    const more = Array.from(host.querySelectorAll("button")).find((button) => text(button).includes("还有 2 个"));
    expect(more).toBeTruthy();

    click(more!);
    expect(text(host)).toContain("h.example.com");

    act(() => { root.unmount(); });
  });

  it("市场详情：external:fetch 也展示会访问的域名", async () => {
    mocks.catalog = [{
      id: "acme.weather",
      publisher: "acme",
      name: "Weather",
      description: "天气插件",
      trustLevel: "community",
      latestVersion: "2.0.0",
      runtime: "sandbox-js",
      versions: [{
        version: "2.0.0",
        runtime: "sandbox-js",
        publishedAt: "2026-10-01T00:00:00Z",
        permissions: ["external:fetch"],
        permissionConfig: { externalFetchHosts: ["api.openweathermap.org", "*.weather.example.com"] },
      }],
    }];
    const { host, root } = await renderWorkspace();

    await openCatalogDetail(host, "acme.weather");

    const content = text(host);
    expect(content).toContain("将访问以下域名：");
    expect(content).toContain("api.openweathermap.org");
    expect(content).toContain("*.weather.example.com");

    act(() => { root.unmount(); });
  });
});
