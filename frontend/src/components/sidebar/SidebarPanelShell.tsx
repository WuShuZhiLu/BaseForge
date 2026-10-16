import React, { useCallback, useRef, useState } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  readSidebarLayout,
  updateSidebarPanel,
  type SidebarPanelId,
} from "@/lib/sidebarPanels";
import type { PanelActionKey, SidebarPanelDefinition } from "@/components/sidebar/panelRegistry";
import { cn } from "@/lib/utils";

/**
 * 面板外壳（面板框架 S1）
 *
 * 统一提供：标题 + 计数 + **按特性配置的头部动作** + 折叠/展开 + 拖拽排序 + 内容区。
 * 内容组件只负责「内容」，不要再自带标题栏（原自带头部的面板已改为内容-only）。
 *
 * 关键口径（用户 2026-10-16）：
 *  - 头部不出现 ✕；「关闭面板」在 ⋯ 菜单里；固定面板不提供关闭与移动；
 *  - 拖拽排序：按住标题栏拖动（不额外画拖拽块柄）。
 */

export interface SidebarPanelShellProps {
  definition: SidebarPanelDefinition;
  count?: number | null;
  collapsed: boolean;
  /** 面板头「更多」与内容里的动作统一由容器注入 */
  onAction?: (action: PanelActionKey, panelId: SidebarPanelId) => void;
  /** 拖拽排序回调（容器负责重排持久化） */
  onReorder?: (draggedId: SidebarPanelId, targetId: SidebarPanelId, edge: "before" | "after") => void;
  children: React.ReactNode;
}

export default function SidebarPanelShell({
  definition,
  count,
  collapsed,
  onAction,
  onReorder,
  children,
}: SidebarPanelShellProps) {
  const { t } = useTranslation();
  const [dropEdge, setDropEdge] = useState<"before" | "after" | null>(null);
  const draggingRef = useRef<SidebarPanelId | null>(null);

  const title = t(definition.titleKey, { defaultValue: definition.defaultTitle });

  const toggleCollapsed = useCallback(() => {
    updateSidebarPanel(definition.id, { collapsed: !readSidebarLayout().panels[definition.id].collapsed });
  }, [definition.id]);

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!definition.movable) return;
      draggingRef.current = definition.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", definition.id);
    },
    [definition.id, definition.movable],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const source = draggingRef.current;
      if (!source || source === definition.id || !definition.movable) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setDropEdge(event.clientY < rect.top + rect.height / 2 ? "before" : "after");
    },
    [definition.id, definition.movable],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const source = draggingRef.current;
      const edge = dropEdge;
      draggingRef.current = null;
      setDropEdge(null);
      if (!source || source === definition.id || !edge || !onReorder) return;
      onReorder(source, definition.id, edge);
    },
    [definition.id, dropEdge, onReorder],
  );

  return (
    <section
      data-sidebar-panel={definition.id}
      className={cn("relative flex min-h-0 flex-col border-b border-app-border", collapsed && "shrink-0")}
    >
      {dropEdge === "before" && (
        <span className="pointer-events-none absolute inset-x-1 top-0 z-10 h-0.5 rounded-full bg-accent-primary" aria-hidden />
      )}
      <div
        data-sidebar-panel-head={definition.id}
        draggable={definition.movable}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={() => setDropEdge(null)}
        onDrop={handleDrop}
        onDragEnd={() => {
          draggingRef.current = null;
          setDropEdge(null);
        }}
        onClick={toggleCollapsed}
        className={cn(
          "flex h-10 shrink-0 items-center gap-1.5 pl-2.5 pr-1.5 text-[12.5px]",
          definition.movable ? "cursor-pointer active:cursor-grabbing" : "cursor-pointer",
        )}
        title={t("sidebar.panelToggleHint", { defaultValue: "点击折叠 / 展开" })}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-tx-tertiary">
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </span>
        <span className="shrink-0 text-tx-tertiary">{definition.icon}</span>
        <span className="min-w-0 truncate font-semibold text-tx-primary">{title}</span>
        {count != null && (
          <span className="shrink-0 rounded-lg bg-app-hover px-1.5 py-px text-[10.5px] tabular-nums text-tx-tertiary">
            {count}
          </span>
        )}
        <span className="flex-1" />
        {definition.actions.includes("new") && (
          <button
            type="button"
            data-sidebar-panel-action="new"
            onClick={(event) => {
              event.stopPropagation();
              onAction?.("new", definition.id);
            }}
            title={t("sidebar.panelNew", { defaultValue: "新建 / 导入" })}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
          >
            <Plus size={14} />
          </button>
        )}
        {definition.actions.includes("refresh") && (
          <button
            type="button"
            data-sidebar-panel-action="refresh"
            onClick={(event) => {
              event.stopPropagation();
              onAction?.("refresh", definition.id);
            }}
            title={t("sidebar.panelRefresh", { defaultValue: "刷新" })}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
          >
            <RotateCw size={13} />
          </button>
        )}
        {definition.actions.includes("more") && (
          <button
            type="button"
            data-sidebar-panel-action="more"
            onClick={(event) => {
              event.stopPropagation();
              onAction?.("more", definition.id);
            }}
            title={t("sidebar.panelMore", { defaultValue: "更多" })}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
          >
            <MoreHorizontal size={14} />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-sidebar-panel-body={definition.id}>
          {children}
        </div>
      )}

      {dropEdge === "after" && (
        <span className="pointer-events-none absolute inset-x-1 bottom-0 z-10 h-0.5 rounded-full bg-accent-primary" aria-hidden />
      )}
    </section>
  );
}
