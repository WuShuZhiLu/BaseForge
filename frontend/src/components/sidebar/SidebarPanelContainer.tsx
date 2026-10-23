import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelLeft, RotateCcw } from "lucide-react";
import {
  readSidebarLayout,
  reorderSidebarPanels,
  reloadSidebarLayoutForWorkspace,
  resetSidebarLayout,
  subscribeSidebarLayout,
  updateSidebarPanel,
  visiblePanelIdsSorted,
  type SidebarLayoutState,
  type SidebarPanelId,
} from "@/lib/sidebarPanels";
import { SIDEBAR_PANELS, type PanelActionKey } from "@/components/sidebar/panelRegistry";
import { useApp } from "@/store/AppContext";
import { readPanelCounts, subscribePanelCounts } from "@/lib/sidebarPanelCounts";
import { useSyncExternalStore } from "react";
import { useRailMode, nextRailMode } from "@/hooks/useRailMode";
import SidebarPanelShell from "@/components/sidebar/SidebarPanelShell";
import { PANEL_CONTENT } from "@/components/sidebar/panels";
import { cn } from "@/lib/utils";

/**
 * 侧栏面板容器（面板框架 S1）
 *
 * 订阅 lib/sidebarPanels 的布局 store，按 order 渲染可见面板；每个面板用 SidebarPanelShell
 * 包一层（标题/计数/按特性动作/折叠/拖拽排序）。
 *
 * 顶部极薄一条「面板 ⋯」= 面板清单（勾选显示 / 取消隐藏 / 重置布局）。
 * 注意：这是面板框架必需的入口，不含其它任何 UI 改动。
 */

export interface SidebarPanelContainerProps {
  /** 文档树内容由 SidebarMobile 注入（依赖 variant 与树视图模式） */
  treeContent: React.ReactNode;
  /** 面板内容映射（未提供的内容会显示占位提示） */
  contents?: Partial<Record<SidebarPanelId, React.ReactNode>>;
}

