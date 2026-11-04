import React from "react";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 侧栏浮层菜单原语（统一视觉与命中区）。
 *
 * 问题：此前行菜单 / 排序菜单 / 标签菜单 / 新建菜单各写一套 className，
 * 圆角、内边距、行高、图标与危险色各行其是，菜单看起来「挤、散、脏」。
 *
 * 规范：
 *  - 容器：圆角 12、内边距 6、最小宽 192、边框 + 柔和投影
 *  - 行：高 32、图标 14（次要色）、文字 12.5、右侧可挂快捷键/勾选
 *  - 危险行：红字红图标，悬停红底 10%
 *  - 分组标题：10.5 大写小字；分隔线 1px
 */
export const MenuSurface = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function MenuSurface({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        role="menu"
        className={cn(
          "min-w-[192px] rounded-xl border border-app-border bg-app-elevated p-1.5",
          "text-[12.5px] text-tx-primary shadow-[0_12px_32px_rgba(15,23,42,0.14)]",
          className,
        )}
        {...props}
      />
    );
  },
);

export function MenuLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("px-2 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-tx-tertiary", className)}>
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-app-border" />;
}

export interface MenuItemProps {
  /** 行标识：只用于渲染二级菜单时的 key。 */
  id?: string;
  icon?: React.ComponentType<{ size?: number | string; className?: string }>;
  label: React.ReactNode;
  /** 右侧提示（快捷键 / 计数）。 */
  hint?: React.ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  /** 二级菜单：给出即渲染为可展开的子菜单（如“导出”下的各格式）。 */
  children?: MenuSubItem[];
}

/** 二级菜单项：与一级行同样的视觉，只是挂在子菜单面板里。 */
export type MenuSubItem = Omit<MenuItemProps, "children" | "hint" | "checked" | "className">;

export function MenuItem({ icon: Icon, label, hint, checked, danger, disabled, onClick, className, children }: MenuItemProps) {
  const rowClassName = cn(
    "flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors",
    danger
      ? "text-red-600 hover:bg-red-500/10 dark:text-red-400"
      : "text-tx-primary hover:bg-app-hover",
    disabled && "pointer-events-none opacity-40",
    className,
  );
  const iconNode = Icon ? (
    <Icon
      size={14}
      className={cn("shrink-0", danger ? "text-red-500 dark:text-red-400" : "text-tx-tertiary")}
    />
  ) : null;

  if (children && children.length > 0) {
    return (
      <div className="group/sub relative">
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          disabled={disabled}
          className={rowClassName}
        >
          {iconNode}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ChevronRight size={13} className="shrink-0 text-tx-tertiary" />
        </button>
        <div className="absolute left-full top-0 z-[1] hidden pl-1 group-hover/sub:block group-focus-within/sub:block">
          <MenuSurface className="min-w-[176px]">
            {children.map((child) => (
              <MenuItem key={child.id ?? String(child.label)} {...child} />
            ))}
          </MenuSurface>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={rowClassName}
    >
      {iconNode}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint != null && <span className="shrink-0 text-[10.5px] tabular-nums text-tx-tertiary">{hint}</span>}
      {checked && <Check size={13} className="shrink-0 text-accent-primary" />}
    </button>
  );
}
