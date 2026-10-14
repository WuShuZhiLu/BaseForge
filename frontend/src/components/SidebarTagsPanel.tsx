import React from "react";
import { Tags, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tag } from "@/types";
import { cn } from "@/lib/utils";

/**
 * 侧栏「标签」面板（方案 B · B1a）。
 *
 * 原来标签是侧栏底部的一个折叠行；B 方案把它升级为侧栏面板之一
 * （Rail 点「标签」图标即切到此面板，主区不变）。
 * 交互与原折叠行完全一致：左键筛选、右键/长按改色、悬浮删除。
 */

interface Props {
  tags: Tag[];
  selectedTagIds: string[];
  onTagClick: (tagId: string) => void;
  onTagContextMenu: (payload: { tagId: string; tagName: string; color: string; x: number; y: number }) => void;
  onRequestDelete: (tag: Tag) => void;
  onLongPressStart: (cb: () => void) => void;
  onLongPressCancel: () => void;
  onLongPressEnd: () => void;
  onLongPressFired: () => void;
}

export default function SidebarTagsPanel({
  tags,
  selectedTagIds,
  onTagClick,
  onTagContextMenu,
  onRequestDelete,
  onLongPressStart,
  onLongPressCancel,
  onLongPressEnd,
  onLongPressFired,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-sidebar-panel="tags">
      <div className="flex shrink-0 items-center gap-2 border-b border-app-border px-4 py-2.5">
        <Tags size={13} className="text-tx-tertiary" />
        <span className="text-[12.5px] font-semibold text-tx-primary">{t("sidebar.tags")}</span>
        <span className="ml-auto rounded-full bg-app-hover px-1.5 text-[10.5px] tabular-nums text-tx-tertiary">
          {tags.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {tags.length === 0 ? (
          <p className="px-2 py-1 text-[10.5px] text-tx-tertiary">{t("sidebar.noTags")}</p>
        ) : (
          tags.map((tag) => {
            const active = selectedTagIds.includes(tag.id);
            return (
              <div
                key={tag.id}
                onClick={() => onTagClick(tag.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onTagContextMenu({
                    tagId: tag.id,
                    tagName: tag.name,
                    color: tag.color,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onTouchStart={(event) => {
                  const touch = event.touches[0];
                  if (!touch) return;
                  onLongPressFired();
                  onLongPressStart(() => {
                    onTagContextMenu({
                      tagId: tag.id,
                      tagName: tag.name,
                      color: tag.color,
                      x: touch.clientX,
                      y: touch.clientY,
                    });
                  });
                }}
                onTouchMove={onLongPressCancel}
                onTouchEnd={onLongPressEnd}
                className={cn(
                  "group/tag flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] transition-colors",
                  active
                    ? "bg-app-active text-tx-primary"
                    : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                )}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                <span className="min-w-0 flex-1 truncate" title={tag.name}>
                  {tag.name}
                </span>
                <span className="relative flex h-4 w-5 shrink-0 items-center justify-center">
                  {tag.noteCount !== undefined && tag.noteCount > 0 && (
                    <span className="absolute inset-0 flex items-center justify-center text-[10px] tabular-nums text-tx-tertiary transition-opacity [@media(hover:hover)]:group-hover/tag:opacity-0">
                      {tag.noteCount}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRequestDelete(tag);
                    }}
                    title={t("common.delete")}
                    className="absolute inset-0 hidden items-center justify-center text-tx-tertiary transition-colors hover:text-accent-danger [@media(hover:hover)]:group-hover/tag:flex"
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
