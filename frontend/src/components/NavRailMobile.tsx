import React, { useCallback, useEffect, useState } from "react";
import {
  Bell,
  BrainCircuit,
  CloudOff,
  Columns2,
  Columns3,
  FolderOpen,
  ListTodo,
  Link2,
  LogOut,
  NotebookPen,
  PanelLeft,
  PanelLeftClose,
  Settings,
  Star,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { useSidebarTextStyle } from "@/hooks/useSidebarTextStyle";
import { useMobileRailHidden } from "@/hooks/useMobileRailHidden";
import { useTranslation } from "react-i18next";
import RailUserMenu from "@/components/RailUserMenu";
import ActivityBarBadges from "@/components/sidebar/ActivityBarBadges";
import { useApp, useAppActions } from "@/store/AppContext";
import { api, broadcastLogout, clearServerUrl, getCurrentWorkspace, getServerUrl } from "@/lib/api";
import { ViewMode, WorkspaceFeatures } from "@/types";
import { cn } from "@/lib/utils";
import SettingsModal from "@/components/SettingsModal";
import { RailMode, useRailMode } from "@/hooks/useRailMode";
import {
  clearDesktopLocalAuth,
  getAppInfo,
  getDiagnosticsInfo,
  isDesktop as isDesktopApp,
  switchDesktopToFull,
  type AppInfo,
} from "@/lib/desktopBridge";
import { clearLocalIdMap, clearQueue, getQueueLength } from "@/lib/offlineQueue";
import { AccountLoginHistoryDialog } from "@/components/AccountLoginHistory";
import { isAccountLoginHistorySupported } from "@/lib/accountLoginHistory";
import { OPEN_NOTIFICATIONS_EVENT } from "@/lib/workspaceIssueNavigation";
import { confirm } from "@/components/ui/confirm";

type NavGroup = "workspace" | "modules" | "tools";

interface NavConfigItem {
  icon: React.ReactNode;
  labelKey: string;
  mode: ViewMode;
  feature?: keyof WorkspaceFeatures;
  group: NavGroup;
}

const RAIL_ICON_SIZE = 18;

/**
 * The unified content tree is the primary note-navigation surface. The rail
 * therefore contains only cross-tree filters and independent modules; the old
 * "All Notes" directory/list entry is intentionally retired.
 */

const NAV_CONFIG: NavConfigItem[] = [
  // 注意：mindmaps（脑图中心）已于 2026-10-14 从主导航移除——导图是树内文档，
  // 树里可直接建/打开；viewMode "mindmaps" 路由保留（直连仍可用）。
  { icon: <Star size={RAIL_ICON_SIZE} />, labelKey: "sidebar.favorites", mode: "favorites", feature: "favorites", group: "workspace" },
  { icon: <FolderOpen size={RAIL_ICON_SIZE} />, labelKey: "sidebar.fileManager", mode: "files", feature: "files", group: "workspace" },
  { icon: <Trash2 size={RAIL_ICON_SIZE} />, labelKey: "sidebar.trash", mode: "trash", group: "workspace" },
  { icon: <ListTodo size={RAIL_ICON_SIZE} />, labelKey: "sidebar.tasks", mode: "tasks", feature: "tasks", group: "modules" },
  { icon: <Link2 size={RAIL_ICON_SIZE} />, labelKey: "sidebar.shareManagement", mode: "shares", group: "tools" },
];

export default function NavRailMobile({ variant = "desktop", notificationCount = 0 }: { variant?: "desktop" | "mobile"; notificationCount?: number } = {}) {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();
  const [railMode, setRailMode] = useRailMode();
  const effectiveMode: RailMode = variant === "mobile" && railMode === "hidden" ? "icon" : railMode;
  const showLabel = effectiveMode === "label";
  const isMobile = variant === "mobile";
  const [, setMobileRailHidden] = useMobileRailHidden();
  const [sidebarTextStyle] = useSidebarTextStyle();
  const classicText = sidebarTextStyle === "classic";

  const [features, setFeatures] = useState<WorkspaceFeatures | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [loginHistoryOpen, setLoginHistoryOpen] = useState(false);
  const [desktopInfo, setDesktopInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    const load = () => {
      const ws = getCurrentWorkspace();
      if (!ws || ws === "personal") {
        setFeatures(null);
        return;
      }
      api.getWorkspaceFeatures(ws).then(setFeatures).catch(() => setFeatures(null));
    };
    load();
    window.addEventListener("baseforge:workspace-changed", load);
    window.addEventListener("baseforge:workspace-features-changed", load);
    return () => {
      window.removeEventListener("baseforge:workspace-changed", load);
      window.removeEventListener("baseforge:workspace-features-changed", load);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopApp()) return;
    let cancelled = false;
    getAppInfo()
      .then((info) => {
        if (!cancelled) setDesktopInfo(info ?? null);
      })
      .catch(() => {
        if (!cancelled) setDesktopInfo(null);
      });
    getDiagnosticsInfo()
      .then((diag) => {
        if (!cancelled && diag) setDesktopInfo((previous) => (previous ? { ...previous, ...diag } : previous));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const normalizeUrl = (url: string) => url.replace(/\/+$/, "").toLowerCase();
  const isLoopbackUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    } catch {
      return false;
    }
  };

  const serverUrl = getServerUrl();
  const currentOrigin = typeof window !== "undefined" && window.location.origin.startsWith("http") ? window.location.origin : "";
  const usingDesktopLiteMode = desktopInfo?.mode === "lite";
  const desktopLocalUrl = desktopInfo?.backendPort ? `http://127.0.0.1:${desktopInfo.backendPort}` : "";
  const usingCurrentLocalBackend = !!serverUrl && !!desktopLocalUrl && normalizeUrl(serverUrl) === normalizeUrl(desktopLocalUrl);
  const usingRemoteServer =
    !!serverUrl
    && !usingCurrentLocalBackend
    && (usingDesktopLiteMode || !isLoopbackUrl(serverUrl) || (!!currentOrigin && normalizeUrl(serverUrl) !== normalizeUrl(currentOrigin)));
  const canSwitchBackToLocal = isDesktopApp() && (usingRemoteServer || usingDesktopLiteMode);

  const items = (features ? NAV_CONFIG.filter((item) => !item.feature || features[item.feature] !== false) : NAV_CONFIG)
    // 桌面端：tools 组（任务/小记/AI/分享）收进侧栏底部工具条，Rail 只留知识本体与系统入口；
    // 移动端抽屉空间有限，Rail 保留全部入口（触屏可达性优先）。
    .filter((item) => !(variant === "desktop" && item.group === "tools"));

  const handleClick = useCallback((mode: ViewMode) => {
    actions.setViewMode(mode);
    actions.setSelectedNotebook(null);
    if (isMobile) actions.setMobileSidebar(false);
  }, [actions, isMobile]);

  const handleDesktopCloudButton = useCallback(async () => {
    if (!canSwitchBackToLocal) return;

    const queuedCount = getQueueLength();
    if (queuedCount > 0) {
      const ok = await confirm({
        title: t("sidebar.switchToLocalConfirmWithQueue"),
        confirmText: t("sidebar.switchToLocal"),
        danger: true,
      });
      if (!ok) return;
    }

    const result = await switchDesktopToFull();
    if (result?.ok !== false) return;

      clearQueue();
      clearLocalIdMap();
      await broadcastLogout("switch_to_local");
      try {
        clearServerUrl();
        localStorage.removeItem("baseforge-prefer-cloud");
      localStorage.removeItem("baseforge-offline-queue");
      localStorage.removeItem("baseforge-offline-id-map");
    } catch {
      // ignore storage failures
    }
    window.location.reload();
  }, [canSwitchBackToLocal, t]);

  const handleLogout = useCallback(async () => {
    if (isDesktopApp() && !canSwitchBackToLocal) {
      await clearDesktopLocalAuth().catch(() => ({ ok: false }));
      try {
        localStorage.setItem("baseforge-prefer-cloud", "1");
      } catch {
        // ignore storage failures
      }
      await broadcastLogout("desktop_logout_session");
    } else {
      await broadcastLogout("user_logout");
    }
    window.location.reload();
  }, [canSwitchBackToLocal]);

  const railWidthClass = showLabel ? "w-16" : "w-[50px]";
  const itemBaseClass = showLabel
    ? "relative w-14 py-1.5 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors"
    : "relative w-10 h-10 rounded-lg flex items-center justify-center transition-colors";

  const renderItem = (item: NavConfigItem) => {
    const active = state.viewMode === item.mode;
    const label = t(item.labelKey);
    return (
      <button
        key={item.mode}
        data-mobile-drawer-rail-item=""
        onClick={() => handleClick(item.mode)}
        title={showLabel ? undefined : label}
        aria-label={label}
        className={cn(
          itemBaseClass,
          active ? "bg-accent-primary/12 text-accent-primary" : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
          item.mode === "trash" && !active && "opacity-70 hover:opacity-100",
        )}
      >
        {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent-primary" aria-hidden />}
        {item.icon}
        {showLabel && <span className={cn("text-[10px] leading-none mt-0.5 max-w-full truncate px-1", classicText && "text-tx-tertiary")}>{label}</span>}
      </button>
    );
  };

  const renderNotificationItem = () => {
    const label = t("sidebar.notifications", { defaultValue: "通知" });
    return (
      <button
        key="notifications"
        data-mobile-drawer-rail-item=""
        onClick={() => {
          actions.setMobileSidebar(false);
          window.dispatchEvent(new Event(OPEN_NOTIFICATIONS_EVENT));
        }}
        aria-label={label}
        title={showLabel ? undefined : label}
        className={cn(itemBaseClass, "relative text-tx-tertiary hover:bg-app-hover hover:text-tx-primary")}
      >
        <Bell size={16} />
        {notificationCount > 0 && (
          <span className="absolute right-0 top-0 rounded-full bg-accent-primary px-1 text-[9px] text-white">
            {notificationCount > 99 ? "99+" : notificationCount}
          </span>
        )}
        {showLabel && <span className={cn("text-[10px] leading-none mt-0.5 max-w-full truncate px-1", classicText && "text-tx-tertiary")}>{label}</span>}
      </button>
    );
  };

  const groups: NavGroup[] = ["workspace", "modules", "tools"];
  const mobileNextMode: RailMode = effectiveMode === "label" ? "icon" : "label";
  const MobileSwitchIcon = effectiveMode === "label" ? Columns2 : Columns3;
  return (
    <div
      className={cn(
        isMobile ? "flex md:hidden h-full" : "hidden md:flex h-full",
        "nav-rail vibrancy-sidebar bg-app-sidebar border-r border-app-border flex-col items-center shrink-0 transition-[width] duration-150",
        railWidthClass,
      )}
      style={{ paddingTop: "calc(var(--safe-area-top) + 4px)", paddingBottom: "8px" }}
    >
      {/* 桌面端（方案 B · B1a）：顶部放账号头像菜单——工作空间切换 / 通知 / 成员权限 /
          设置 / 外观 / 快捷键 / 完整页面（过渡）/ 退出登录，账号级入口集中一处。 */}
      {!isMobile && (
        <>
          <RailUserMenu
            onOpenSettings={() => setShowSettings(true)}
            onLogout={handleLogout}
            notificationCount={notificationCount}
            showLabel={showLabel}
          />
          <div className={cn("my-2 border-t border-app-border/60", showLabel ? "w-8" : "w-6")} aria-hidden />
        </>
      )}
      {isMobile ? (
        <>
          <button
            data-mobile-drawer-rail-item=""
            onClick={() => actions.setMobileSidebar(false)}
            title={t("common.close")}
            aria-label={t("common.close")}
            className="w-10 h-10 rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
          >
            <X size={16} />
          </button>
          <button
            data-mobile-rail-hide=""
            onClick={() => setMobileRailHidden(true)}
            title={t("sidebar.hideMobileRail")}
            aria-label={t("sidebar.hideMobileRail")}
            className="w-10 h-10 rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
          >
            <PanelLeftClose size={16} />
          </button>
          <button
            data-mobile-drawer-rail-item=""
            onClick={() => setRailMode(mobileNextMode)}
            title={t(`sidebar.railMode.switchTo.${mobileNextMode}`)}
            aria-label={t(`sidebar.railMode.switchTo.${mobileNextMode}`)}
            className="w-10 h-10 rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
          >
            <MobileSwitchIcon size={16} />
          </button>
        </>
      ) : (
        <button
          data-mobile-drawer-rail-item=""
          onClick={actions.toggleSidebar}
          title={state.sidebarCollapsed ? t("common.expand") : t("common.collapse")}
          aria-label={state.sidebarCollapsed ? t("common.expand") : t("common.collapse")}
          className="w-10 h-10 rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
        >
          {state.sidebarCollapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
        </button>
      )}

      <div className={cn("my-2 border-t border-app-border/60", showLabel ? "w-8" : "w-6")} aria-hidden />

      <div className="flex-1 min-h-0 w-full overflow-y-auto no-scrollbar flex flex-col items-center gap-1 px-1">
        {isMobile ? (
          <>
            {groups.map((group, index) => {
              const groupItems = items.filter((item) => item.group === group);
              if (groupItems.length === 0) return null;
              return (
                <React.Fragment key={group}>
                  {index > 0 && <div className={cn("my-1 border-t border-app-border/60", showLabel ? "w-8" : "w-6")} aria-hidden />}
                  {groupItems.map(renderItem)}
                </React.Fragment>
              );
            })}
            {renderNotificationItem()}
          </>
        ) : (
          /* 桌面端（面板框架 S2）：徽章区 = 固定徽章 + 可折叠「更多」组 + ＋添加徽章；
             点击徽章 = 显示并展开对应面板（接口 lib/sidebarPanels.ts，A 冻结）。
             Rail 左下角「设置」仍由本组件底部按钮承担，保持原位。 */
          <ActivityBarBadges showLabel={showLabel} classicText={classicText} />
        )}
      </div>

      <div className={cn("my-2 border-t border-app-border/60", showLabel ? "w-8" : "w-6")} aria-hidden />

      <button
        data-mobile-drawer-rail-item=""
        onClick={() => setShowSettings(true)}
        title={showLabel ? undefined : t("sidebar.settings")}
        aria-label={t("sidebar.settings")}
        className={cn(itemBaseClass, "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary")}
      >
        <Settings size={16} />
        {showLabel && <span className={cn("text-[10px] leading-none mt-0.5 max-w-full truncate px-1", classicText && "text-tx-tertiary")}>{t("sidebar.settings")}</span>}
      </button>

      {isAccountLoginHistorySupported() && (
        <button
          data-mobile-drawer-rail-item=""
          onClick={() => setLoginHistoryOpen(true)}
          title={showLabel ? undefined : t("auth.loginHistory.title")}
          aria-label={t("auth.loginHistory.title")}
          className={cn(itemBaseClass, "text-tx-tertiary hover:bg-app-hover hover:text-accent-primary")}
        >
          <UsersRound size={16} />
          {showLabel && <span className={cn("text-[10px] leading-none mt-0.5 max-w-full truncate px-1", classicText && "text-tx-tertiary")}>{t("auth.loginHistory.shortTitle")}</span>}
        </button>
      )}

      {isDesktopApp() && canSwitchBackToLocal && (
        <button
          data-mobile-drawer-rail-item=""
          onClick={handleDesktopCloudButton}
          title={showLabel ? undefined : t("sidebar.switchToLocal", "切回本地离线模式")}
          aria-label={t("sidebar.switchToLocal", "切回本地离线模式")}
          className={cn(itemBaseClass, "text-tx-tertiary hover:bg-app-hover hover:text-accent-primary")}
        >
          <CloudOff size={16} />
          {showLabel && <span className={cn("text-[10px] leading-none mt-0.5 max-w-full truncate px-1", classicText && "text-tx-tertiary")}>{t("sidebar.switchToLocalShort", "本地")}</span>}
        </button>
      )}

      {/* 原型：桌面端底部只有设置；登出已在账号菜单里（B1），此处仅移动端保留。 */}
      {isMobile && (
        <button
        data-mobile-drawer-rail-item=""
        onClick={handleLogout}
        title={showLabel ? undefined : t("sidebar.logout")}
        aria-label={t("sidebar.logout")}
        className={cn(itemBaseClass, "text-tx-tertiary hover:text-accent-danger hover:bg-accent-danger/10")}
      >
        <LogOut size={16} />
        {showLabel && <span className={cn("text-[10px] leading-none mt-0.5 max-w-full truncate px-1", classicText && "text-tx-tertiary")}>{t("sidebar.logout")}</span>}
      </button>
      )}

      <AnimatePresence>{showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}</AnimatePresence>
      <AccountLoginHistoryDialog open={loginHistoryOpen} onClose={() => setLoginHistoryOpen(false)} />
    </div>
  );
}
