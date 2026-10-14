import React, { useCallback, useEffect, useState } from "react";
import { Table2, ExternalLink, Loader2, AlertTriangle } from "lucide-react";
import SheetGrid from "@/components/SheetGrid";
import { getSheet, saveSheet } from "@/lib/sheetApi";
import { normalizeSheetData, type SheetDataModel } from "@/lib/sheetModel";
import { pushSheetAppPath } from "@/lib/sheetDeepLink";

/**
 * 轻量表格嵌入卡片（阶段 2 · 表格块 ⇆ 表格文档互通，方案 A）。
 *
 * 语法：![[sheet:<uuid>]]（与 ![[mindmap:id]] / ![[note:…#blk:…]] 同属
 * BlockEmbedExtension 的 wiki 嵌入管线，markdown 往返天然保真）。
 * 数据单一来源：表格文档本身（getSheet）。块内可编辑（onChange →
 * saveSheet 乐观锁）；删除表格文档后显示占位。
 */

export function parseSheetEmbedHref(href: string): string | null {
  const match = /^sheet:([0-9a-f-]{36})$/i.exec((href || "").trim());
  return match ? match[1] : null;
}

export function buildSheetEmbedMarkdown(id: string): string | null {
  const normalized = parseSheetEmbedHref(`sheet:${id}`);
  return normalized ? `![[sheet:${normalized}]]` : null;
}

export default function SheetEmbedCard({ href }: { href: string }) {
  const sheetId = parseSheetEmbedHref(href);
  const [data, setData] = useState<SheetDataModel | null>(null);
  const [title, setTitle] = useState<string>("轻量表格");
  const [canEdit, setCanEdit] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  const load = useCallback(async () => {
    if (!sheetId) return;
    setLoading(true);
    setError("");
    try {
      const doc = await getSheet(sheetId);
      setData(normalizeSheetData(doc.data));
      setCanEdit(Boolean(doc.canEdit));
      setUpdatedAt(doc.updatedAt ?? null);
      setTitle(doc.title || "轻量表格");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [sheetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleChange = useCallback(
    (recipe: (data: SheetDataModel) => SheetDataModel) => {
      if (!sheetId || !data) return;
      const next = recipe(data);
      setData(next);
      if (!updatedAt) return;
      void saveSheet(sheetId, next, updatedAt)
        .then((saved) => {
          setUpdatedAt(saved.updatedAt ?? null);
        })
        .catch(() => {
          setError("保存失败，请打开表格编辑器重试");
        });
    },
    [data, sheetId, updatedAt],
  );

  if (!sheetId) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-amber-600">
        <AlertTriangle size={14} />
        无效的表格嵌入链接
      </div>
    );
  }

  return (
    <div
      data-sheet-embed=""
      data-sheet-id={sheetId}
      className="overflow-hidden rounded-xl border border-app-border bg-app-surface"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-app-border bg-app-hover/60 px-3 py-2">
        <Table2 size={14} className="shrink-0 text-sky-500" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-tx-primary">{title}</span>
        <button
          type="button"
          contentEditable={false}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            pushSheetAppPath(sheetId);
          }}
          title="打开表格编辑器"
        >
          <ExternalLink size={12} />
          打开
        </button>
      </div>
      {loading ? (
        <div className="flex h-24 items-center justify-center gap-2 text-xs text-tx-tertiary">
          <Loader2 size={14} className="animate-spin" />
          正在加载表格…
        </div>
      ) : error || !data ? (
        <div className="flex h-24 items-center justify-center gap-2 text-xs text-tx-tertiary">
          <AlertTriangle size={14} className="text-amber-500" />
          {error || "表格不存在或已被删除"}
        </div>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <SheetGrid data={data} canEdit={canEdit} onChange={handleChange} />
        </div>
      )}
    </div>
  );
}
