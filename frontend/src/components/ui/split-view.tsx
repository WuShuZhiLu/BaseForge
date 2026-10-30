import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * 纵向 SplitView（VS Code 侧栏式分组）。
 *
 * 与「每个面板存一个固定像素高、塞进 overflow 列」的旧做法不同，这里把尺寸当成
 * 「容器高度的分配结果」：
 *  - 展开分组的尺寸之和恒等于 (容器高 - 分隔条高之和)，因此既不会溢出、也不留白；
 *  - 折叠分组高度为 0，其份额在归一化时按比例分给其它展开分组；
 *  - 拖动分隔条只调整相邻两组的分配（守恒），各自夹在 minSize 内；
 *  - 双击分隔条 = 恢复默认（展开组均分）；
 *  - 容器尺寸变化用 ResizeObserver 重新归一化。
 *
 * 尺寸由外部以「像素字典 + 持久化」持有；本组件只做布局与交互，不写存储。
 */

export interface SplitViewProps {
  /** 参与布局的分组 id（顺序即渲染顺序）。 */
  itemIds: string[];
  /** 各分组当前尺寸（px），缺省用 defaultSize。 */
  sizes: Record<string, number>;
  /** 拖拽/重置后回写尺寸。 */
  onSizesChange: (next: Record<string, number>) => void;
  /** 折叠的分组：高度为 0，只剩自身渲染的内容（通常是表头）。 */
  collapsedIds?: ReadonlySet<string>;
  /** 分组最小高度（拖动与归一化的下限）。 */
  minSize?: number;
  /** 无记录时的初始高度。 */
  defaultSize?: number;
  /** 分隔条（拖拽把手）高度。 */
  sashSize?: number;
  /** 渲染分组内容；height 为该分组可用的内容高度。 */
  renderItem: (id: string, height: number) => React.ReactNode;
  className?: string;
}

const DEFAULT_MIN = 96;
const DEFAULT_SIZE = 240;
const DEFAULT_SASH = 10;

/** 把一组目标尺寸归一化到可用高度：按比例缩放，保证总和精确等于 available。
 *  空间不足时下限自动放松（按均分），避免 minSize × 组数 > 可用高度反而溢出。 */
function normalize(
  ids: string[],
  desired: number[],
  available: number,
  minSize: number,
): number[] {
  if (ids.length === 0) return [];
  const effectiveMin = Math.min(minSize, Math.floor(available / ids.length));
  const safeAvailable = Math.max(ids.length * effectiveMin, available);
  const total = desired.reduce((sum, value) => sum + value, 0);
  let next: number[];
  if (total <= 0) {
    next = ids.map(() => safeAvailable / ids.length);
  } else {
    const scale = safeAvailable / total;
    next = desired.map((value) => value * scale);
  }
  // 应用下限后把差额补给最大的那个分组，保证总和不变
  let deficit = 0;
  next = next.map((value) => {
    if (value < effectiveMin) {
      deficit += effectiveMin - value;
      return effectiveMin;
    }
    return value;
  });
  if (deficit > 0) {
    let donor = 0;
    for (let i = 1; i < next.length; i += 1) if (next[i] > next[donor]) donor = i;
    next[donor] = Math.max(effectiveMin, next[donor] - deficit);
  }
  const sum = next.reduce((acc, value) => acc + value, 0);
  next[next.length - 1] = Math.max(effectiveMin, next[next.length - 1] + (safeAvailable - sum));
  return next;
}

