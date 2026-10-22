/**
 * NavRailNext —— 原型 r15 新导航栏（NavRail v2）
 *
 * 视觉与交互事实源：docs/product/base-notes-current.backup-20261017-r15.html
 *
 * 与原型对齐：48px 纯图标 / 64px 图标+文字两档；顶 Logo（48px 头部带对齐）；
 * 核心组（知识库/收藏/回收站/文件管理）→ 插件组 → 底部头像 + 设置沉底；
 * 头像浮窗（260px）：账号区（通知/当前账号/切换/登出）+ 外观区（主题 / 导航栏样式）。
 *
 * 复用既有机制：ViewMode 路由（favorites/trash/files）、useRailMode（icon/label/hidden，
 * hidden 由 App 层强制显示逻辑兜底）、next-themes（storageKey=nowen-note-theme）、
 * OPEN_NOTIFICATIONS_EVENT 通知中心、broadcastLogout 登出。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  ClipboardList,
  FolderOpen,
  Layers,
  Link2,
  ListTodo,
  PenLine,
  LogIn,
  Sparkles,
  Star,
  Trash2,
  UserRound,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";

import { useApp, useAppActions } from "@/store/AppContext";
import { api, broadcastLogout, getCurrentWorkspace } from "@/lib/api";
import { isDesktop as isDesktopApp, clearDesktopLocalAuth } from "@/lib/desktopBridge";
import { BUILTIN_PLUGINS, isBuiltinPluginEnabled, type BuiltinPluginId } from "@/plugins/builtin/registry";
import { OPEN_NOTIFICATIONS_EVENT } from "@/lib/workspaceIssueNavigation";
import { useRailMode, type RailMode } from "@/hooks/useRailMode";
import { ViewMode, type User, type WorkspaceFeatures } from "@/types";
import { cn } from "@/lib/utils";
import SettingsModal from "@/components/SettingsModal";

type NavItemMode = Extract<
  ViewMode,
  "notebook" | "favorites" | "trash" | "files" | "tasks" | "diary" | "ai-chat" | "shares" | "projects"
> | "plugins";

interface NavItem {
  mode: NavItemMode | "plugins";
  titleKey: string;
  titleDefault: string;
  icon: (size: number) => React.ReactNode;
}

const CORE_ITEMS: NavItem[] = [
  {
    mode: "notebook",
    titleKey: "sidebarNext.nav.kb",
    titleDefault: "知识库",
    icon: (sz: number) => <Layers size={sz} strokeWidth={2} />,
  },
  {
    mode: "favorites",
    titleKey: "sidebarNext.nav.star",
    titleDefault: "收藏",
    icon: (sz: number) => <Star size={sz} strokeWidth={2} />,
  },
  {
    mode: "trash",
    titleKey: "sidebarNext.nav.trash",
    titleDefault: "回收站",
    icon: (sz: number) => <Trash2 size={sz} strokeWidth={2} />,
  },
  {
    mode: "files",
    titleKey: "sidebarNext.nav.files",
    titleDefault: "文件管理",
    icon: (sz: number) => <FolderOpen size={sz} strokeWidth={2} />,
  },
];

/** 官方插件贡献的导航项：受内置插件启停 + WorkspaceFeatures 叠加判定 */
const PLUGIN_NAV_ITEMS: Array<NavItem & { pluginId: BuiltinPluginId; workspaceFeature: "tasks" | "diaries" | "notes" }> = [
  {
    mode: "tasks",
    titleKey: "sidebarNext.nav.tasks",
    titleDefault: "待办事项",
    icon: (sz: number) => <ListTodo size={sz} strokeWidth={2} />,
    pluginId: "tasks",
    workspaceFeature: "tasks",
  },
  {
    mode: "diary",
    titleKey: "sidebarNext.nav.diary",
    titleDefault: "每日记录",
    icon: (sz: number) => <PenLine size={sz} strokeWidth={2} />,
    pluginId: "diary",
    workspaceFeature: "diaries",
  },
  {
    mode: "ai-chat",
    titleKey: "sidebarNext.nav.ai",
    titleDefault: "AI 问答",
    icon: (sz: number) => <Sparkles size={sz} strokeWidth={2} />,
    pluginId: "ai",
    workspaceFeature: "notes",
  },
  {
    mode: "projects",
    titleKey: "sidebarNext.nav.projects",
    titleDefault: "项目管理",
    icon: (sz: number) => <ClipboardList size={sz} strokeWidth={2} />,
    pluginId: "pm",
    workspaceFeature: "notes",
  },
];

