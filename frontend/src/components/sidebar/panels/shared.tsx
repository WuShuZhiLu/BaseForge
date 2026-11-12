import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { SidebarPanelId } from "@/lib/sidebarPanels";

/**
 * 面板内容公共件（侧栏面板框架 · 内容层 v1，A 维护）
 *
 * 这一层**独立于旧的面板组件**：旧文件原地保留，不再挂载；框架只使用本目录下的内容组件。
 * 约定：
 *  - 内容组件**不自带头部**（标题/计数/动作由 SidebarPanelShell 提供）；
 *  - 统一响应框架刷新协议 `baseforge:sidebar-panel-refresh`（detail = { panelId }）→ 重新拉数据；
 *  - 行高 26px / 字号 12.5px / hover 出底，与面板框架规格一致。
 */

/** 框架刷新协议：壳头 ⟳ 或面板 ⋯ → 刷新。 */
export function usePanelRefresh(panelId: SidebarPanelId, reload: () => void) {
  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ panelId?: string }>).detail;
      if (detail?.panelId && detail.panelId !== panelId) return;
      reload();
    };
    window.addEventListener("baseforge:sidebar-panel-refresh", onRefresh);
    return () => window.removeEventListener("baseforge:sidebar-panel-refresh", onRefresh);
  }, [panelId, reload]);
}

/** 拉取型面板的数据加载小工具（loading + 一次性 fetching 防重入）。 */
export function usePanelData<T>(loader: () => Promise<T>, initial: T) {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void loader()
      .then((value) => {
        if (alive) setData(value);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [loader]);

  useEffect(() => reload(), [reload]);

  return { data, loading, error, reload };
}

export function PanelBody({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2.5 pt-1">{children}</div>;
}

export function PanelFooterButton({ icon, label, onClick }: { icon?: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center justify-center gap-1.5 border-t border-app-border px-3 py-2 text-[12px] text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
    >
      {icon}
      {label}
    </button>
  );
}

/** 面板行（26px）——框架内所有列表共用，避免各面板各写一套行样式。 */
export function PanelRow({
  onClick,
  onContextMenu,
  active,
  title,
  leading,
  trailing,
  children,
}: {
  onClick?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  active?: boolean;
  title?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      className={
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors " +
        (active
          ? "bg-[#e8efff] font-medium text-accent-primary dark:bg-accent-primary/15"
          : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary")
      }
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}

export function PanelEmpty({ text }: { text: string }) {
  return <p className="px-2 py-6 text-center text-[12px] text-tx-tertiary">{text}</p>;
}

export function PanelLoading() {
  return (
    <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-tx-tertiary">
      <Loader2 size={13} className="animate-spin" />…
    </div>
  );
}