export default function SidebarPanelContainer({ treeContent, contents }: SidebarPanelContainerProps) {
  const { t } = useTranslation();
  const { state } = useApp();
  const [railMode, setRailMode] = useRailMode();
  // 面板内容上报的计数（如文档树 = 当前空间笔记数）
  const reportedCounts = useSyncExternalStore(subscribePanelCounts, readPanelCounts, readPanelCounts);
  const [, forceRender] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const [menuPanelId, setMenuPanelId] = useState<SidebarPanelId | null>(null);

  useEffect(() => subscribeSidebarLayout(() => forceRender((n) => n + 1)), []);

  // 切换工作区 → 重载该工作区的布局（布局按工作区隔离持久化）
  useEffect(() => {
    const onWorkspaceChanged = () => reloadSidebarLayoutForWorkspace();
    window.addEventListener("nowen:workspace-changed", onWorkspaceChanged);
    return () => window.removeEventListener("nowen:workspace-changed", onWorkspaceChanged);
  }, []);

  const layout: SidebarLayoutState = readSidebarLayout();
  const visibleIds = useMemo(() => visiblePanelIdsSorted(), [layout]);

  const contentFor = useCallback(
    (id: SidebarPanelId): React.ReactNode => {
      if (id === "tree") return treeContent;
      // 1) 内容层 v1（新实现）优先
      const PanelContent = PANEL_CONTENT[id];
      if (PanelContent) return <PanelContent />;
      // 2) SidebarMobile 注入（如标签：需要回调接线）
      if (contents && contents[id]) return contents[id];
      // 3) 尚未迁移的面板：占位提示（B 线交付的后继内容组件登记进 PANEL_CONTENT 即可替换）
      return (
        <p className="px-3 py-4 text-[11.5px] text-tx-tertiary">
          {t("sidebar.panelPending", { defaultValue: "该面板内容待接入" })}
        </p>
      );
    },
    [contents, t, treeContent],
  );

  const handleAction = useCallback((action: PanelActionKey, panelId: SidebarPanelId) => {
    if (action === "refresh") {
      // 内容组件可监听该事件重新拉数据（面板框架统一刷新入口）
      window.dispatchEvent(new CustomEvent("nowen:sidebar-panel-refresh", { detail: { panelId: menuPanelId } }));
      return;
    }
    if (action === "more") setMenuPanelId(panelId);
    // "new" 由具体面板内容自行监听 nowen:sidebar-panel-action 事件
    if (action === "new") {
      window.dispatchEvent(new CustomEvent("nowen:sidebar-panel-action", { detail: { panelId, action } }));
    }
  }, []);

  const handleReorder = useCallback(
    (draggedId: SidebarPanelId, targetId: SidebarPanelId, edge: "before" | "after") => {
      const order = visiblePanelIdsSorted().filter((id) => id !== draggedId);
      const index = order.indexOf(targetId);
      if (index < 0) return;
      order.splice(edge === "before" ? index : index + 1, 0, draggedId);
      reorderSidebarPanels(order);
    },
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-sidebar-panels-container="">
      {/* 面板清单入口（极薄一条） */}
      <div className="relative flex h-[34px] shrink-0 items-center gap-1.5 border-b border-app-border px-2.5">
        <span className="text-[11.5px] font-semibold text-tx-tertiary">
          {t("sidebar.panels", { defaultValue: "面板" })}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-sidebar-panel-list-button=""
          onClick={() => setListOpen((v) => !v)}
          title={t("sidebar.panelList", { defaultValue: "面板清单：添加 / 隐藏 / 重置" })}
          aria-label={t("sidebar.panelList", { defaultValue: "面板清单：添加 / 隐藏 / 重置" })}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
            listOpen ? "bg-app-hover text-tx-primary" : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
          )}
        >
          ⋯
        </button>
        {listOpen && (
          <div
            data-sidebar-panel-list-menu=""
            className="absolute right-2 top-full z-[120] mt-1 w-56 rounded-xl border border-app-border bg-app-elevated p-1.5 shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-tx-quaternary">
              {t("sidebar.panelList", { defaultValue: "面板清单" })}
            </div>
            {Object.values(SIDEBAR_PANELS).map((definition) => {
              const state = layout.panels[definition.id];
              const locked = definition.fixed;
              return (
                <button
                  key={definition.id}
                  type="button"
                  data-sidebar-panel-list-item={definition.id}
                  onClick={() => {
                    if (locked) return;
                    updateSidebarPanel(definition.id, { visible: !state.visible });
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
                    locked ? "cursor-default text-tx-quaternary" : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px]",
                      state.visible ? "border-accent-primary bg-accent-primary text-white" : "border-tx-quaternary",
                    )}
                  >
                    {state.visible ? "✓" : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {t(definition.titleKey, { defaultValue: definition.defaultTitle })}
                  </span>
                  {locked && <span className="text-[10px] text-tx-quaternary">{t("sidebar.panelFixed", { defaultValue: "固定" })}</span>}
                </button>
              );
            })}
            <div className="my-1 h-px bg-app-border" />
            {/* Rail 显示模式切换（原在侧栏标题行；标题行按原型移除后收进本菜单，功能不丢） */}
            <button
              type="button"
              data-sidebar-rail-mode-toggle=""
              onClick={() => setRailMode(nextRailMode(railMode))}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
            >
              <PanelLeft size={13} className="shrink-0 text-tx-tertiary" />
              {t(`sidebar.railMode.switchTo.${nextRailMode(railMode)}`)}
            </button>
            <button
              type="button"
              data-sidebar-panel-reset=""
              onClick={() => resetSidebarLayout()}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
            >
              <RotateCcw size={13} className="shrink-0 text-tx-tertiary" />
              {t("sidebar.panelReset", { defaultValue: "重置布局" })}
            </button>
          </div>
        )}
      </div>

      {/* 面板栈 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" onClick={() => listOpen && setListOpen(false)}>
        {visibleIds.map((id) => {
          const definition = SIDEBAR_PANELS[id];
          const panelState = layout.panels[id];
          // 计数（对照原型）：优先用内容上报值（如文档树 = 当前空间笔记数），
          // 其次用容器能直接获取的：打开的 = 页签数、标签 = 标签数；0 不显示。
          const reported = reportedCounts[definition.id] ?? null;
          const fallbackCount =
            definition.id === "openEditors"
              ? (state.openNoteTabs?.length ?? 0) + (state.openToolTabs?.length ?? 0)
              : definition.id === "tags"
                ? (state.tags?.length ?? 0)
                : null;
          const rawCount = reported ?? fallbackCount;
          const count = rawCount != null && rawCount > 0 ? rawCount : null;
          return (
            <SidebarPanelShell
              key={id}
              definition={definition}
              count={count}
              collapsed={panelState.collapsed}
              onAction={handleAction}
              onReorder={definition.movable ? handleReorder : undefined}
            >
              {contentFor(id)}
            </SidebarPanelShell>
          );
        })}
      </div>

      {/* 面板 ⋯ 菜单 */}
      {menuPanelId && (
        <PanelMenu
          panelId={menuPanelId}
          onClose={() => setMenuPanelId(null)}
          onMove={(direction) => {
            const order = visiblePanelIdsSorted();
            const index = order.indexOf(menuPanelId);
            const target = direction === "up" ? index - 1 : index + 1;
            if (target < 0 || target >= order.length) return;
            const next = [...order];
            [next[index], next[target]] = [next[target], next[index]];
            reorderSidebarPanels(next);
            setMenuPanelId(null);
          }}
          onExpandAll={() => {
            for (const id of visiblePanelIdsSorted()) updateSidebarPanel(id, { collapsed: false });
            setMenuPanelId(null);
          }}
          onCollapseAll={() => {
            for (const id of visiblePanelIdsSorted()) {
              if (SIDEBAR_PANELS[id].fixed) continue;
              updateSidebarPanel(id, { collapsed: true });
            }
            setMenuPanelId(null);
          }}
          onRefresh={() => {
            window.dispatchEvent(new CustomEvent("nowen:sidebar-panel-refresh", { detail: { panelId: menuPanelId } }));
            setMenuPanelId(null);
          }}
          onClosePanel={() => {
            updateSidebarPanel(menuPanelId, { visible: false });
            setMenuPanelId(null);
          }}
          onOnlyThis={() => {
            for (const id of Object.keys(SIDEBAR_PANELS) as SidebarPanelId[]) {
              if (id === menuPanelId) continue;
              if (SIDEBAR_PANELS[id].fixed) continue;
              updateSidebarPanel(id, { visible: false });
            }
            updateSidebarPanel(menuPanelId, { visible: true, collapsed: false });
            setMenuPanelId(null);
          }}
        />
      )}
    </div>
  );
}

