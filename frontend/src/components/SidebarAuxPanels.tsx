import React, { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, Star, Paperclip, ExternalLink, FileText, Folder, BrainCircuit } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, getCurrentWorkspace, resolveAttachmentUrl } from "@/lib/api";
import { useAppActions } from "@/store/AppContext";
import { useTrash } from "@/features/trash/useTrash";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";

/**
 * 侧栏辅助面板（方案 B · B1b）：收藏 / 回收站 / 附件。
 *
 * 共同约定：
 *  - 只做「浏览 + 常用动作」，完整管理页仍可从面板底部按钮进入
 *    （B2 页签系统上线后，这些整页入口会迁到主区页签）；
 *  - 点击条目直接打开内容，主区不被替换。
 */

function PanelShell({
  title,
  count,
  onOpenFull,
  openFullLabel,
  children,
  panelId,
}: {
  title: string;
  count?: number;
  onOpenFull: () => void;
  openFullLabel: string;
  children: React.ReactNode;
  panelId: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-sidebar-panel={panelId}>
      {/* 头部由面板框架 Shell 提供（标题 + 计数 + 动作），此处只保留内容与底部入口 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">{children}</div>
      <button
        type="button"
        onClick={onOpenFull}
        className="flex shrink-0 items-center justify-center gap-1.5 border-t border-app-border px-3 py-2 text-[11.5px] text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
      >
        <ExternalLink size={12} />
        {openFullLabel}
      </button>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="px-2 py-6 text-center text-[11.5px] text-tx-tertiary">{text}</p>;
}

function LoadingHint() {
  return (
    <div className="flex items-center justify-center gap-2 py-6 text-[11.5px] text-tx-tertiary">
      <Loader2 size={13} className="animate-spin" />
      …
    </div>
  );
}

/** 收藏面板：与 NoteList 的 favorites 视图同源（api.getNotes({ isFavorite })）。 */
export function SidebarFavoritesPanel() {
  const { t } = useTranslation();
  const actions = useAppActions();
  const [items, setItems] = useState<Array<{ id: string; title: string; updatedAt?: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .getNotes({ isFavorite: "1" } as never)
      .then((rows) => {
        if (alive) setItems(rows as never);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const openNote = useCallback(
    async (noteId: string) => {
      try {
        const note = await api.getNote(noteId);
        actions.setActiveNote(note);
        actions.setSelectedNotebook(note.notebookId);
        actions.setViewMode("notebook");
        actions.openNoteTab({
          id: note.id,
          title: note.title,
          notebookId: note.notebookId,
          workspaceId: note.workspaceId,
          contentFormat: note.contentFormat,
          isLocked: note.isLocked,
          isTrashed: note.isTrashed,
          updatedAt: note.updatedAt,
        });
        actions.setMobileView("editor");
      } catch {
        toast.error(t("sidebar.panelOpenFailed"));
      }
    },
    [actions, t],
  );

  return (
    <PanelShell
      panelId="fav"
      title={t("sidebar.favorites")}
      count={items.length}
      onOpenFull={() => actions.setViewMode("favorites")}
      openFullLabel={t("sidebar.openFullFavorites")}
    >
      {loading ? (
        <LoadingHint />
      ) : items.length === 0 ? (
        <EmptyHint text={t("sidebar.noFavorites")} />
      ) : (
        items.map((note) => (
          <button
            key={note.id}
            type="button"
            onClick={() => void openNote(note.id)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
          >
            <Star size={13} className="shrink-0 text-amber-500" />
            <span className="min-w-0 flex-1 truncate">{note.title || t("noteList.untitled")}</span>
          </button>
        ))
      )}
    </PanelShell>
  );
}

/** 回收站面板：复用 features/trash/useTrash。 */
export function SidebarTrashPanel() {
  const { t } = useTranslation();
  const actions = useAppActions();
  const [refreshToken, setRefreshToken] = useState(0);
  const { items, loading, mutate } = useTrash(getCurrentWorkspace(), refreshToken);

  const restore = useCallback(
    async (id: string) => {
      await mutate("restore", [id]);
      setRefreshToken((n) => n + 1);
    },
    [mutate],
  );

  const icon = (type: string) =>
    type === "notebook" || type === "folder" ? (
      <Folder size={13} className="shrink-0 text-amber-500" />
    ) : type === "mindmap" ? (
      <BrainCircuit size={13} className="shrink-0 text-violet-500" />
    ) : (
      <FileText size={13} className="shrink-0 text-accent-primary" />
    );

  return (
    <PanelShell
      panelId="trash"
      title={t("sidebar.trash")}
      count={items.length}
      onOpenFull={() => actions.setViewMode("trash")}
      openFullLabel={t("sidebar.openFullTrash")}
    >
      {loading ? (
        <LoadingHint />
      ) : items.length === 0 ? (
        <EmptyHint text={t("sidebar.trashEmpty")} />
      ) : (
        items.slice(0, 40).map((item) => (
          <div
            key={item.id}
            className="group/trash flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-tx-secondary transition-colors hover:bg-app-hover"
          >
            {icon(String(item.resourceType))}
            <span className="min-w-0 flex-1 truncate" title={item.title}>
              {item.title || t("noteList.untitled")}
            </span>
            <button
              type="button"
              onClick={() => void restore(item.id)}
              title={t("trash.restore")}
              className="hidden shrink-0 rounded p-1 text-tx-tertiary transition-colors hover:text-accent-primary group-hover/trash:flex"
            >
              <RotateCcw size={12} />
            </button>
          </div>
        ))
      )}
    </PanelShell>
  );
}

/** 附件面板：复用 api.files.list（附件/图床管理页的数据源）。 */
export function SidebarAttachmentsPanel() {
  const { t } = useTranslation();
  const actions = useAppActions();
  const [items, setItems] = useState<Array<{ id: string; filename: string; size?: number; url?: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .files
      .list({ limit: 30, offset: 0 } as never)
      .then((res: unknown) => {
        const rows = (res as { items?: unknown[] }).items || [];
        if (alive) setItems(rows as never);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const humanSize = (size?: number) => {
    if (!size) return "";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <PanelShell
      panelId="files"
      title={t("sidebar.fileManager")}
      count={items.length}
      onOpenFull={() => actions.setViewMode("files")}
      openFullLabel={t("sidebar.openFullAttachments")}
    >
      {loading ? (
        <LoadingHint />
      ) : items.length === 0 ? (
        <EmptyHint text={t("sidebar.noAttachments")} />
      ) : (
        items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => actions.setViewMode("files")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
              "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
            )}
            title={item.filename}
          >
            {item.url ? (
              <img
                src={resolveAttachmentUrl(item.url)}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-6 w-6 shrink-0 rounded object-cover"
              />
            ) : (
              <Paperclip size={13} className="shrink-0 text-tx-tertiary" />
            )}
            <span className="min-w-0 flex-1 truncate">{item.filename}</span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-tx-quaternary">{humanSize(item.size)}</span>
          </button>
        ))
      )}
    </PanelShell>
  );
}
