import { useEffect } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tag } from "@/types";
import { reportPanelCount } from "@/lib/sidebarPanelCounts";
import { PanelBody, PanelEmpty, PanelRow } from "@/components/sidebar/panels/shared";

/**
 * 标签面板内容（内容层 v1 · B-11，B 名下）
 *
 * - props 与旧 SidebarTagsPanel 完全一致（tags / selectedTagIds / onTagClick /
 *   onTagContextMenu / onRequestDelete / onLongPress*），由 A 在 Container 里经 contents 注入；
 * - 不自带头部；行用 PanelRow（激活态走 active）；计数经 reportPanelCount("tags", n) 上报；
 * - PanelRow 是 <button>，行内删除钮用 role="button" 的 span 承接（避免 button 嵌套 button）；
 *   删除钮默认透明、自身悬停显形（旧版的「行悬停显形」依赖 group 类，公共件 PanelRow 不透传
 *   className，故以此近似，桌面端交互等价）；
 * - 触屏长按（改色菜单）沿用旧链路：onLongPress* 由外层行容器承接（桌面端不触发）。
 */
export interface TagsPanelContentProps {
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

export default function TagsPanelContent({
  tags,
  selectedTagIds,
  onTagClick,
  onTagContextMenu,
  onRequestDelete,
  onLongPressStart,
  onLongPressCancel,
  onLongPressEnd,
  onLongPressFired,
}: TagsPanelContentProps) {
  const { t } = useTranslation();

  useEffect(() => {
    reportPanelCount("tags", tags.length);
  }, [tags.length]);

  return (
    <PanelBody>
      <div className="space-y-0.5">
        {tags.length === 0 ? (
          <PanelEmpty text={t("sidebar.noTags")} />
        ) : (
          tags.map((tag) => {
            const active = selectedTagIds.includes(tag.id);
            return (
              <div
                key={tag.id}
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
              >
                <PanelRow
                  active={active}
                  title={tag.name}
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
                  leading={<span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />}
                  trailing={
                    <span className="relative flex h-4 w-5 shrink-0 items-center justify-center">
                      {tag.noteCount !== undefined && tag.noteCount > 0 && (
                        <span className="absolute inset-0 flex items-center justify-center text-[10px] tabular-nums text-tx-tertiary">
                          {tag.noteCount}
                        </span>
                      )}
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={t("common.delete")}
                        title={t("common.delete")}
                        onClick={(event) => {
                          event.stopPropagation();
                          onRequestDelete(tag);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.stopPropagation();
                            onRequestDelete(tag);
                          }
                        }}
                        className="absolute inset-0 flex cursor-pointer items-center justify-center rounded text-tx-tertiary opacity-0 transition-opacity hover:bg-app-hover hover:text-accent-danger hover:opacity-100"
                      >
                        <X size={12} />
                      </span>
                    </span>
                  }
                >
                  {tag.name}
                </PanelRow>
              </div>
            );
          })
        )}
      </div>
    </PanelBody>
  );
}
