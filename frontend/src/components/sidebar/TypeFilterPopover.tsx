/**
 * 侧栏类型筛选：触发行 + 覆盖式两列勾选弹层（回收站/文件管理共用）。
 * - multi=true：多选，「全部」为重置项；标题行显示「清除」
 * - multi=false：单选，点一项即切换为该类型
 * 规格与全站一致：行 h32 / 12px；弹层项 26px / 11px；触发器 h32。
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TypeFilterItem<T extends string> {
  key: T;
  label: string;
  count?: number;
  icon?: React.ReactNode;
}

export function TypeFilterPopover<T extends string>({
  label,
  allLabel = "全部",
  items,
  selected,
  onChange,
  multi = false,
  totalCount,
}: {
  /** 分区标题，如「类型 · 可多选」 */
  label: string;
  /** 「全部」项的文案 */
  allLabel?: string;
  items: Array<TypeFilterItem<T>>;
  /** 已选 key 列表；单选场景传长度为 1 的数组 */
  selected: T[];
  onChange: (keys: T[]) => void;
  multi?: boolean;
  /** 触发器右侧显示的总数（通常是全部条数） */
  totalCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) { setOpen(false); setQuery(""); }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const isAll = selected.length === 1 && selected[0] === items[0]?.key;
  const summary = isAll || selected.length === 0
    ? allLabel
    : selected.length === 1
      ? items.find((item) => item.key === selected[0])?.label || `已选 1 项`
      : `已选 ${selected.length} 项`;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, query]);

  const toggle = (key: T) => {
    if (!multi) { onChange([key]); setOpen(false); return; }
    if (key === items[0]?.key) { onChange([key]); return; }
    const next = selected.includes(key)
      ? selected.filter((k) => k !== key)
      : [...selected.filter((k) => k !== items[0]?.key), key];
    onChange(next.length ? next : [items[0]?.key]);
  };

  const selectedItem = items.find((item) => item.key === selected[0]);

  return (
    <div ref={wrapRef} className="relative border-b border-app-border px-2 py-1.5">
      <div className="flex items-center justify-between pl-1 pr-1 pb-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-tx-tertiary" />
          <span className="min-w-0 truncate text-[12px] font-semibold text-tx-tertiary">{label}</span>
        </span>
        {multi && !isAll ? (
          <button type="button" className="text-[11px] text-accent-primary" onClick={() => onChange([items[0]?.key])}>清除</button>
        ) : null}
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md border px-2 text-[12px] transition-colors",
          open
            ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary"
            : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover",
        )}
      >
        <span className="shrink-0 text-tx-tertiary">{selectedItem?.icon ?? items[0]?.icon}</span>
        <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-tx-tertiary">{totalCount}</span>
        <ChevronDown size={12} className={cn("shrink-0 text-tx-tertiary transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute inset-x-2 top-full z-30 mt-1 overflow-hidden rounded-lg border border-app-border bg-app-elevated shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-app-border bg-app-panel px-2 py-1.5">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索类型"
              className="h-6 min-w-0 flex-1 rounded-md border border-app-border bg-app-bg px-1.5 text-[11.5px] outline-none focus:border-accent-primary/40"
            />
            {multi && (
              <button type="button" className="shrink-0 text-[11px] text-accent-primary" onClick={() => onChange([items[0]?.key, ...items.slice(1).map((item) => item.key)])}>
                全选
              </button>
            )}
          </div>
          <div className="grid max-h-40 grid-cols-2 gap-0.5 overflow-y-auto p-1.5">
            {visible.map((item) => {
              const on = selected.includes(item.key);
              return (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => toggle(item.key)}
                  className={cn(
                    "flex h-7 min-w-0 items-center gap-1.5 rounded px-1.5 text-[11px] transition-colors",
                    on
                      ? "bg-[#e8efff] font-medium text-accent-primary dark:bg-accent-primary/15"
                      : "text-tx-secondary hover:bg-app-hover",
                  )}
                >
                  <span className={cn("flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border text-[8px] leading-none", on ? "border-accent-primary bg-accent-primary text-white" : "border-app-border text-transparent")}>✓</span>
                  <span className="shrink-0 text-tx-tertiary">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                  {item.count !== undefined && <span className="shrink-0 text-[10px] tabular-nums text-tx-tertiary">{item.count}</span>}
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between border-t border-app-border bg-app-panel px-2 py-1 text-[10.5px] text-tx-tertiary">
            <span>共 {items.length} 种类型</span>
            <button type="button" className="text-[11px] text-accent-primary" onClick={() => { setOpen(false); setQuery(""); }}>关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}
