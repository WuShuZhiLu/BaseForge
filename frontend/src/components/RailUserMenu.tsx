import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, LogOut, Shield, User } from "lucide-react";
import {
  Users,
  Link2,
  Settings as SettingsIcon,
  Sparkles,
  Palette,
  Keyboard,
  Bell,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppActions } from "@/store/AppContext";
import { api, getCurrentWorkspace } from "@/lib/api";
import { cn } from "@/lib/utils";
import { OPEN_NOTIFICATIONS_EVENT } from "@/lib/workspaceIssueNavigation";
import { OPEN_SHORTCUT_HELP_EVENT } from "@/components/ShortcutHelpCenter";

/**
 * Rail 顶部「用户头像」菜单（方案 B · B1a）。
 *
 * 设计意图（依据 Notion/思源）：账号级信息不散落在导航里——
 * 工作空间切换、通知、成员权限、设置、外观、快捷键、退出登录集中在一处。
 *
 * 过渡说明：收藏/回收站/附件/分享的「完整页面」暂由本菜单承接，
 * 保证 Rail 面板化期间功能零丢失；B2 页签系统上线后移除这一组。
 */

export const OPEN_WORKSPACE_SWITCHER_EVENT = "nowen:open-workspace-switcher";

interface Props {
  onOpenSettings: () => void;
  onLogout: () => void;
  notificationCount?: number;
  /** 折叠（纯图标）模式下的定位差异。 */
  showLabel?: boolean;
}

export default function RailUserMenu({ onOpenSettings, onLogout, notificationCount = 0, showLabel }: Props) {
  const { t } = useTranslation();
  const actions = useAppActions();
  const [open, setOpen] = useState(false);
  const [workspace, setWorkspace] = useState<{ name: string; role?: string; memberCount?: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    let alive = true;
    const currentId = getCurrentWorkspace();
    api
      .getWorkspaces()
      .then((list) => {
        if (!alive) return;
        const matched = list.find((item) => item.id === currentId) || list[0] || null;
        if (matched) {
          setWorkspace({
            name: matched.name,
            role: matched.role,
            memberCount: (matched as { memberCount?: number }).memberCount,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const workspaceName = workspace?.name || t("account.personalSpace");
  const memberLabel = workspace?.memberCount
    ? t("account.memberCount", { count: workspace.memberCount })
    : workspace?.role === "owner"
      ? t("account.owner")
      : t("account.member");

  const itemClass =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary";

  return (
    <div className="relative" ref={ref} data-rail-user-menu="">
      <button
        type="button"
        data-mobile-drawer-rail-item=""
        onClick={() => setOpen((v) => !v)}
        title={workspaceName}
        aria-label={workspaceName}
        aria-expanded={open}
        className={cn(
          "relative flex items-center justify-center rounded-full transition-colors",
          showLabel ? "h-9 w-9" : "h-9 w-9",
          open ? "ring-2 ring-accent-primary/40" : "hover:ring-2 hover:ring-app-hover",
        )}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-primary/12 text-[11px] font-bold text-accent-primary">
          {workspaceName.slice(0, 1)}
        </span>
        {notificationCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-danger px-1 text-[9px] font-medium text-white">
            {notificationCount > 99 ? "99+" : notificationCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-full top-0 z-[120] ml-2 w-[250px] overflow-hidden rounded-xl border border-app-border bg-app-elevated p-1.5 shadow-2xl">
          <div className="flex items-center gap-2.5 border-b border-app-border px-2 pb-2.5 pt-1.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-primary/12 text-accent-primary">
              <User size={15} />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[12.5px] font-semibold text-tx-primary">{workspaceName}</div>
              <div className="truncate text-[10.5px] text-tx-tertiary">{memberLabel}</div>
            </div>
          </div>

          <div className="py-1">
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_SWITCHER_EVENT));
                setOpen(false);
              }}
            >
              <RefreshCw size={14} className="shrink-0 text-tx-tertiary" />
              <span className="flex-1 truncate">{t("account.switchWorkspace")}</span>
            </button>
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                window.dispatchEvent(new Event(OPEN_NOTIFICATIONS_EVENT));
                setOpen(false);
              }}
            >
              <Bell size={14} className="shrink-0 text-tx-tertiary" />
              <span className="flex-1 truncate">{t("sidebar.notifications", { defaultValue: "通知" })}</span>
              {notificationCount > 0 && (
                <span className="rounded-full bg-accent-danger/10 px-1.5 text-[10px] font-medium text-accent-danger">
                  {notificationCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                onOpenSettings();
                setOpen(false);
              }}
            >
              <Users size={14} className="shrink-0 text-tx-tertiary" />
              <span className="flex-1 truncate">{t("account.members")}</span>
            </button>
          </div>

          <div className="my-1 h-px bg-app-border" />

          <div className="py-1">
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                onOpenSettings();
                setOpen(false);
              }}
            >
              <SettingsIcon size={14} className="shrink-0 text-tx-tertiary" />
              <span className="flex-1 truncate">{t("settings.title", { defaultValue: "设置" })}</span>
              <span className="text-[10.5px] text-tx-quaternary">⌘,</span>
            </button>
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                onOpenSettings();
                setOpen(false);
              }}
            >
              <Palette size={14} className="shrink-0 text-tx-tertiary" />
              <span className="flex-1 truncate">{t("account.appearance")}</span>
            </button>
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                window.dispatchEvent(new Event(OPEN_SHORTCUT_HELP_EVENT));
                setOpen(false);
              }}
            >
              <Keyboard size={14} className="shrink-0 text-tx-tertiary" />
              <span className="flex-1 truncate">{t("account.shortcuts")}</span>
            </button>
          </div>

          {/* 整页入口组已移除（B2 页签系统接管）：分享/附件/回收站均在主区顶栏「工具」菜单内，
              以工具页签形式打开，账号菜单不再重复提供。 */}

          <div className="my-1 h-px bg-app-border" />
          <button
            type="button"
            className={cn(itemClass, "text-accent-danger hover:text-accent-danger")}
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <LogOut size={14} className="shrink-0" />
            <span className="flex-1 truncate">{t("sidebar.logout")}</span>
          </button>
          <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[10px] text-tx-quaternary">
            <Shield size={11} />
            {t("account.localFirst")}
          </div>
        </div>
      )}
    </div>
  );
}