export function SplitView({
  itemIds,
  sizes,
  onSizesChange,
  collapsedIds,
  minSize = DEFAULT_MIN,
  defaultSize = DEFAULT_SIZE,
  sashSize = DEFAULT_SASH,
  renderItem,
  className,
}: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerHeight(el.clientHeight);
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const expandedIds = useMemo(
    () => itemIds.filter((id) => !(collapsedIds?.has(id) ?? false)),
    [itemIds, collapsedIds],
  );

  /* 折叠分组仍占着表头高度：不把它从可用空间里扣掉，展开的分组就会按整个容器
   * 归一化，把折叠表头挤出视口（表现为「展开把别的面板挤出去」）。 */
  const collapsedRefs = useRef(new Map<string, HTMLDivElement | null>());
  const [collapsedTotal, setCollapsedTotal] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      let total = 0;
      for (const el of collapsedRefs.current.values()) total += el?.offsetHeight ?? 0;
      setCollapsedTotal((current) => (Math.abs(current - total) > 0.5 ? total : current));
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(measure)
      : null;
    for (const el of collapsedRefs.current.values()) if (el) observer?.observe(el);
    return () => observer?.disconnect();
  }, [itemIds, collapsedIds]);

  const sashTotal = Math.max(0, expandedIds.length - 1) * sashSize;
  const available = Math.max(0, containerHeight - sashTotal - collapsedTotal);

  /** id -> 布局高度（展开分组）。 */
  const layout = useMemo(() => {
    const map = new Map<string, number>();
    if (available <= 0) return map;
    const desired = expandedIds.map((id) => sizes[id] ?? defaultSize);
    const normalized = normalize(expandedIds, desired, available, minSize);
    expandedIds.forEach((id, index) => map.set(id, normalized[index]));
    return map;
  }, [expandedIds, sizes, available, defaultSize, minSize]);

  /** 拖动相邻分隔条：只调整这两组，总和守恒。 */
  const handleSashPointerDown = useCallback(
    (beforeId: string, afterId: string) => (event: React.PointerEvent) => {
      event.preventDefault();
      const startY = event.clientY;
      const beforeHeight = layout.get(beforeId) ?? defaultSize;
      const afterHeight = layout.get(afterId) ?? defaultSize;
      const pairTotal = beforeHeight + afterHeight;
      // 拖拽期间的基线：当前布局的完整快照（其总和正好等于可用高度）。
      // 只回写相邻两块会让整体总和偏离可用高度，归一化随即按比例缩放所有分组，
      // 表现为「拖最下面的分隔条时，上面的面板也在轻微抖动」。快照保证总和守恒。
      const snapshot = Object.fromEntries(layout.entries());
      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - startY;
        const nextBefore = Math.min(pairTotal - minSize, Math.max(minSize, beforeHeight + delta));
        const nextAfter = pairTotal - nextBefore;
        onSizesChange({ ...sizes, ...snapshot, [beforeId]: nextBefore, [afterId]: nextAfter });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [layout, minSize, defaultSize, onSizesChange, sizes],
  );

  /** 双击分隔条 = 恢复默认（展开分组均分）。 */
  const handleSashDoubleClick = useCallback(() => {
    if (expandedIds.length === 0 || available <= 0) return;
    const even = available / expandedIds.length;
    const next: Record<string, number> = { ...sizes };
    for (const id of expandedIds) next[id] = even;
    onSizesChange(next);
  }, [expandedIds, available, onSizesChange, sizes]);

  return (
    <div ref={containerRef} className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {itemIds.map((id, index) => {
        const collapsed = collapsedIds?.has(id) ?? false;
        const height = layout.get(id);
        const nextExpanded = itemIds.slice(index + 1).find((nextId) => !(collapsedIds?.has(nextId) ?? false));
        return (
          <React.Fragment key={id}>
            <div
              key={id}
              ref={(el) => {
                if (collapsed && el) collapsedRefs.current.set(id, el);
                else collapsedRefs.current.delete(id);
              }}
              className={cn("min-h-0", collapsed ? "shrink-0" : "shrink-0 overflow-hidden")}
              style={!collapsed && height ? { height } : undefined}
            >
              {renderItem(id, collapsed ? 0 : height ?? 0)}
            </div>
            {!collapsed && nextExpanded && (
              <div
                role="separator"
                aria-orientation="horizontal"
                className="flex shrink-0 cursor-row-resize items-center justify-center border-t border-app-border transition-colors hover:bg-accent-primary/20"
                style={{ height: sashSize }}
                title="拖拽调整面板高度 / 双击恢复默认"
                onPointerDown={handleSashPointerDown(id, nextExpanded)}
                onDoubleClick={handleSashDoubleClick}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