/** 分享管理：固定导航项（非插件），跟随文件管理 */
const SHARES_NAV_ITEM: NavItem = {
  mode: "shares",
  titleKey: "sidebarNext.nav.shares",
  titleDefault: "分享管理",
  icon: (sz: number) => <Link2 size={sz} strokeWidth={2} />,
};

const PLUGIN_ITEMS: NavItem[] = [
  {
    mode: "plugins",
    titleKey: "sidebarNext.nav.plugins",
    titleDefault: "插件",
    icon: (sz: number) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="14.5" y="14.5" width="7" height="7" rx="1.5"/></svg>,
  },
];

/**
 * Rail 徽章自定义（localStorage 持久化）：
 * - hiddenModes：被隐藏的导航项 mode（右键徽章隐藏 / 徽章管理面板恢复）；
 * - pluginGroupCollapsed：插件组折叠（折叠时点「插件」徽章弹出插件菜单）。
 */
type RailCustomization = { hiddenModes: string[]; pluginGroupCollapsed: boolean };
const RAIL_CUSTOMIZATION_KEY = "nowen-rail-customization";

function loadRailCustomization(): RailCustomization {
  try {
    const raw = localStorage.getItem(RAIL_CUSTOMIZATION_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<RailCustomization>) : {};
    return {
      hiddenModes: Array.isArray(parsed.hiddenModes)
        ? parsed.hiddenModes.filter((m): m is string => typeof m === "string")
        : [],
      pluginGroupCollapsed: parsed.pluginGroupCollapsed === true,
    };
  } catch {
    return { hiddenModes: [], pluginGroupCollapsed: false };
  }
}

function saveRailCustomization(value: RailCustomization): void {
  try {
    localStorage.setItem(RAIL_CUSTOMIZATION_KEY, JSON.stringify(value));
  } catch {
    // storage failures are non-fatal
  }
}

function initialsOf(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "U";
  // 中文取前 1 字，英文取前 2 字母大写
  return /[\u4e00-\u9fa5]/.test(trimmed)
    ? trimmed.slice(0, 1)
    : trimmed.slice(0, 2).toUpperCase();
}

