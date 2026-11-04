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

/** 受控 input 只能通过原生 setter + input 事件驱动（直接改 value 不会触发 React onChange） */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
    description: "社区笔记同步插件",
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
async function openGroup(group: "builtin" | "installed" | "catalog" | "config") {
  await act(async () => {
    window.dispatchEvent(new CustomEvent("nowen:plugin-group", { detail: { group } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 列表行统一是 [data-plugin-row]（行内还要放启停开关，不能整行塞进 button） */
function pluginRow(host: HTMLElement, rowId: string): HTMLElement | null {
  return host.querySelector(`[data-plugin-row="${rowId}"]`);
}

/** 当前渲染的行顺序（内置插件分区的行也带同一属性，未展开时不会出现） */
function rowIds(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll("[data-plugin-row]")).map((el) => el.getAttribute("data-plugin-row") || "");
}

function buttonByLabel(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((button) => (button.textContent || "").trim() === label);
}

/** 已安装分组：点列表行进入插件详情 */
async function openInstalledDetail(host: HTMLElement, pluginId: string) {
  await openGroup("installed");
  const row = pluginRow(host, pluginId);
  expect(row).toBeTruthy();
  click(row!);
  await flush();
}

/** 市场分组：点列表行进入插件详情（市场目录首次进入才懒加载） */
async function openCatalogDetail(host: HTMLElement, pluginId: string) {
  await openGroup("catalog");
  await flush();
  const row = pluginRow(host, pluginId);
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
      description: "社区笔记同步插件",
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

    const row = pluginRow(host, "acme.notesync");
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

  it("管理分组：单一头部行 + 工具条，空态为虚线框，内置插件是同一容器内的分区", async () => {
    const { host, root } = await renderWorkspace();

    // 主区不再带分组 tab，分组只由侧栏事件驱动
    expect(Array.from(host.querySelectorAll("button")).map((button) => button.textContent)).not.toContain("管理");
    await openGroup("installed");

    const content = text(host);
    // ① 头部只有一行：图标 + 15px/600 标题 + 计数徽标；「社区插件」这层二级标题已删除
    const headers = host.querySelectorAll("h1");
    expect(headers).toHaveLength(1);
    expect(headers[0].className).toContain("text-[15px]");
    expect(headers[0].className).toContain("font-semibold");
    expect(headers[0].textContent).toContain("插件");
    expect(headers[0].textContent).toContain("5 个");
    expect(headers[0].querySelector("svg")).toBeTruthy();
    // 「社区插件」不再作为标题/说明出现在页面上（只剩空态主文案里的字样）
    expect(content).not.toContain("从市场或插件包安装的插件");
    expect(Array.from(host.querySelectorAll("h2, h3")).some((el) => el.textContent === "社区插件")).toBe(false);
    expect(host.querySelector("h3")).toBeNull();

    // ② 工具条：搜索框 + 状态 chips + 排序，三者同处一行
    expect(host.querySelector('input[aria-label="搜索已安装插件"]')).toBeTruthy();
    ["全部", "已启用", "已停用"].forEach((label) => {
      expect(buttonByLabel(host, label)).toBeTruthy();
    });
    const sortTrigger = Array.from(host.querySelectorAll("button")).find((button) => (button.textContent || "").includes("排序："));
    expect(sortTrigger).toBeTruthy();
    const toolbar = host.querySelector('input[aria-label="搜索已安装插件"]')?.closest("div.flex");
    expect(toolbar?.className).toContain("h-10");
    // 管理员操作在头部行右侧：[安装插件包 次按钮][检查更新 主按钮]
    expect(buttonByLabel(host, "安装插件包")).toBeTruthy();
    expect(buttonByLabel(host, "检查更新")).toBeTruthy();

    // ③ 空态：虚线容器 + 13px 主文案 + 11px 说明，入口不再用蓝色文字按钮
    const panel = host.querySelector("[data-plugin-list-panel]");
    // 虚线只包住空态自身那块，容器本身是实线（否则会把内置插件区也圈进"空"里）
    expect(panel?.className).not.toContain("border-dashed");
    expect(panel?.querySelector(".border-dashed")).toBeTruthy();
    expect(content).toContain("尚未安装社区插件");
    expect(content).toContain("到市场浏览公开 Registry，安装后会出现在这里");
    const emptyTitle = Array.from(host.querySelectorAll("p")).find((el) => el.textContent === "尚未安装社区插件");
    expect(emptyTitle?.className).toContain("text-[13px]");
    const emptyNote = Array.from(host.querySelectorAll("p")).find((el) => (el.textContent || "").includes("公开 Registry"));
    expect(emptyNote?.className).toContain("text-[11px]");
    expect(buttonByLabel(host, "去市场")).toBeUndefined();
    expect(buttonByLabel(host, "去市场看看")?.className).toContain("rounded-full");

    // 内置插件在同一容器内：32px 分区行，点开才把行接在下面
    const builtinSection = panel?.querySelector("[data-plugin-builtin-section]") as HTMLElement | null;
    expect(builtinSection?.textContent).toContain("内置插件");
    expect(builtinSection?.textContent).toContain("· 5 个");
    expect(builtinSection?.className).toContain("h-8");
    expect(content).not.toContain("待办事项");
    click(builtinSection as HTMLElement);
    expect(text(host)).toContain("待办事项");
    const builtinRow = panel?.querySelector('[data-plugin-row="builtin-tasks"]');
    expect(builtinRow).toBeTruthy();
    expect(builtinRow?.querySelector('[role="switch"]')).toBeTruthy();
    expect(builtinRow?.className).toContain("min-h-[44px]");

    act(() => { root.unmount(); });
  });

  it("工具条：搜索 / 状态 chips / 排序对已装列表真过滤真排序", async () => {
    mocks.installed = [
      installedPlugin({
        id: "acme.beta",
        name: "Beta Sync",
        versions: [{ version: "1.2.0", checksum: "a".repeat(64), source: "official-v2", trustLevel: "community", status: "enabled", installedAt: "2026-10-02T00:00:00Z" }],
      }),
      installedPlugin({
        id: "acme.alpha",
        name: "Alpha Notes",
        status: "disabled",
        versions: [{ version: "0.9.0", checksum: "b".repeat(64), source: "official-v2", trustLevel: "community", status: "disabled", installedAt: "2026-09-01T00:00:00Z" }],
      }),
    ];
    const { host, root } = await renderWorkspace();

    await openGroup("installed");
    // 默认「最近更新」：10-02 的 Beta 在前
    expect(rowIds(host)).toEqual(["acme.beta", "acme.alpha"]);

    // 排序：名称 A-Z
    click(Array.from(host.querySelectorAll("button")).find((button) => (button.textContent || "").includes("排序：")) as Element);
    click(buttonByLabel(host, "名称 A-Z") as Element);
    expect(rowIds(host)).toEqual(["acme.alpha", "acme.beta"]);

    // chips：已停用 / 已启用
    click(buttonByLabel(host, "已停用") as Element);
    expect(rowIds(host)).toEqual(["acme.alpha"]);
    click(buttonByLabel(host, "已启用") as Element);
    expect(rowIds(host)).toEqual(["acme.beta"]);

    // 搜索：按名称 / ID 前端过滤
    typeInto(host.querySelector('input[aria-label="搜索已安装插件"]') as HTMLInputElement, "beta");
    expect(rowIds(host)).toEqual(["acme.beta"]);
    typeInto(host.querySelector('input[aria-label="搜索已安装插件"]') as HTMLInputElement, "zzz");
    expect(text(host)).toContain("没有匹配的插件");

    act(() => { root.unmount(); });
  });

  it("市场 / 配置分组同样是头部行 + 工具条 + 面板容器，不再有二级标题", async () => {
    mocks.catalog = [
      { id: "acme.weather", publisher: "acme", name: "Weather", description: "天气插件", trustLevel: "community", latestVersion: "2.0.0", runtime: "sandbox-js", versions: [{ version: "2.0.0", runtime: "sandbox-js", publishedAt: "2026-10-01T00:00:00Z", permissions: [] }] },
    ];
    const { host, root } = await renderWorkspace();

    await openGroup("catalog");
    await flush();

    // 市场：头部行标题 + 计数徽标，工具条带搜索与排序，容器内是行列表
    expect(host.querySelector("h1")?.textContent).toContain("插件市场");
    expect(host.querySelector("h1")?.textContent).toContain("1 个");
    expect(host.querySelector("h3")).toBeNull();
    expect(host.querySelector('input[aria-label="搜索市场插件"]')).toBeTruthy();
    expect(Array.from(host.querySelectorAll("button")).some((button) => (button.textContent || "").includes("排序："))).toBe(true);
    expect(host.querySelector("[data-plugin-list-panel]")?.className).not.toContain("border-dashed");
    expect(pluginRow(host, "acme.weather")).toBeTruthy();

    // 配置：同一套头部行，没有列表工具条
    await openGroup("config");
    await flush();
    expect(host.querySelector("h1")?.textContent).toContain("插件配置");
    expect(host.querySelector("h3")).toBeTruthy();
    expect(host.querySelector('input[aria-label="搜索已安装插件"]')).toBeNull();
    expect(host.querySelector('input[aria-label="搜索市场插件"]')).toBeNull();

    act(() => { root.unmount(); });
  });

  it("社区插件行：右侧启停开关 + 卸载 hover 操作（管理员）", async () => {
    mocks.installed = [installedPlugin()];
    const { host, root } = await renderWorkspace();

    await openGroup("installed");

    const row = pluginRow(host, "acme.notesync");
    expect(row).toBeTruthy();
    const toggle = row?.querySelector('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    const uninstall = row?.querySelector('button[aria-label="卸载 Note Sync"]');
    expect(uninstall).toBeTruthy();
    // 点行内开关不能跳进详情页
    click(toggle as Element);
    await flush();
    expect(text(host)).not.toContain("版本历史");

    act(() => { root.unmount(); });
  });

  it("配置分组：保留执行边界、Registry 来源与开发者模式", async () => {
    const { host, root } = await renderWorkspace();

    await openGroup("config");

    const content = text(host);
    expect(content).toContain("执行边界");
    expect(content).toContain("Registry 来源与国内镜像");
    expect(content).toContain("开发者模式");
    // 已搬去「管理」分组的内容不再出现在配置分组
    expect(content).not.toContain("安装插件包");

    act(() => { root.unmount(); });
  });

  it("非管理员进入配置分组只看到权限提示", async () => {
    mocks.role = "user";
    const { host, root } = await renderWorkspace();

    await openGroup("config");

    const content = text(host);
    expect(content).toContain("插件配置仅对管理员开放");
    expect(content).not.toContain("安装插件包");
    expect(content).not.toContain("Registry 来源与国内镜像");

    act(() => { root.unmount(); });
  });

  it("非管理员进入管理分组只有社区插件列表，看不到更新与装包入口", async () => {
    mocks.role = "user";
    const { host, root } = await renderWorkspace();

    await openGroup("installed");

    const content = text(host);
    // 只看按钮级入口：空态说明文案里出现「插件包」不算入口
    const buttonLabels = Array.from(host.querySelectorAll("button")).map((button) => (button.textContent || "").trim());
    expect(buttonLabels).not.toContain("检查更新");
    expect(buttonLabels).not.toContain("安装插件包");
    expect(content).toContain("内置插件");

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
