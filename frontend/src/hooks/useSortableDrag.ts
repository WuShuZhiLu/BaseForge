import { useCallback, useMemo, useState } from "react";

/**
 * 通用拖拽排序 / 移动 / 拖入的落点管理。
 *
 * 设计目标：把「拿起、落点判定、落点视觉」从各列表里抽出来复用——
 * 侧栏区段排序、知识树节点移动、以及后续收藏/标签等列表都用同一套，
 * 避免每个列表各写一份 onDragStart/onDragOver/onDrop 与 class 拼接。
 *
 * 用法：
 *   const drag = useSortableDrag(nodes, {
 *     getId: (node) => node.id,
 *     canDropInto: (node) => node.nodeType === "folder",
 *     canDrop: (source, target, position) => !isDescendant(target.id, source.id),
 *     onDrop: ({ sourceId, targetId, position }) => move(sourceId, targetId, position),
 *   });
 *
 *   <div {...drag.getContainerProps()}>
 *     {nodes.map((node) => (
 *       <div {...drag.getDragProps(node)} className={cn(base, drag.visualFor(node.id))}>…</div>
 *     ))}
 *   </div>
 */

export type DropPosition = "before" | "after" | "into";
export type DropTargetPosition = DropPosition | "root";

export interface DropResult {
  sourceId: string;
  /** null = 落到容器空白区（通常表示移动到根层末尾）。 */
  targetId: string | null;
  position: DropTargetPosition;
}

export interface SortableDragOptions<T> {
  getId: (item: T) => string;
  /** 该条目是否接受"拖入内部"（文件夹/分组）。返回 false 时上下各占 50%。 */
  canDropInto?: (item: T) => boolean;
  /** 该条目此刻是否可被拿起（行内正在重命名等情况返回 false）。默认 true。 */
  canDrag?: (item: T) => boolean;
  /** 额外拒绝规则（不能移入自身子树、固定置顶项等）。 */
  canDrop?: (source: T, target: T, position: DropPosition) => boolean;
  onDrop: (result: DropResult) => void | Promise<void>;
}

export interface SortableDragState<T> {
  /** 正在拖动的条目 id。 */
  sourceId: string | null;
  /** 当前落点预期（用于渲染提示）。 */
  hint: { id: string; position: DropPosition } | null;
  getDragProps: (item: T) => {
    /** 由 canDrag 决定；不可拖时浏览器不会触发 dragstart。 */
    draggable: boolean;
    onDragStart: (event: React.DragEvent) => void;
    onDragOver: (event: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (event: React.DragEvent) => void;
    onDragEnd: () => void;
  };
  /** 容器空白区：拖到这里 = 落到根层/末尾。 */
  getContainerProps: () => {
    onDragOver: (event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
  };
  /** 落点视觉（配合 cn 使用）。 */
  visualFor: (id: string) => string;
  isSource: (id: string) => boolean;
  isHint: (id: string, position: DropPosition) => boolean;
  reset: () => void;
}

const INTO_BAND = 0.3;

/** 根据指针在条目内的位置决定落点：上下各 35%，中间 30% 为"放入"。 */
export function resolveDropPosition(
  event: React.DragEvent,
  allowInto: boolean,
): DropPosition {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
  if (allowInto) {
    if (ratio < (1 - INTO_BAND) / 2) return "before";
    if (ratio > 1 - (1 - INTO_BAND) / 2) return "after";
    return "into";
  }
  return ratio < 0.5 ? "before" : "after";
}

/** 落点视觉：与侧栏面板排序同一套语言（拿起半透明 + 上/下内阴影 + 拖入高亮）。 */
const DROP_VISUALS = {
  source: "opacity-40",
  before: "shadow-[inset_0_14px_18px_-12px_rgba(59,130,246,0.55)]",
  after: "shadow-[inset_0_-14px_18px_-12px_rgba(59,130,246,0.55)]",
  into: "bg-accent-primary/20 ring-1 ring-accent-primary",
} as const;

/** dataTransfer 自定义类型：同容器内拖拽的标记（drop 判定走 state，这里仅为兼容少数 WebView）。 */
const DRAG_DATA_TYPE = "application/x-sortable-drag";

export function useSortableDrag<T>(
  items: T[],
  options: SortableDragOptions<T>,
): SortableDragState<T> {
  const { getId, canDropInto, canDrop, canDrag, onDrop } = options;
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [hint, setHint] = useState<{ id: string; position: DropPosition } | null>(null);

  const byId = useMemo(() => {
    const map = new Map<string, T>();
    for (const item of items) map.set(getId(item), item);
    return map;
  }, [items, getId]);

  const reset = useCallback(() => {
    setSourceId(null);
    setHint(null);
  }, []);

  const getDragProps = useCallback(
    (item: T) => {
      const id = getId(item);
      return {
        draggable: canDrag ? canDrag(item) : true,
        onDragStart: (event: React.DragEvent) => {
          const target = event.currentTarget as HTMLElement;
          event.dataTransfer.effectAllowed = "move";
          // 同时写入 text/plain 与自定义类型：部分 WebView 只认其中一个
          event.dataTransfer.setData("text/plain", id);
          event.dataTransfer.setData(DRAG_DATA_TYPE, id);
          // 让拖影包含整行（默认取元素快照，体感更接近"拿起来"）
          if (target.offsetHeight > 0) event.dataTransfer.setDragImage(target, 24, target.offsetHeight / 2);
          setSourceId(id);
        },
        onDragOver: (event: React.DragEvent) => {
          if (!sourceId || sourceId === id) return;
          const source = byId.get(sourceId);
          const allowInto = canDropInto?.(item) ?? false;
          const position = resolveDropPosition(event, allowInto);
          if (!source || (canDrop && !canDrop(source, item, position))) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          setHint((current) => (
            current?.id === id && current.position === position ? current : { id, position }
          ));
        },
        onDragLeave: () => {
          setHint((current) => (current?.id === id ? null : current));
        },
        onDrop: (event: React.DragEvent) => {
          event.preventDefault();
          event.stopPropagation();
          const currentHint = hint;
          const currentSource = sourceId;
          reset();
          if (!currentSource || !currentHint || currentHint.id !== id) return;
          void onDrop({ sourceId: currentSource, targetId: id, position: currentHint.position });
        },
        onDragEnd: () => reset(),
      };
    },
    [byId, canDrag, canDrop, canDropInto, getId, hint, onDrop, reset, sourceId],
  );

  const getContainerProps = useCallback(
    () => ({
      onDragOver: (event: React.DragEvent) => {
        if (!sourceId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setHint(null);
      },
      onDrop: (event: React.DragEvent) => {
        const currentSource = sourceId;
        const currentHint = hint;
        reset();
        if (!currentSource || currentHint) return;
        event.preventDefault();
        void onDrop({ sourceId: currentSource, targetId: null, position: "root" });
      },
    }),
    [hint, onDrop, reset, sourceId],
  );

  const visualFor = useCallback(
    (id: string) => {
      const classes: string[] = [];
      if (sourceId === id) classes.push(DROP_VISUALS.source);
      if (hint?.id === id) {
        if (hint.position === "before") classes.push(DROP_VISUALS.before);
        else if (hint.position === "after") classes.push(DROP_VISUALS.after);
        else classes.push(DROP_VISUALS.into);
      }
      return classes.join(" ");
    },
    [hint, sourceId],
  );

  return {
    sourceId,
    hint,
    getDragProps,
    getContainerProps,
    visualFor,
    isSource: (id: string) => sourceId === id,
    isHint: (id, position) => hint?.id === id && hint.position === position,
    reset,
  };
}
