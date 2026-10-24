import React, { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, FilePlus2, Loader2, PenTool, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { openInternalNoteLink } from "@/lib/blockNavigation";
import { resolveAppAppearanceMode } from "@/lib/appAppearance";
import { parseBoardEmbedHref } from "@/lib/boardEmbed";
import { toast } from "@/lib/toast";
import type { Note } from "@/types";

/**
 * 画板嵌入卡片（![[board:<noteId>]]）。
 *
 * 只读：把场景 JSON 导出成 SVG 预览，点击"打开"进入画板文档编辑。
 * Excalidraw 体积大，这里动态 import BoardCanvas，普通笔记不受影响。
 */

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "empty" }
  | { status: "error" };

export default function BoardEmbedCard({ href }: { href: string }) {
  const boardId = parseBoardEmbedHref(href);
  const [note, setNote] = useState<Note | null>(null);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [isDark, setIsDark] = useState(() => resolveAppAppearanceMode() === "dark");
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const [promoting, setPromoting] = useState(false);
  const [promoteTitle, setPromoteTitle] = useState("");
  const [upgrading, setUpgrading] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setIsDark(resolveAppAppearanceMode(root) === "dark");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!boardId) return;
    let alive = true;
    setLoadError("");
    setNote(null);
    api.getNote(boardId)
      .then((loaded) => {
        if (!alive) return;
        if (loaded.contentFormat !== "board") {
          setLoadError("目标文档不是画板");
          return;
        }
        setNote(loaded);
      })
      .catch(() => {
        if (alive) setLoadError("画板不存在或无权访问");
      });
    return () => { alive = false; };
  }, [boardId, revision]);

  useEffect(() => {
    if (!note) return;
    let alive = true;
    setPreview({ status: "loading" });
    import("@/components/BoardCanvas")
      .then((module) => module.renderBoardSceneToSvg(note.content || "", isDark))
      .then((svg) => {
        if (!alive) return;
        setPreview(svg ? { status: "ready", svg } : { status: "empty" });
      })
      .catch(() => {
        if (alive) setPreview({ status: "error" });
      });
    return () => { alive = false; };
  }, [note, isDark, revision]);

  if (!boardId) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-amber-600">
        <AlertTriangle size={14} />
        无效的画板嵌入链接
      </div>
    );
  }

  const openBoard = () => {
    if (note) openInternalNoteLink(`note:${note.id}`);
  };

  const startPromote = () => {
    if (!note) return;
    setPromoteTitle(note.title && note.title !== "画板" ? note.title : "");
    setPromoting(true);
  };

  const confirmPromote = async () => {
    if (!note || upgrading) return;
    setUpgrading(true);
    try {
      const updated = await api.promoteNote(note.id, { title: promoteTitle.trim() || "未命名画板" });
      setNote(updated);
      setPromoting(false);
      toast.success("已转为独立文档，可在知识树中找到");
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", {
        detail: { reason: "anonymous-doc-promoted", noteId: note.id },
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "转为独立文档失败");
    } finally {
      setUpgrading(false);
    }
  };

  return (
    <div
      data-nowen-board-embed={boardId}
      className="my-4 min-w-0 max-w-full overflow-hidden rounded-xl border border-app-border bg-app-surface"
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-app-border px-3 py-2">
        <PenTool size={14} className="shrink-0 text-teal-500" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-tx-primary">
          {note?.title || "画板"}
        </span>
        {note?.isUnlisted === 1 && !promoting && (
          <button
            type="button"
            contentEditable={false}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-teal-600 transition-colors hover:bg-app-hover dark:text-teal-400"
            onClick={(event) => { event.preventDefault(); startPromote(); }}
            title="转为独立文档（进入知识树）"
          >
            <FilePlus2 size={12} />
            转为独立文档
          </button>
        )}
        <button
          type="button"
          contentEditable={false}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
          onClick={(event) => { event.preventDefault(); setRevision((value) => value + 1); }}
          title="刷新预览"
        >
          <RefreshCw size={12} />
        </button>
        <button
          type="button"
          contentEditable={false}
          disabled={!note}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-accent-primary transition-colors hover:bg-app-hover disabled:opacity-40"
          onClick={(event) => { event.preventDefault(); openBoard(); }}
          title="打开画板"
        >
          <ExternalLink size={12} />
          打开
        </button>
      </div>

      {promoting && (
        <div className="flex items-center gap-2 border-b border-app-border bg-app-hover/40 px-3 py-2">
          <input
            autoFocus
            value={promoteTitle}
            onChange={(event) => setPromoteTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void confirmPromote(); }
              if (event.key === "Escape") { event.preventDefault(); setPromoting(false); }
            }}
            placeholder="文档名称"
            className="min-w-0 flex-1 rounded-md border border-app-border bg-app-surface px-2 py-1 text-xs text-tx-primary outline-none focus:border-accent-primary"
          />
          <button
            type="button"
            disabled={upgrading}
            className="rounded-md bg-accent-primary px-2 py-1 text-[11px] text-white disabled:opacity-50"
            onClick={(event) => { event.preventDefault(); void confirmPromote(); }}
          >
            {upgrading ? "处理中…" : "确定"}
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[11px] text-tx-secondary hover:bg-app-hover"
            onClick={(event) => { event.preventDefault(); setPromoting(false); }}
          >
            取消
          </button>
        </div>
      )}

      {loadError ? (
        <div className="flex h-24 items-center justify-center gap-2 px-3 text-xs text-amber-600">
          <AlertTriangle size={14} />
          {loadError}
        </div>
      ) : !note || preview.status === "loading" ? (
        <div className="flex h-24 items-center justify-center gap-2 text-xs text-tx-tertiary">
          <Loader2 size={14} className="animate-spin" />
          正在加载画板预览…
        </div>
      ) : preview.status === "error" ? (
        <div className="flex h-24 items-center justify-center gap-2 px-3 text-xs text-amber-600">
          <AlertTriangle size={14} />
          画板预览渲染失败，打开画板可查看完整内容
        </div>
      ) : preview.status === "empty" ? (
        <div className="flex h-24 items-center justify-center text-xs text-tx-tertiary">
          空画板
        </div>
      ) : (
        <div
          className="board-embed-preview max-h-[380px] overflow-auto overscroll-contain p-2 [&_svg]:h-auto [&_svg]:max-w-full"
          aria-label="画板只读预览"
          dangerouslySetInnerHTML={{ __html: preview.svg }}
        />
      )}

      <div className="border-t border-app-border px-3 py-1.5 text-[11px] text-tx-tertiary">
        {note?.isUnlisted === 1
          ? "匿名画板 · 只通过此嵌入块访问 · 删除此块后会被自动清理"
          : "引用原始画板 · SVG 只读快照 · 删除此块不会删除画板"}
      </div>
    </div>
  );
}