export default function NavRailNext({ notificationCount = 0 }: { notificationCount?: number } = {}) {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();
  const [railMode, setRailMode] = useRailMode();
  const { theme, setTheme } = useTheme();

  const [popupOpen, setPopupOpen] = useState(false);
  const [railCustom, setRailCustomState] = useState<RailCustomization>(loadRailCustomization);
  const [badgeMenu, setBadgeMenu] = useState<{ x: number; y: number; item: NavItem | null } | null>(null);
  const [badgeManagerOpen, setBadgeManagerOpen] = useState(false);
  const [pluginGroupMenuOpen, setPluginGroupMenuOpen] = useState(false);
  const [pluginDetail, setPluginDetail] = useState<NavItem | null>(null);

  const setRailCustom = useCallback((next: RailCustomization) => {
    setRailCustomState(next);
    saveRailCustomization(next);
  }, []);

  const isBadgeHidden = useCallback(
    (mode: string) => railCustom.hiddenModes.includes(mode),
    [railCustom],
  );

  const toggleBadge = useCallback(
    (mode: string, shown: boolean) => {
      const hiddenModes = shown
        ? [...railCustom.hiddenModes.filter((m) => m !== mode), mode]
        : railCustom.hiddenModes.filter((m) => m !== mode);
      setRailCustom({ ...railCustom, hiddenModes });
    },
    [railCustom, setRailCustom],
  );
  const [me, setMe] = useState<User | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const avatarBtnRef = useRef<HTMLButtonElement>(null);

  const showLabel = railMode === "label";

  useEffect(() => {
    api.getMe().then((u) => setMe(u)).catch(() => undefined);
  }, []);

  // 头像等用户资料变更后刷新（SecuritySettings 上传/移除头像时广播）
  useEffect(() => {
    const onUserUpdated = () => { api.getMe().then((u) => setMe(u)).catch(() => undefined); };
    window.addEventListener("nowen:user-updated", onUserUpdated);
    return () => window.removeEventListener("nowen:user-updated", onUserUpdated);
  }, []);

  // Rail 激活态跟随侧栏当前视图（语雀式：点击切换的是侧栏视图而非主区）
  const [activeView, setActiveView] = useState<string>("kb");
  useEffect(() => {
    const onSwitch = (event: Event) => {
      const view = (event as CustomEvent<{ view: string }>).detail?.view;
      if (!view) return;
      setActiveView(view === "notebook" ? "kb" : view);
    };
    window.addEventListener("nowen:sidebar-view", onSwitch);
    return () => window.removeEventListener("nowen:sidebar-view", onSwitch);
  }, []);
  // 主区 viewMode 变化（非侧栏触发的路由）同步 Rail 高亮
  useEffect(() => {
    if (state.viewMode === "favorites") setActiveView("star");
    else if (state.viewMode === "trash") setActiveView("trash");
    else if (state.viewMode === "files") setActiveView("files");
    else if (state.viewMode === "notebook") setActiveView("kb");
  }, [state.viewMode]);

  const activeMode: NavItemMode | null = useMemo(() => {
    // activeView 是侧栏视图 id（kb），item.mode 是 ViewMode 语义（notebook）
    const mapped = activeView === "kb" ? "notebook" : activeView;
    if (mapped === "notebook" || mapped === "favorites" || mapped === "trash" || mapped === "files" || mapped === "tasks" || mapped === "diary" || mapped === "ai-chat" || mapped === "shares" || mapped === "projects" || mapped === "plugins") {
      return mapped as NavItemMode;
    }
    return null;
  }, [activeView]);

  // 工作区 feature flags（tasks/diaries 可关）+ 内置插件启停 → 决定插件导航项显隐
  const [features, setFeatures] = useState<WorkspaceFeatures | null>(null);
  const [, forceBuiltinSync] = useState(0);

  useEffect(() => {
    const load = () => {
      const ws = getCurrentWorkspace();
      if (!ws || ws === "personal") { setFeatures(null); return; }
      api.getWorkspaceFeatures(ws).then(setFeatures).catch(() => setFeatures(null));
    };
    load();
    window.addEventListener("nowen:workspace-changed", load);
    window.addEventListener("nowen:workspace-features-changed", load);
    const onBuiltin = () => forceBuiltinSync((n) => n + 1);
    window.addEventListener("nowen:builtin-plugins-changed", onBuiltin);
    return () => {
      window.removeEventListener("nowen:workspace-changed", load);
      window.removeEventListener("nowen:workspace-features-changed", load);
      window.removeEventListener("nowen:builtin-plugins-changed", onBuiltin);
    };
  }, []);

  const isPluginNavVisible = useCallback((pluginId: BuiltinPluginId, feature: "tasks" | "diaries" | "notes") => {
    if (!isBuiltinPluginEnabled(pluginId)) return false;
    if (feature && features && features[feature] === false) return false;
    return true;
  }, [features]);

  // 浮窗点外关闭 / Esc
  useEffect(() => {
    if (!popupOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popupRef.current?.contains(target) && !avatarBtnRef.current?.contains(target)) {
        setPopupOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopupOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [popupOpen]);

  const navigate = useCallback(
    (mode: NavItemMode) => {
      // 插件贡献的导航项（tasks/diary）：切主区到对应全屏中心（Rail 高亮同步走 viewMode-sync）
      if (mode === "tasks" || mode === "diary" || mode === "ai-chat" || mode === "shares" || mode === "projects") {
        if (mode === "projects") {
          window.dispatchEvent(new CustomEvent("nowen:sidebar-view", { detail: { view: "projects" } }));
        }
        actions.setViewMode(mode);
        window.dispatchEvent(new CustomEvent("nowen:sidebar-view", { detail: { view: mode } }));
        return;
      }
      // 语雀式：收藏/回收站/文件管理/插件点击后主区视图不变，侧栏切到对应视图
      window.dispatchEvent(new CustomEvent("nowen:sidebar-view", { detail: { view: mode } }));
    },
    [],
  );

  const handleLogout = useCallback(async () => {
    setPopupOpen(false);
    if (isDesktopApp()) {
      await clearDesktopLocalAuth().catch(() => ({ ok: false }));
      try {
        localStorage.setItem("nowen-prefer-cloud", "1");
      } catch {
        // ignore storage failures
      }
      await broadcastLogout("desktop_logout_session");
    } else {
      await broadcastLogout("user_logout");
    }
    window.location.reload();
  }, []);

  const user = me;
  const displayName = user?.displayName || user?.username || "用户";
  const initials = initialsOf(user?.displayName || user?.username);

  const renderItem = (item: NavItem) => {
    if (item.mode === "plugins") {
      // 插件：切侧栏到插件管理视图（原型 FR-IA-02 语义）
      const plugActive = activeMode === "plugins";
      return (
        <button
          key={item.mode}
          type="button"
          onClick={() => (railCustom.pluginGroupCollapsed ? setPluginGroupMenuOpen(true) : navigate("plugins"))}
          onContextMenu={(e) => { e.preventDefault(); setBadgeMenu({ x: e.clientX, y: e.clientY, item }); }}
          aria-label={t(item.titleKey, { defaultValue: item.titleDefault })}
          title={showLabel ? undefined : t(item.titleKey, { defaultValue: item.titleDefault })}
          className={cn(
            "group relative flex h-11 shrink-0 items-center justify-center rounded-md transition-colors",
            plugActive
              ? "bg-accent-primary/12 text-accent-primary dark:bg-accent-primary/14"
              : "text-tx-secondary hover:bg-[rgba(17,24,39,0.06)] hover:text-tx-primary dark:hover:bg-[rgba(255,255,255,0.07)]",
            showLabel ? "w-[52px] flex-col gap-[3px]" : "w-9",
          )}
        >
          {item.icon(showLabel ? 19 : 21)}
          {showLabel && (
            <span className="max-w-full truncate text-[11px] leading-none text-tx-secondary">
              {t(item.titleKey, { defaultValue: item.titleDefault })}
            </span>
          )}
        </button>
      );
    }
    const active = activeMode === item.mode;
    const navMode = item.mode as NavItemMode;
    return (
      <button
        key={item.mode}
        type="button"
        onClick={() => navigate(navMode)}
        onContextMenu={(e) => { e.preventDefault(); setBadgeMenu({ x: e.clientX, y: e.clientY, item }); }}
        aria-current={active ? "page" : undefined}
        aria-label={t(item.titleKey, { defaultValue: item.titleDefault })}
        title={showLabel ? undefined : t(item.titleKey, { defaultValue: item.titleDefault })}
        className={cn(
          "group relative flex h-11 shrink-0 items-center justify-center rounded-md transition-colors",
          active
            ? "bg-accent-primary/12 text-accent-primary dark:bg-accent-primary/14"
            : "text-tx-secondary hover:bg-[rgba(17,24,39,0.06)] hover:text-tx-primary dark:hover:bg-[rgba(255,255,255,0.07)]",
          showLabel ? "w-[52px] flex-col gap-[3px]" : "w-9",
        )}
      >
        {item.icon(showLabel ? 19 : 21)}
        {showLabel && (
          <span
            className={cn(
              "max-w-full truncate text-[11px] leading-none text-tx-secondary",
              active && "font-medium text-accent-primary",
            )}
          >
            {t(item.titleKey, { defaultValue: item.titleDefault })}
          </span>
        )}
      </button>
    );
  };

  return (
    <nav
      className={cn(
        "relative z-[130] flex h-full shrink-0 flex-col items-center border-r border-app-border bg-app-sidebar pb-2.5 transition-[width]",
        showLabel ? "w-16" : "w-12",
      )}
      data-next-rail=""
      data-active-view={activeView}
    >
      {/* 顶 Logo：与侧栏/编辑器头部同一 48px 线；用项目真实应用图标（原型的笔形 SVG 是占位） */}
      <div className="flex h-12 w-full shrink-0 items-center justify-center border-b border-app-border">
        <img
          src="/base-notes-icon.svg"
          width={32}
          height={32}
          alt=""
          className="h-8 w-8 rounded-[9px]"
        />
      </div>

      <div
        className="flex w-full min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-1 pt-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          e.preventDefault();
          setBadgeMenu({ x: e.clientX, y: e.clientY, item: null });
        }}
      >
        <div className="flex flex-col items-center gap-1">{CORE_ITEMS.filter((item) => !isBadgeHidden(item.mode)).map(renderItem)}</div>
        {!isBadgeHidden("shares") && <div className="flex flex-col items-center gap-1">{renderItem(SHARES_NAV_ITEM)}</div>}
        <div className={cn("my-2 h-px shrink-0 border-t border-app-border", showLabel ? "w-10" : "w-8")} />
        {PLUGIN_ITEMS.filter((item) => !isBadgeHidden(item.mode)).map(renderItem)}
        {(() => {
          if (railCustom.pluginGroupCollapsed) return null;
          const visiblePluginNav = PLUGIN_NAV_ITEMS.filter(
            (item) =>
              !isBadgeHidden(item.mode) &&
              (isPluginNavVisible(item.pluginId, item.workspaceFeature) || activeMode === item.mode),
          );
          if (visiblePluginNav.length === 0) return null;
          return <div className="flex flex-col items-center gap-1">{visiblePluginNav.map(renderItem)}</div>;
        })()}
      </div>

      {/* 徽章右键菜单（空白处右键 = 添加徽章入口） */}
      {badgeMenu ? (
        <div
          className="fixed inset-0 z-[210]"
          onMouseDown={() => setBadgeMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setBadgeMenu(null); }}
        >
          <div
            className="absolute min-w-[168px] rounded-lg border border-app-border bg-app-elevated py-1 text-xs shadow-lg"
            style={{ left: badgeMenu.x, top: badgeMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            role="menu"
          >
            {badgeMenu.item ? (
              <>
                {badgeMenu.item.mode === "plugins" ? (
                  <button
                    type="button"
                    className="flex w-full items-center px-3 py-1.5 text-left hover:bg-app-hover"
                    onClick={() => { setRailCustom({ ...railCustom, pluginGroupCollapsed: !railCustom.pluginGroupCollapsed }); setBadgeMenu(null); }}
                  >
                    {railCustom.pluginGroupCollapsed
                      ? t("railCustom.expandGroup", { defaultValue: "展开插件组" })
                      : t("railCustom.collapseGroup", { defaultValue: "折叠插件组" })}
                  </button>
                ) : null}
                {badgeMenu.item.mode === "tasks" || badgeMenu.item.mode === "diary" || badgeMenu.item.mode === "ai-chat" ? (
                  <button
                    type="button"
                    className="flex w-full items-center px-3 py-1.5 text-left hover:bg-app-hover"
                    onClick={() => { setPluginDetail(badgeMenu.item); setBadgeMenu(null); }}
                  >
                    {t("railCustom.pluginDetails", { defaultValue: "插件详情" })}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="flex w-full items-center px-3 py-1.5 text-left text-red-500 hover:bg-red-500/10"
                  onClick={() => { toggleBadge(badgeMenu.item!.mode, true); setBadgeMenu(null); }}
                >
                  {t("railCustom.hide", {
                    defaultValue: "隐藏“{{name}}”",
                    name: t(badgeMenu.item.titleKey, { defaultValue: badgeMenu.item.titleDefault }),
                  })}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="flex w-full items-center px-3 py-1.5 text-left hover:bg-app-hover"
                onClick={() => { setBadgeManagerOpen(true); setBadgeMenu(null); }}
              >
                {t("railCustom.addBadges", { defaultValue: "添加徽章…" })}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {/* 徽章管理面板（显示/隐藏全部导航项） */}
      {badgeManagerOpen ? (
        <div className="fixed inset-0 z-[205]" onMouseDown={() => setBadgeManagerOpen(false)}>
          <div
            className="absolute left-14 top-16 w-64 rounded-xl border border-app-border bg-app-elevated p-2 shadow-lg"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="px-1 pb-1.5 text-[11px] font-semibold text-tx-secondary">
              {t("railCustom.manageBadges", { defaultValue: "徽章管理" })}
            </p>
            <div className="max-h-72 overflow-y-auto">
              {[...CORE_ITEMS, SHARES_NAV_ITEM, ...PLUGIN_ITEMS, ...PLUGIN_NAV_ITEMS].map((item) => {
                const typed = item as { pluginId?: BuiltinPluginId; workspaceFeature?: "tasks" | "diaries" | "notes" };
                const gate = typed.pluginId && typed.workspaceFeature
                  ? !isPluginNavVisible(typed.pluginId, typed.workspaceFeature)
                  : false;
                const shown = !isBadgeHidden(item.mode) && !gate;
                return (
                  <button
                    key={item.mode}
                    type="button"
                    disabled={gate}
                    onClick={() => toggleBadge(item.mode, shown)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover disabled:opacity-45"
                  >
                    <span className="w-4 shrink-0 text-center text-accent-primary">{shown ? "✓" : ""}</span>
                    <span className="shrink-0 text-tx-secondary">{item.icon(14)}</span>
                    <span className="min-w-0 flex-1 truncate">{t(item.titleKey, { defaultValue: item.titleDefault })}</span>
                    {gate ? (
                      <span className="shrink-0 text-[10px] text-tx-tertiary">
                        {t("railCustom.pluginDisabled", { defaultValue: "插件已停用" })}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className="mt-1.5 border-t border-app-border pt-1.5">
              <button
                type="button"
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-app-hover"
                onClick={() => setRailCustom({ hiddenModes: [], pluginGroupCollapsed: false })}
              >
                {t("railCustom.restoreDefaults", { defaultValue: "恢复默认" })}
              </button>
              <p className="px-2 pt-1 text-[10px] leading-4 text-tx-tertiary">
                {t("railCustom.badgeHint", { defaultValue: "右键徽章可隐藏；右键空白处可重新添加" })}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* 折叠态：点「插件」徽章弹出插件菜单 */}
      {pluginGroupMenuOpen ? (
        <div className="fixed inset-0 z-[205]" onMouseDown={() => setPluginGroupMenuOpen(false)}>
          <div
            className="absolute bottom-16 left-14 w-52 rounded-xl border border-app-border bg-app-elevated p-1 shadow-lg"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {PLUGIN_NAV_ITEMS.filter(
              (item) => !isBadgeHidden(item.mode) && isPluginNavVisible(item.pluginId, item.workspaceFeature),
            ).map((item) => (
              <button
                key={item.mode}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover"
                onClick={() => { setPluginGroupMenuOpen(false); navigate(item.mode); }}
              >
                <span className="shrink-0 text-tx-secondary">{item.icon(15)}</span>
                <span className="min-w-0 flex-1 truncate">{t(item.titleKey, { defaultValue: item.titleDefault })}</span>
              </button>
            ))}
            <button
              type="button"
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-app-hover"
              onClick={() => { setPluginGroupMenuOpen(false); navigate("plugins"); }}
            >
              {t("railCustom.managePlugins", { defaultValue: "管理插件" })}
            </button>
          </div>
        </div>
      ) : null}

      {/* 插件详情弹层 */}
      {pluginDetail ? (
        <div
          className="fixed inset-0 z-[205] flex items-center justify-center bg-black/30"
          onMouseDown={() => setPluginDetail(null)}
        >
          {(() => {
            const def = BUILTIN_PLUGINS.find((p) => p.id === pluginDetail.mode);
            return (
              <div
                className="w-72 rounded-xl border border-app-border bg-app-elevated p-4 shadow-lg"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <p className="text-sm font-semibold text-tx-primary">
                  {def?.name ?? t(pluginDetail.titleKey, { defaultValue: pluginDetail.titleDefault })}
                </p>
                <p className="mt-1 text-xs leading-5 text-tx-secondary">{def?.description ?? ""}</p>
                <p className="mt-2 text-[11px] text-tx-tertiary">
                  {t("railCustom.version", { defaultValue: "版本" })} {def?.version ?? "—"}
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-app-border px-2.5 py-1 text-xs text-tx-secondary hover:bg-app-hover"
                    onClick={() => setPluginDetail(null)}
                  >
                    {t("railCustom.close", { defaultValue: "关闭" })}
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-accent-primary px-2.5 py-1 text-xs font-medium text-white"
                    onClick={() => { setPluginDetail(null); navigate(pluginDetail.mode as NavItemMode); }}
                  >
                    {t("railCustom.openPlugin", { defaultValue: "进入插件" })}
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      ) : null}

      <div className={cn("my-2 h-px shrink-0 border-t border-app-border", showLabel ? "w-10" : "w-8")} />

      {/* 底部：头像（账户菜单） */}
      <div className="relative flex w-full flex-col items-center">
        <button
          ref={avatarBtnRef}
          type="button"
          onClick={() => setPopupOpen((v) => !v)}
          aria-expanded={popupOpen}
          title={t("sidebarNext.nav.account", { defaultValue: "账户菜单" })}
          className="flex h-11 w-full shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[rgba(17,24,39,0.06)] dark:hover:bg-[rgba(255,255,255,0.07)]"
        >
          {me?.avatarUrl ? (
            <img src={api.avatarFileUrl(me.id)} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-primary/12 text-[13px] font-semibold text-accent-primary dark:bg-accent-primary/14">
              {initials}
            </span>
          )}
        </button>

        {/* 头像浮窗（260px，左下弹出，锚定底部） */}
        {popupOpen && (
          <div
            ref={popupRef}
            className="absolute bottom-[68px] left-[calc(100%+8px)] z-[120] w-[260px] rounded-xl border border-app-border bg-app-elevated p-1 text-left shadow-lg"
            role="menu"
          >
            <div className="flex items-center gap-2.5 px-2.5 pb-2 pt-2.5">
              {me?.avatarUrl ? (
                <img src={api.avatarFileUrl(me.id)} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
              ) : (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-primary/12 text-xs font-semibold text-accent-primary dark:bg-accent-primary/14">
                  {initials}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{displayName}</span>
                <span className="block truncate text-[11px] text-tx-tertiary">
                  {user?.email ?? displayName}
                </span>
              </span>
              {user?.role && (
                <span className="shrink-0 rounded-full bg-accent-primary/12 px-2 py-0.5 text-[10px] font-medium text-accent-primary dark:bg-accent-primary/14">
                  {user.role === "admin" ? "Owner" : user.role}
                </span>
              )}
            </div>

            <div className="my-1 border-t border-app-border" />
            <div className="px-2.5 pb-0.5 pt-2 text-[11px] font-medium text-tx-tertiary">
              {t("sidebarNext.nav.accountSection", { defaultValue: "账号" })}
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setPopupOpen(false); window.dispatchEvent(new Event(OPEN_NOTIFICATIONS_EVENT)); }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-tx-primary transition-colors hover:bg-app-hover"
            >
              <Bell size={14} className="shrink-0 text-tx-tertiary" />
              {t("sidebarNext.nav.notifications", { defaultValue: "消息通知" })}
              {notificationCount > 0 && (
                <span className="ml-auto rounded-full bg-accent-danger px-1.5 py-0.5 text-[9px] leading-none text-white">
                  {notificationCount > 99 ? "99+" : notificationCount}
                </span>
              )}
            </button>
            <div className="flex w-full items-center gap-2 rounded-md bg-app-hover px-2.5 py-1.5 text-left text-xs text-tx-primary">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-primary/12 text-[9px] font-semibold text-accent-primary dark:bg-accent-primary/14">
                {initials}
              </span>
              <span className="min-w-0 flex-1 truncate">{displayName}（当前）</span>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleLogout()}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-tx-primary transition-colors hover:bg-app-hover"
            >
              <UserRound size={14} className="shrink-0 text-tx-tertiary" />
              {t("sidebarNext.nav.switchAccount", { defaultValue: "切换账号" })}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleLogout()}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-accent-danger transition-colors hover:bg-app-hover"
            >
              <LogIn size={14} className="shrink-0 rotate-180" />
              {t("sidebarNext.nav.logout", { defaultValue: "登出" })}
            </button>

            <div className="my-1 border-t border-app-border" />
            <div className="px-2.5 pb-0.5 pt-2 text-[11px] font-medium text-tx-tertiary">
              {t("sidebarNext.nav.appearance", { defaultValue: "外观" })}
            </div>
            <div className="flex items-center justify-between gap-2 px-2.5 py-1">
              <span className="text-xs text-tx-primary">{t("sidebarNext.nav.theme", { defaultValue: "主题" })}</span>
              <div className="inline-flex shrink-0 gap-0.5 rounded-md bg-app-hover p-0.5">
                {([
                  ["light", t("sidebarNext.nav.themeLight", { defaultValue: "白天" })],
                  ["dark", t("sidebarNext.nav.themeDark", { defaultValue: "黑夜" })],
                ] as Array<["light" | "dark", string]>).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTheme(value)}
                    className={cn(
                      "whitespace-nowrap rounded border border-transparent px-2.5 py-1 text-[11px] leading-none text-tx-secondary",
                      (theme ?? "light") === value && "border-app-border bg-app-elevated font-medium text-tx-primary",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 px-2.5 py-1">
              <span className="text-xs text-tx-primary">{t("sidebarNext.nav.railStyle", { defaultValue: "导航栏样式" })}</span>
              <div className="inline-flex shrink-0 gap-0.5 rounded-md bg-app-hover p-0.5">
                {([
                  ["icon", t("sidebarNext.nav.railIcon", { defaultValue: "纯图标" })],
                  ["label", t("sidebarNext.nav.railLabel", { defaultValue: "图标+文字" })],
                ] as Array<[RailMode, string]>).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setRailMode(value)}
                    className={cn(
                      "whitespace-nowrap rounded border border-transparent px-2.5 py-1 text-[11px] leading-none text-tx-secondary",
                      railMode === value && "border-app-border bg-app-elevated font-medium text-tx-primary",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 底部：设置沉底 */}
      <button
        type="button"
        onClick={() => setShowSettings(true)}
        aria-label={t("sidebarNext.nav.settings", { defaultValue: "设置" })}
        title={showLabel ? undefined : t("sidebarNext.nav.settings", { defaultValue: "设置" })}
        className={cn(
          "group relative mx-auto flex h-11 shrink-0 items-center justify-center rounded-md text-tx-secondary transition-colors",
          "hover:bg-[rgba(17,24,39,0.06)] hover:text-tx-primary dark:hover:bg-[rgba(255,255,255,0.07)]",
          showLabel ? "w-[52px]" : "w-9",
        )}
      >
        <span className={cn("flex items-center justify-center", showLabel && "flex-col gap-[3px]")}>
          <svg width={showLabel ? 19 : 21} height={showLabel ? 19 : 21} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>
          {showLabel && (
            <span className="max-w-full truncate text-[11px] leading-none text-tx-secondary">
              {t("sidebarNext.nav.settings", { defaultValue: "设置" })}
            </span>
          )}
        </span>
      </button>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </nav>
  );
}