function PanelMenu({
  panelId,
  onClose,
  onMove,
  onExpandAll,
  onCollapseAll,
  onClosePanel,
  onOnlyThis,
  onRefresh,
}: {
  panelId: SidebarPanelId;
  onClose: () => void;
  onMove: (direction: "up" | "down") => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onClosePanel: () => void;
  onRefresh: () => void;
  onOnlyThis: () => void;
}) {
  const { t } = useTranslation();
  const definition = SIDEBAR_PANELS[panelId];
  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary";

  return (
    <>
      <div className="fixed inset-0 z-[110]" onClick={onClose} aria-hidden />
      <div
        data-sidebar-panel-menu={panelId}
        className="absolute right-3 top-9 z-[120] w-44 rounded-xl border border-app-border bg-app-elevated p-1.5 shadow-2xl"
      >
        <div className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-tx-quaternary">
          {t(definition.titleKey, { defaultValue: definition.defaultTitle })}
        </div>
        {definition.fixed ? (
          <>
            <button type="button" className={itemClass} onClick={onExpandAll}>
              {t("sidebar.panelExpandAll", { defaultValue: "全部展开" })}
            </button>
            <button type="button" className={itemClass} onClick={onCollapseAll}>
              {t("sidebar.panelCollapseAll", { defaultValue: "全部折叠" })}
            </button>
            <button
              type="button"
              data-sidebar-panel-refresh-menu=""
              className={itemClass}
              onClick={onRefresh}
            >
              {t("sidebar.panelRefresh", { defaultValue: "刷新" })}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={itemClass} onClick={() => onMove("up")}>
              {t("sidebar.panelMoveUp", { defaultValue: "上移" })}
            </button>
            <button type="button" className={itemClass} onClick={() => onMove("down")}>
              {t("sidebar.panelMoveDown", { defaultValue: "下移" })}
            </button>
            {definition.closable && (
              <button type="button" className={itemClass} onClick={onClosePanel}>
                {t("sidebar.panelClose", { defaultValue: "关闭面板" })}
              </button>
            )}
            <button type="button" className={itemClass} onClick={onOnlyThis}>
              {t("sidebar.panelOnly", { defaultValue: "仅显示此面板" })}
            </button>
          </>
        )}
      </div>
    </>
  );
}
