import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { getCurrentWorkspace } from "@/lib/api";
import {
  DEFAULT_SIDEBAR_LAYOUT,
  readSidebarLayout,
  resetSidebarLayout,
  updateSidebarBadges,
  updateSidebarPanel,
} from "@/lib/sidebarPanels";
import { FIXED_BADGE_IDS, EXTRA_BADGE_CATALOG } from "../../components/sidebar/ActivityBarBadges";

/**
 * 侧栏面板框架 · 徽章区契约（.cmp/COLLAB-BOARD.md 第六节）
 *
 * 用户 2026-10-16 定稿规则：
 *  - 固定徽章 = 文档树 / 标签 / 收藏 / 回收站 / 附件（常驻、不可移除）——对应**侧栏面板**；
 *  - 「其余徽章」收进可折叠的「更多」组（默认折叠，展开态经 updateSidebarBadges 持久化）
 *    ——对应**工具入口**（待办 / 小记 / AI 对话 / 分享管理），点击打开工具页签；
 *  - 「＋ 添加徽章」位于「更多」之下；
 *  - Rail 左下角「设置」保持原位（仍在 NavRailMobile，不在徽章组件内）。
 *
 * 注：2026-10-16 用户澄清「不是让你补齐大纲与时间线面板」，故侧栏面板集合收敛为
 *     tree / openEditors / tags / fav / trash / files 六个真实面板；扩展徽章改为工具入口。
 */

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const BADGES = source("../../components/sidebar/ActivityBarBadges.tsx");
const NAV_RAIL = source("../../components/NavRailMobile.tsx");
const STORE = source("../../lib/sidebarPanels.ts");

function layoutStorageKey(): string {
  return `nowen.sidebar.layout.v2:${getCurrentWorkspace() || "local"}`;
}

beforeEach(() => {
  resetSidebarLayout();
});

describe("固定徽章集合（不可移除）", () => {
  it("固定徽章恰为 文档树/标签/收藏/回收站/附件，顺序稳定", () => {
    expect([...FIXED_BADGE_IDS]).toEqual(["tree", "tags", "fav", "trash", "files"]);
  });

  it("「更多」组候选 = 工具入口（待办/小记/AI 对话/分享管理），不含固定徽章", () => {
    const extraIds = EXTRA_BADGE_CATALOG.map((badge) => badge.id);
    expect(extraIds).toEqual(["tasks", "diary", "ai-chat", "shares"]);
    for (const fixed of FIXED_BADGE_IDS) {
      expect(extraIds).not.toContain(fixed);
    }
  });

  it("侧栏面板集合只含真实面板（不含大纲/时间线等未实现项）", () => {
    expect(STORE).toContain('"tree" | "openEditors" | "tags" | "fav" | "trash" | "files"');
    for (const ghost of ['"outline"', '"timeline"']) {
      expect(STORE).not.toContain(ghost);
    }
  });

  it("徽章组件源码不含 emoji（品牌铁律：线性图标）", () => {
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(BADGES)).toBe(false);
  });
});

describe("徽章交互协议（接口冻结 v1）", () => {
  it("面板徽章点击 = updateSidebarPanel(id, { visible: true, collapsed: false })", () => {
    expect(BADGES).toContain("updateSidebarPanel(id, { visible: true, collapsed: false })");
  });

  it("工具徽章点击 = openToolTab（不是显示侧栏面板）", () => {
    expect(BADGES).toContain("const openTool = useCallback");
    expect(BADGES).toContain("actions.openToolTab(key)");
    expect(BADGES).toContain("active: state.activeToolTab === id");
  });

  it("组件订阅 layout store，写操作只走 update* 接口", () => {
    expect(BADGES).toContain("useSyncExternalStore(subscribeSidebarLayout, readSidebarLayout)");
    expect(BADGES).toContain("updateSidebarBadges(");
    expect(BADGES).not.toContain("localStorage.setItem");
  });

  it("「更多」折叠态经 updateSidebarBadges 持久化（store + localStorage）", () => {
    expect(DEFAULT_SIDEBAR_LAYOUT.badges.extraCollapsed).toBe(true);
    updateSidebarBadges({ extraCollapsed: false });
    expect(readSidebarLayout().badges.extraCollapsed).toBe(false);
    const raw = window.localStorage.getItem(layoutStorageKey());
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).badges.extraCollapsed).toBe(false);
  });

  it("「＋ 添加徽章」与「更多」开关都在徽章组件内（data 标记）", () => {
    expect(BADGES).toContain('data-activity-badge-add=""');
    expect(BADGES).toContain('data-activity-badge-more=""');
    expect(BADGES).toContain('data-activity-badge-extra-group=""');
  });

  it("勾选加入扩展徽章 = 写 badges.extra（去重由 store 保证）", () => {
    updateSidebarBadges({ extra: ["tasks", "tasks", "shares"] });
    expect(readSidebarLayout().badges.extra).toEqual(["tasks", "shares"]);
  });
});

describe("NavRailMobile 接线（设置仍在左下）", () => {
  it("桌面分支渲染 ActivityBarBadges（showLabel/classicText 透传）", () => {
    expect(NAV_RAIL).toContain("<ActivityBarBadges");
    expect(NAV_RAIL).toContain("showLabel={showLabel}");
    expect(NAV_RAIL).toContain("classicText={classicText}");
  });

  it("旧的单选面板渲染已移除（多面板堆叠模型）", () => {
    expect(NAV_RAIL).not.toContain("RAIL_SIDEBAR_PANELS");
    expect(NAV_RAIL).not.toContain("setSidebarPanel");
  });

  it("设置入口仍在 NavRailMobile 底部（徽章区之后渲染，未被移除或改名）", () => {
    const badgesIndex = NAV_RAIL.indexOf("<ActivityBarBadges");
    // 用「设置按钮」自身的 aria-label 标记定位（顶部账号菜单里也有 setShowSettings 调用，不能拿它比较）
    const settingsButtonIndex = NAV_RAIL.indexOf('aria-label={t("sidebar.settings")}');
    expect(badgesIndex).toBeGreaterThan(-1);
    expect(settingsButtonIndex).toBeGreaterThan(badgesIndex);
  });
});

describe("面板显隐语义（store 行为）", () => {
  it("面板徽章点击语义：未见面板变可见且展开", () => {
    updateSidebarPanel("tags", { visible: true, collapsed: false });
    expect(readSidebarLayout().panels.tags).toMatchObject({ visible: true, collapsed: false });
  });

  it("固定面板（文档树）不可隐藏", () => {
    updateSidebarPanel("tree", { visible: false });
    expect(readSidebarLayout().panels.tree.visible).toBe(true);
  });
});
