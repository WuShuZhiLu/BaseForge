import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

const settings = readSource("src/components/SettingsModal.tsx");
const appRoute = readSource("src/lib/appRoute.ts");

function whitelistIds(): string[] {
  const block = appRoute.match(/SETTINGS_TAB_KEYS = \[([\s\S]*?)\] as const/)?.[1] ?? "";
  return [...block.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]);
}

function tabBlock(): string {
  return settings.match(/const SETTING_TABS = useMemo\(\(\) => \[([\s\S]*?)\], \[t,/)?.[1] ?? "";
}

/**
 * 设置导航改造的契约：分组只做导航层归类，不能漏 tab、不能把 tab 归到不存在的组；
 * 搜索关键词索引必须覆盖全部 tab；每个 tab 都要有真实渲染分支。
 * 这些断言都是源码级契约，不依赖渲染环境。
 */
describe("设置导航分组与搜索契约", () => {
  it("每个 tab 都声明了 group，且 group 都在 SETTINGS_GROUPS 中", () => {
    const block = tabBlock();
    const ids = [...block.matchAll(/\{ id: "([A-Za-z]+)" as const/g)].map((match) => match[1]);
    const groups = [...block.matchAll(/group: "([A-Za-z]+)" as const/g)].map((match) => match[1]);
    const declared = [...(settings.match(/const SETTINGS_GROUPS[^=]*= \[([\s\S]*?)\];/)?.[1] ?? "").matchAll(/id: "([A-Za-z]+)"/g)].map((match) => match[1]);

    expect(ids.length).toBeGreaterThan(0);
    expect(groups).toHaveLength(ids.length);
    expect(declared.length).toBeGreaterThan(0);
    for (const group of groups) expect(declared).toContain(group);
  });

  it("搜索关键词索引覆盖 SETTINGS_TAB_KEYS 的全部 id", () => {
    const block = settings.match(/SETTING_TAB_KEYWORDS: Record<TabId, string> = \{([\s\S]*?)\n\};/)?.[1] ?? "";
    const keys = [...block.matchAll(/^\s*([A-Za-z]+):/gm)].map((match) => match[1]);

    expect(keys.slice().sort()).toEqual(whitelistIds().slice().sort());
  });

  it("每个白名单 id 都有对应的渲染分支（不出现空白设置页）", () => {
    for (const id of whitelistIds()) {
      expect(settings).toContain(`activeTab === "${id}"`);
    }
  });

  it("桌面侧栏有搜索入口，且导航按 SETTINGS_GROUPS 分组渲染", () => {
    expect(settings).toContain('placeholder="搜索设置"');
    expect(settings).toContain("SETTINGS_GROUPS.map");
    expect(settings).toContain("visibleTabs");
  });

  it("设置里不再重复提供远程存储源（源管理只在文件管理里）", () => {
    // 文件管理 → 侧栏「来源」已有一整套源配置（含凭据、测试连接、增删改）。
    // 设置里再放一份会让同一份配置有两个入口，也容易让人以为要配两遍。
    expect(settings).not.toContain("RemoteSourcesSettings");
    expect(whitelistIds()).not.toContain("remote");
  });

  it("MCP 作为 AI 面板的一节渲染，不再单独占 tab", () => {
    const ai = readSource("src/components/AISettingsPanel.tsx");

    expect(whitelistIds()).not.toContain("mcp");
    expect(ai).toContain("McpSettings");
  });

  it("「同步」只在客户端运行时进入导航（浏览器直连服务器时无同步可言）", () => {
    // SyncSettingsTab 在浏览器运行时只会渲染一句「无需另外开启同步」的说明，
    // 而 0.1 只分发 Docker 镜像——对该形态必须隐藏，不能留一个只有一句说明的 tab。
    expect(settings).toContain(
      "const syncSurfaceAvailable = isDesktop() || Capacitor.isNativePlatform();",
    );
    expect(settings).toContain("...(syncSurfaceAvailable ? [{ id: \"sync\"");
    // 不得回退成无条件列出
    expect(settings).not.toMatch(/^ {4}\{ id: "sync" as const/m);
    // 面板与深链渲染分支保留：桌面/原生端仍要能打开
    expect(settings).toContain('activeTab === "sync"');
    expect(whitelistIds()).toContain("sync");
  });
});
