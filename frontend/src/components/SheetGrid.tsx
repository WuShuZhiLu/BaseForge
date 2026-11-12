import React, { useEffect, useMemo, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { moveSheetColumn, moveSheetRow, setSheetCell, sheetCellKey, type SheetDataModel, type SheetRowModel } from "@/lib/sheetModel";

export type SheetSelection = {
  /** 当前焦点单元格（聚焦 / 键盘所在格）。 */
  rowId: string;
  columnId: string;
  /** 区域选择的锚点；与焦点不同即表示矩形多选区域，缺省视为单选。 */
  anchorRowId?: string;
  anchorColumnId?: string;
} | null;

/** 把选区（含 anchor）折算为行/列索引矩形；单格选择也会返回 1×1 矩形。 */
export function resolveSheetSelectionBounds(
  selection: SheetSelection | undefined,
  rows: Array<{ id: string }>,
  columns: Array<{ id: string }>,
): { r1: number; r2: number; c1: number; c2: number } | null {
  if (!selection) return null;
  const rowIndex = new Map(rows.map((row, index) => [row.id, index]));
  const columnIndex = new Map(columns.map((column, index) => [column.id, index]));
  const anchorRow = rowIndex.get(selection.anchorRowId ?? selection.rowId);
  const focusRow = rowIndex.get(selection.rowId);
  const anchorColumn = columnIndex.get(selection.anchorColumnId ?? selection.columnId);
  const focusColumn = columnIndex.get(selection.columnId);
  if (anchorRow === undefined || focusRow === undefined || anchorColumn === undefined || focusColumn === undefined) return null;
  return {
    r1: Math.min(anchorRow, focusRow),
    r2: Math.max(anchorRow, focusRow),
    c1: Math.min(anchorColumn, focusColumn),
    c2: Math.max(anchorColumn, focusColumn),
  };
}

interface Props {
  data: SheetDataModel;
  visibleRows?: SheetRowModel[];
  canEdit?: boolean;
  selection?: SheetSelection;
  onSelect?: (selection: SheetSelection) => void;
  onChange?: (recipe: (data: SheetDataModel) => SheetDataModel) => void;
  filterQuery?: string;
}

export default function SheetGrid({ data, visibleRows = data.rows, canEdit = false, selection, onSelect, onChange, filterQuery = "" }: Props) {
  const [dragRowId, setDragRowId] = useState<string | null>(null);
  const [dragColumnId, setDragColumnId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const rowIndexes = useMemo(() => new Map(data.rows.map((row, index) => [row.id, index])), [data.rows]);
  // 区域多选：拖动 / Shift+点击扩展选区，矩形范围由 anchor → focus 决定。
  const selectingRef = useRef(false);
  const range = useMemo(() => resolveSheetSelectionBounds(selection, data.rows, data.columns), [selection, data.rows, data.columns]);
  useEffect(() => {
    const end = () => { selectingRef.current = false; };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);
  // Read-only workbooks can contain 200,000 cells. Keep only the rows near the viewport mounted.
  const offsets = useMemo(() => {
    const values = [0];
    for (const row of visibleRows) values.push(values[values.length - 1] + row.height);
    return values;
  }, [visibleRows]);
  const first = canEdit ? 0 : Math.max(0, offsets.findIndex((offset) => offset >= Math.max(0, scrollTop - 160)) - 1);
  const last = canEdit ? visibleRows.length : Math.min(visibleRows.length, first + 80);
  const renderedRows = visibleRows.slice(first, last);
  const topPadding = offsets[first];
  const bottomPadding = offsets[visibleRows.length] - offsets[last];
  return (
      <div className="min-h-0 flex-1 overflow-auto" data-swipe-blocker="sheet-grid" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <table className="border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-20">
            <tr>
              <th className="sticky left-0 z-30 h-8 min-w-12 border-b border-r border-app-border bg-app-sidebar text-xs font-medium text-tx-tertiary">#</th>
              {data.columns.map((column) => (
                <th
                  key={column.id}
                  draggable={canEdit}
                  onDragStart={(event) => {
                    setDragColumnId(column.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("application/x-baseforge-sheet-column", column.id);
                  }}
                  onDragOver={(event) => {
                    if (!dragColumnId || dragColumnId === column.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceId = event.dataTransfer.getData("application/x-baseforge-sheet-column") || dragColumnId;
                    if (sourceId && sourceId !== column.id) {
                      const rect = event.currentTarget.getBoundingClientRect();
                      const placement = event.clientX >= rect.left + rect.width / 2 ? "after" : "before";
                      onChange?.(d => moveSheetColumn(d, sourceId, column.id, placement));
                    }
                    setDragColumnId(null);
                  }}
                  onDragEnd={() => setDragColumnId(null)}
                  style={{ width: column.width, minWidth: column.width, maxWidth: column.width }}
                  className={cn(
                    "h-8 border-b border-r border-app-border bg-app-sidebar px-2 text-xs font-medium text-tx-secondary",
                    canEdit && "cursor-grab active:cursor-grabbing",
                    dragColumnId === column.id && "opacity-50",
                  )}
                  title={canEdit ? "拖拽调整列顺序" : column.title}
                >
                  <span className="flex items-center gap-1.5">
                    {canEdit && <GripVertical size={12} className="shrink-0 text-tx-tertiary" />}
                    <span className="truncate">{column.title}</span>
                    <span className="ml-auto text-[9px] font-normal text-tx-tertiary">
                      {column.type === "number" ? "数字" : column.type === "date" ? "日期" : ""}
                    </span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topPadding > 0 && <tr aria-hidden="true"><td colSpan={data.columns.length + 1} style={{ height: topPadding }} /></tr>}
            {renderedRows.map((row) => {
              const sourceIndex = rowIndexes.get(row.id) || 0;
              return (
                <tr key={row.id} style={{ height: row.height }}>
                  <th
                    draggable={canEdit}
                    onDragStart={(event) => {
                      setDragRowId(row.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-baseforge-sheet-row", row.id);
                    }}
                    onDragOver={(event) => {
                      if (!dragRowId || dragRowId === row.id || filterQuery) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (filterQuery) return;
                      const sourceId = event.dataTransfer.getData("application/x-baseforge-sheet-row") || dragRowId;
                      if (sourceId && sourceId !== row.id) {
                        const rect = event.currentTarget.getBoundingClientRect();
                        const placement = event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
                        onChange?.(d => moveSheetRow(d, sourceId, row.id, placement));
                      }
                      setDragRowId(null);
                    }}
                    onDragEnd={() => setDragRowId(null)}
                    className={cn(
                      "sticky left-0 z-10 min-w-12 border-b border-r border-app-border bg-app-sidebar text-xs font-normal text-tx-tertiary",
                      canEdit && !filterQuery && "cursor-grab active:cursor-grabbing",
                      dragRowId === row.id && "opacity-50",
                    )}
                    title={canEdit ? (filterQuery ? "筛选状态下暂不支持拖动行" : "拖拽调整行顺序") : undefined}
                  >
                    <span className="flex items-center justify-center gap-0.5">
                      {canEdit && !filterQuery && <GripVertical size={11} />}
                      {sourceIndex + 1}
                    </span>
                  </th>
                  {data.columns.map((column, columnIndex) => {
                    const inRange = range !== null && sourceIndex >= range.r1 && sourceIndex <= range.r2 && columnIndex >= range.c1 && columnIndex <= range.c2;
                    const isFocus = selection?.rowId === row.id && selection.columnId === column.id;
                    return (
                      <td
                        key={column.id}
                        style={{ width: column.width, minWidth: column.width, maxWidth: column.width }}
                        className={cn(
                          "border-b border-r border-app-border p-0",
                          inRange ? "bg-accent-primary/10" : "bg-app-bg",
                          inRange && "ring-1 ring-inset ring-accent-primary/40",
                          isFocus && "ring-2 ring-inset ring-accent-primary",
                        )}
                        onMouseDown={(event) => {
                          if (event.shiftKey && selection) {
                            onSelect?.({
                              rowId: row.id,
                              columnId: column.id,
                              anchorRowId: selection.anchorRowId ?? selection.rowId,
                              anchorColumnId: selection.anchorColumnId ?? selection.columnId,
                            });
                            return;
                          }
                          selectingRef.current = true;
                          onSelect?.({ rowId: row.id, columnId: column.id, anchorRowId: row.id, anchorColumnId: column.id });
                        }}
                        onMouseEnter={() => {
                          if (!selectingRef.current || !selection) return;
                          onSelect?.({
                            rowId: row.id,
                            columnId: column.id,
                            anchorRowId: selection.anchorRowId ?? selection.rowId,
                            anchorColumnId: selection.anchorColumnId ?? selection.columnId,
                          });
                        }}
                      >
                        {canEdit ? <input
                          type={column.type === "date" ? "date" : "text"}
                          inputMode={column.type === "number" ? "decimal" : undefined}
                          value={data.cells[sheetCellKey(row.id, column.id)] || ""}
                          readOnly={!canEdit}
                          onFocus={() => { if (!selection?.anchorRowId) onSelect?.({ rowId: row.id, columnId: column.id }); }}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            onChange?.(current => setSheetCell(current, row.id, column.id, value));
                          }}
                          className="h-full w-full bg-transparent px-2 outline-none text-tx-primary"
                          style={{ textAlign: column.align }}
                          aria-label={`第 ${sourceIndex + 1} 行 ${column.title} 列`}
                        /> : <div className="px-2 text-tx-primary whitespace-pre-wrap break-words" style={{ textAlign: column.align, maxHeight: row.height, overflow: "hidden" }} title={data.cells[sheetCellKey(row.id, column.id)] || ""}>{data.cells[sheetCellKey(row.id, column.id)] || ""}</div>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {bottomPadding > 0 && <tr aria-hidden="true"><td colSpan={data.columns.length + 1} style={{ height: bottomPadding }} /></tr>}
          </tbody>
        </table>
      </div>
  );
}
