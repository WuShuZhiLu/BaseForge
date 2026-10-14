import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Search, Table2, X } from "lucide-react";
import { knowledgeTreeApi } from "@/lib/knowledgeTreeApi";

/**
 * 轻量表格嵌入选择对话框（斜杠命令「嵌入轻量表格」触发）。
 * 列出知识树中的轻量表格文档（nodeType === "sheet"），选择后由
 * EditorPane 以 ![[sheet:id]] wiki 引用插入当前笔记。
 */

interface Props {
  open: boolean;
  onClose: () => void;
  onInsert: (sheetId: string, title: string) => boolean;
}

interface SheetListItem {
  id: string;
  resourceId: string;
  title: string;
  nodeType?: string | null;
  resourceType?: string | null;
  isDeleted?: number | null;
}

export default function SheetEmbedInsertDialog({ open, onClose, onInsert }: Props) {
  const [items, setItems] = useState<SheetListItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError("");
    setQuery("");
    setItems([]);
    setLoading(true);
    knowledgeTreeApi
      .list()
      .then((result) => {
        if (!alive) return;
        const sheets = (result.nodes || []).filter(
          (node: SheetListItem) =>
            (node.nodeType === "sheet" || node.resourceType === "sheet") && !node.isDeleted,
        );
        setItems(sheets);
      })
      .catch(() => {
        if (alive) setError("无法获取表格列表，请检查网络和访问权限");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => (item.title || "").toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-app-border px-4 py-3">
          <Table2 size={15} className="text-sky-500" />
          <span className="mr-auto text-sm font-medium text-tx-primary">选择要嵌入的轻量表格</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
          >
            <X size={15} />
          </button>
        </div>
        <div className="border-b border-app-border px-3 py-2">
          <div className="flex items-center gap-2 rounded-lg bg-app-hover/60 px-2.5 py-1.5">
            <Search size={14} className="shrink-0 text-tx-tertiary" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索表格标题…"
              className="min-w-0 flex-1 bg-transparent text-xs text-tx-primary outline-none placeholder:text-tx-tertiary"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex h-28 items-center justify-center gap-2 text-xs text-tx-tertiary">
              <Loader2 size={14} className="animate-spin" />
              正在加载…
            </div>
          ) : error ? (
            <div className="p-3 text-xs text-amber-600">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-center text-xs text-tx-tertiary">
              没有找到轻量表格。可在知识树「＋ 新建」里先创建一个。
            </div>
          ) : (
            filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-tx-primary transition-colors hover:bg-app-hover"
                onClick={() => {
                  if (onInsert(item.resourceId, item.title || "轻量表格")) onClose();
                }}
              >
                <Table2 size={13} className="shrink-0 text-sky-500" />
                <span className="min-w-0 flex-1 truncate">{item.title || "无标题表格"}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
