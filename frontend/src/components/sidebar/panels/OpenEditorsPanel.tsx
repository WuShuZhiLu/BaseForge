import React, { useCallback, useEffect, useState } from "react";
import { FileCode, FileText, Lock, Pin, Star, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp, useAppActions, type OpenNoteTab } from "@/store/AppContext";
import { toolTabMeta } from "@/components/toolTabs";
import { getNextTabAfterClose, useTabNoteOpener } from "@/hooks/useTabNoteOpener";
import { cn } from "@/lib/utils";

/**
 * 「打开的」面板内容（内容层 v1）——**仅内容**，标题/计数/折叠/动作由 SidebarPanelShell 提供。
 *
 * 明细功能：切换 / 关闭页签、右键关闭其他/全部、图标态（置顶/锁定/Markdown/收藏）。
 * 打开笔记统一走 useTabNoteOpener（加载协调器链路，与深链/列表一致）。
 * 监听 nowen:sidebar-panel-refresh 以响应壳头 ⟳。
 */

export default function OpenEditorsPanel() {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ panelId?: string }>).detail;
      if (detail?.panelId && detail.panelId !== "openEditors") return;
      setRefreshToken((n) => n + 1);
    };
    window.addEventListener("nowen:sidebar-panel-refresh", onRefresh);
    return () => window.removeEventListener("nowen:sidebar-panel-refresh", onRefresh);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  const openTabs = state.openNoteTabs ?? [];
  const toolTabs = state.openToolTabs ?? [];

  const openNote = useTabNoteOpener();

  const closeTab = useCallback((tabId: string) => {
    const closingActive = state.activeNote?.id === tabId;
    const nextTab = closingActive ? getNextTabAfterClose(openTabs, tabId) : null;
    actions.closeNoteTab(tabId);
    if (!closingActive) return;
    // 关闭的是当前编辑器：切到相邻页签；没有页签则清空编辑区，
    // 让 AppRouteSync 的写侧 reconcile 一并把 URL 从 /notes/:id 收回 "/"。
    if (nextTab) void openNote(nextTab.id);
    else actions.setActiveNote(null);
  }, [actions, openNote, openTabs, state.activeNote?.id]);

  const closeOthers = useCallback(
    (tab: OpenNoteTab) => {
      actions.setNoteTabs([tab]);
      if (state.activeNote?.id !== tab.id) void openNote(tab.id);
    },
    [actions, openNote, state.activeNote?.id],
  );

  const rowIcon = (tab: OpenNoteTab) => {
    if (tab.pinned) return <Pin size={13} className="shrink-0 fill-accent-primary/20 text-accent-primary" />;
    if (tab.isLocked) return <Lock size={13} className="shrink-0 text-orange-500" />;
    if (tab.contentFormat === "markdown") return <FileCode size={13} className="shrink-0 text-emerald-500" />;
    return <FileText size={13} className="shrink-0 text-tx-tertiary" />;
  };

  const rowClass =
    "group/oe flex h-[26px] items-center gap-2 rounded-md pl-2 pr-1 text-[12.5px] transition-colors cursor-pointer";
  const activeRowClass = "bg-accent-primary/12 font-semibold text-accent-primary";
  const idleRowClass = "text-tx-secondary hover:bg-app-hover hover:text-tx-primary";

  if (openTabs.length === 0 && toolTabs.length === 0) {
    return <p className="px-3 py-3 text-[11.5px] text-tx-tertiary">{t("sidebar.noOpenEditors", { defaultValue: "没有打开的内容" })}</p>;
  }

  return (
    <div className="space-y-0.5 px-2 pb-2.5 pt-1" data-open-editors-content="" data-refresh-token={refreshToken}>
      {openTabs.map((tab) => {
        const active = state.activeNote?.id === tab.id;
        const title = tab.title || t("editorTabs.noTitle");
        return (
          <div
            key={tab.id}
            data-open-note-row={tab.id}
            onClick={() => void openNote(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
            }}
            className={cn(rowClass, active ? activeRowClass : idleRowClass)}
            title={title}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {state.activeNote?.isFavorite === 1 && tab.id === state.activeNote?.id ? (
                <Star size={11} className="fill-amber-400 text-amber-400" />
              ) : null}
            </span>
            {rowIcon(tab)}
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
              aria-label={`${t("editorTabs.close")}：${title}`}
              title={t("editorTabs.close")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-tx-tertiary opacity-60 transition-colors hover:bg-app-active hover:text-tx-primary group-hover/oe:opacity-100"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}

      {toolTabs.map((key) => {
        const meta = toolTabMeta(key);
        const active = state.activeToolTab === key;
        const label = t(meta.labelKey, { defaultValue: meta.defaultLabel });
        return (
          <div
            key={key}
            data-open-tool-row={key}
            onClick={() => actions.setActiveToolTab(key)}
            className={cn(rowClass, active ? activeRowClass : idleRowClass)}
            title={label}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center" />
            <span className="shrink-0 text-tx-tertiary">{meta.icon}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                actions.closeToolTab(key);
              }}
              aria-label={`${t("editorTabs.close")}：${label}`}
              title={t("tabs.closeTool", { defaultValue: "关闭" })}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-tx-tertiary opacity-60 transition-colors hover:bg-app-active hover:text-tx-primary group-hover/oe:opacity-100"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}

      {menu && (
        <div
          className="fixed z-[120] w-44 rounded-lg border border-app-border bg-app-elevated py-1 shadow-xl"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 180)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 120)),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full items-center px-3 py-1.5 text-left text-[12.5px] text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
            onClick={() => {
              closeTab(menu.tabId);
              setMenu(null);
            }}
          >
            {t("editorTabs.close")}
          </button>
          <button
            type="button"
            className="flex w-full items-center px-3 py-1.5 text-left text-[12.5px] text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
            onClick={() => {
              const tab = openTabs.find((item) => item.id === menu.tabId);
              if (tab) closeOthers(tab);
              setMenu(null);
            }}
          >
            {t("editorTabs.closeOtherTabs")}
          </button>
          <button
            type="button"
            className="flex w-full items-center px-3 py-1.5 text-left text-[12.5px] text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
            onClick={() => {
              actions.clearNoteTabs();
              setMenu(null);
            }}
          >
            {t("editorTabs.closeAllTabs")}
          </button>
        </div>
      )}
    </div>
  );
}
