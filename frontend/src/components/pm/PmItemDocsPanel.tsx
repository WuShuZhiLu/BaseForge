import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, FileText, Link2, Loader2, Pin, Plus, Unlink } from "lucide-react";
import type { PmItemNoteLink, PmWorkItem } from "@/types";
import { api } from "@/lib/api";

/**
 * 工作项多文档关联区（M3 C2，详情抽屉内使用）：
 * - 列表：pm_item_notes 全量关联（主交付文档置顶并用 Pin 图标标记）；
 * - 关联既有笔记：标题搜索（api.searchNotes，防抖 250ms）→ 勾选关联；
 * - 新建交付文档：复用 P1 的 createNote 逻辑（写 noteId，后端自动进关联表）；
 * - 解除关联：removeItemNote（解除主文档时后端同步清空 noteId）；变更后 onRefresh 通知父层。
 */
export default function PmItemDocsPanel({ item, onRefresh }: { item: PmWorkItem; onRefresh: () => void }) {
  const [notes, setNotes] = useState<PmItemNoteLink[] | null>(null);
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; title: string }> | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<number | null>(null);

  const reload = useCallback(() => {
    api
      .listPmItemNotes(item.id)
      .then((res) => setNotes(res.notes))
      .catch((err: unknown) => setListError(err instanceof Error ? err.message : "加载关联失败"));
  }, [item.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  // 关联既有笔记：防抖搜索
  useEffect(() => {
    const keyword = query.trim();
    if (!keyword) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      api
        .searchNotes(keyword, 8)
        .then((rows) => setResults(rows))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, [query]);

  const openNote = (noteId: string) => {
    window.dispatchEvent(new CustomEvent("nowen:open-note-by-id", { detail: { noteId } }));
  };

  const unlink = async (noteId: string) => {
    setBusy(true);
    try {
      await api.removePmItemNote(item.id, noteId);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const createDeliveryNote = async () => {
    setCreateBusy(true);
    try {
      const res = await api.createNote({
        title: `【工作项】${item.title}`,
        content: JSON.stringify({
          type: "doc",
          content: [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: item.title }] },
            { type: "paragraph", content: [{ type: "text", text: item.description || "（待补充交付文档）" }] },
          ],
        }),
        contentText: item.description.replace(/[#*`>\-|_[\]()]/g, "").trim(),
      });
      await api.updatePmWorkItem(item.id, { noteId: res.id });
      onRefresh();
    } finally {
      setCreateBusy(false);
    }
  };

  const linkExisting = async (noteId: string) => {
    setLinkError("");
    try {
      const res = await api.addPmItemNote(item.id, noteId);
      if (res.duplicate) {
        setLinkError("该笔记已在关联列表中");
        return;
      }
      setQuery("");
      setResults(null);
      onRefresh();
    } catch (err: unknown) {
      setLinkError(err instanceof Error ? err.message : "关联失败");
    }
  };

  const primaryId = item.noteId;

  return (
    <div className="mt-3 rounded-lg border border-zinc-200 p-2 dark:border-zinc-700">
      <p className="flex items-center gap-1 text-[11px] font-medium text-tx-secondary">
        <FileText size={11} /> 关联文档
      </p>

      {listError ? <p className="mt-1.5 text-[11px] text-red-500">{listError}</p> : null}

      {notes === null ? (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-zinc-400">
          <Loader2 size={11} className="animate-spin" /> 加载中…
        </p>
      ) : notes.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-zinc-400">暂无关联文档</p>
      ) : (
        <div className="mt-1.5 space-y-0.5">
          {notes
            .slice()
            .sort((a, b) => (a.noteId === primaryId ? -1 : b.noteId === primaryId ? 1 : 0))
            .map((link) => (
              <div key={link.id} className="group/docs flex w-full items-center gap-2 rounded px-1.5 py-1 hover:bg-app-hover">
                {link.noteId === primaryId ? <Pin size={10} className="shrink-0 text-accent-primary" aria-label="主交付文档" /> : <FileText size={10} className="shrink-0 text-zinc-400" />}
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500" title={link.title ?? undefined}>
                  {link.title ?? "（笔记不存在）"}
                  {link.noteId === primaryId ? <span className="ml-1 rounded bg-accent-primary/10 px-1 text-[9px] text-accent-primary">主文档</span> : null}
                  {link.isTrashed ? <span className="ml-1 text-[9px] text-zinc-400">（回收站）</span> : null}
                </span>
                <button
                  type="button"
                  className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-accent-primary hover:bg-app-hover"
                  onClick={() => openNote(link.noteId)}
                  title="在编辑器中打开"
                >
                  <ExternalLink size={10} /> 打开
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="shrink-0 rounded p-0.5 text-zinc-400 opacity-0 transition-opacity hover:text-red-500 group-hover/docs:opacity-100 disabled:opacity-30"
                  title="解除关联"
                  onClick={() => void unlink(link.noteId)}
                >
                  <Unlink size={10} />
                </button>
              </div>
            ))}
        </div>
      )}

      {/* 新建交付文档 */}
      {!primaryId ? (
        <button
          type="button"
          disabled={createBusy}
          className="mt-1.5 flex items-center gap-1 rounded border border-dashed border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-500 hover:border-accent-primary hover:text-accent-primary disabled:opacity-50 dark:border-zinc-600"
          onClick={() => void createDeliveryNote()}
        >
          <FileText size={10} /> {createBusy ? "创建中…" : "创建交付文档并设为主文档"}
        </button>
      ) : null}

      {/* 关联既有笔记（搜索） */}
      <div className="mt-1.5">
        <div className="flex items-center gap-1 rounded border border-zinc-200 px-1.5 py-1 dark:border-zinc-700">
          <Link2 size={10} className="shrink-0 text-zinc-400" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[11px] text-tx-primary outline-none placeholder:text-zinc-400"
            placeholder="搜索笔记标题以关联…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching ? <Loader2 size={10} className="shrink-0 animate-spin text-zinc-400" /> : null}
        </div>
        {linkError ? <p className="mt-1 text-[10px] text-red-500">{linkError}</p> : null}
        {results && results.length > 0 ? (
          <div className="mt-1 space-y-0.5 rounded-md border border-zinc-200 p-1 dark:border-zinc-700">
            {results.map((row) => (
              <div key={row.id} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-app-hover">
                <span className="min-w-0 flex-1 truncate text-[11px] text-tx-secondary">{row.title}</span>
                <button
                  type="button"
                  className="flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] text-accent-primary hover:bg-app-hover"
                  onClick={() => void linkExisting(row.id)}
                >
                  <Plus size={10} /> 关联
                </button>
              </div>
            ))}
          </div>
        ) : results && results.length === 0 && query.trim() ? (
          <p className="mt-1 text-[10px] text-zinc-400">没有匹配的笔记</p>
        ) : null}
      </div>
    </div>
  );
}
