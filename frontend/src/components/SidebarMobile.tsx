import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronRight, PanelLeft, Tags, Trash2, X , PanelTopOpen, PanelTopClose, Settings, ListTodo, NotebookPen, Sparkles, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import KnowledgeTreePanel, {
  FOCUS_KNOWLEDGE_TREE_EVENT,
  KNOWLEDGE_TREE_CHANGED_EVENT,
} from "@/components/KnowledgeTreeCreateMenuRuntime";
import MobileKnowledgeTreePanel from "@/components/MobileKnowledgeTreePanel";
import SidebarTagsPanel from "@/components/SidebarTagsPanel";
import SidebarPanelContainer from "@/components/sidebar/SidebarPanelContainer";
import TagsPanelContent from "@/components/sidebar/panels/TagsPanelContent";
import TreePanelContent from "@/components/sidebar/panels/TreePanelContent";
import { OPEN_KNOWLEDGE_TREE_EVENT } from "@/components/KnowledgeTreeDrawer";
import TagColorPopover from "@/components/TagColorPopover";
import { useMobileRailHidden } from "@/hooks/useMobileRailHidden";
import { useSidebarTextStyle } from "@/hooks/useSidebarTextStyle";
import { useMobileSidebarControlsCollapsed } from "@/hooks/useMobileSidebarControlsCollapsed";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { api } from "@/lib/api";
import { refreshKnowledgeTreeScrollbars } from "@/lib/knowledgeTreeScrollbarBridge";
import {
  DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT,
  DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY,
  loadDesktopKnowledgeTreeViewMode,
  type DesktopKnowledgeTreeViewMode,
} from "@/lib/mobileKnowledgeTreeViewMode";
import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";
import { useRailMode } from "@/hooks/useRailMode";
import { cn } from "@/lib/utils";
import { updateSidebarPanel } from "@/lib/sidebarPanels";
import { useApp, useAppActions, type ToolTabKey } from "@/store/AppContext";

interface DeleteTagTarget {
  id: string;
  name: string;
  color: string;
}

interface TagColorTarget {
  tagId: string;
  tagName: string;
  color: string;
  x: number;
  y: number;
}

/**
 * Keep the desktop tree scrollbar discoverable even when Chromium/Windows uses
 * auto-hiding overlay scrollbars. Mobile keeps its native touch-scrolling UI.
 */
export const KNOWLEDGE_TREE_SCROLLBAR_CSS = `
[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"] {
  overflow-y: scroll !important;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--pm-scrollbar) transparent;
}

[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"]::-webkit-scrollbar {
  width: 9px;
}

[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"]::-webkit-scrollbar-track {
  background: transparent;
}

[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"]::-webkit-scrollbar-thumb {
  min-height: 36px;
  border: 2.5px solid transparent;
  border-radius: 999px;
  background: var(--pm-scrollbar);
  background-clip: content-box;
  transition: border-width 140ms ease, background-color 120ms ease;
}

[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"]::-webkit-scrollbar-thumb:hover {
  border-width: 1.5px;
  background: var(--pm-scrollbar-hover);
  background-clip: content-box;
}
`;

/**
 * Unified sidebar.
 *
 * 桌面端默认保留递归目录树，并可按本地偏好切换为快捷浏览；移动端默认使用快捷浏览。
 */
export default function SidebarMobile({ variant = "mobile" }: { variant?: "desktop" | "mobile" } = {}) {
  const [mobileControlsCollapsed, setMobileControlsCollapsed] = useMobileSidebarControlsCollapsed();
  const [mobileRailHidden, setMobileRailHidden] = useMobileRailHidden();
  const [sidebarTextStyle] = useSidebarTextStyle();
  const classicText = sidebarTextStyle === "classic";
  const { state } = useApp();
  const actions = useAppActions();
  const { t } = useTranslation();

  // 兼容 B1：Rail 面板按钮写入的 sidebarPanel 仍是「单选」语义，
  // 这里把它翻译为面板框架里的「显示并展开该面板」，两种模型并存不冲突。
  useEffect(() => {
    const id = state.sidebarPanel;
    if (!id) return;
    updateSidebarPanel(id, { visible: true, collapsed: false });
  }, [state.sidebarPanel]);
  const { siteConfig } = useSiteSettings();
  const [railMode, setRailMode] = useRailMode();
  const rootRef = useRef<HTMLDivElement>(null);
  const tagLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagLongPressFired = useRef(false);

  const [tagsExpanded, setTagsExpanded] = useState(() => {
    try {
      const saved = localStorage.getItem("nowen-tags-expanded");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [deleteTagTarget, setDeleteTagTarget] = useState<DeleteTagTarget | null>(null);
  const [tagColorPopover, setTagColorPopover] = useState<TagColorTarget | null>(null);
  const [desktopKnowledgeTreeMode, setDesktopKnowledgeTreeMode] = useState<DesktopKnowledgeTreeViewMode>(
    () => loadDesktopKnowledgeTreeViewMode(),
  );

  useEffect(() => {
    const syncMode = () => setDesktopKnowledgeTreeMode(loadDesktopKnowledgeTreeViewMode());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY) syncMode();
    };
    window.addEventListener(DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, syncMode);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, syncMode);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  const refreshSidebarData = useCallback(async () => {
    try {
      const [notebooks, tags] = await Promise.all([api.getNotebooks(), api.getTags()]);
      actions.setNotebooks(notebooks);
      actions.setTags(tags);
    } catch (error) {
      console.error("[SidebarMobile] failed to refresh unified sidebar data:", error);
    }
  }, [actions]);

  useEffect(() => {
    void refreshSidebarData();
    const refresh = () => void refreshSidebarData();
    window.addEventListener("nowen:workspace-changed", refresh);
    window.addEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("nowen:workspace-changed", refresh);
      window.removeEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    };
  }, [refreshSidebarData]);

  useEffect(() => {
    if (variant !== "desktop") return;
    refreshKnowledgeTreeScrollbars();
    return () => refreshKnowledgeTreeScrollbars();
  }, [variant]);

  useEffect(() => {
    const focusKnowledgeTree = () => {
      const root = rootRef.current;
      if (!root || root.getClientRects().length === 0) return;
      requestAnimationFrame(() => window.dispatchEvent(new Event(FOCUS_KNOWLEDGE_TREE_EVENT)));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusKnowledgeTree();
      }
    };
    window.addEventListener(OPEN_KNOWLEDGE_TREE_EVENT, focusKnowledgeTree);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener(OPEN_KNOWLEDGE_TREE_EVENT, focusKnowledgeTree);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => () => {
    if (tagLongPressTimer.current) clearTimeout(tagLongPressTimer.current);
  }, []);

  const toggleTagsExpanded = () => {
    setTagsExpanded((current) => {
      const next = !current;
      try { localStorage.setItem("nowen-tags-expanded", String(next)); } catch {}
      return next;
    });
  };

  const openTagColor = (target: TagColorTarget) => {
    setTagColorPopover(target);
  };

  const handleTagClick = (tagId: string) => {
    if (tagLongPressFired.current) {
      tagLongPressFired.current = false;
      return;
    }

    const isCurrentlyActive = state.selectedTagIds.includes(tagId);
    actions.toggleSelectedTag(tagId);
    actions.setSelectedNotebook(null);
    const willHaveTags = isCurrentlyActive ? state.selectedTagIds.length > 1 : true;
    actions.setViewMode(willHaveTags ? "tag" : "all");
    if (variant === "mobile") actions.setMobileSidebar(false);
  };

  const deleteTag = async (target: DeleteTagTarget) => {
    setDeleteTagTarget(null);
    try {
      await api.deleteTag(target.id);
      const tags = await api.getTags();
      actions.setTags(tags);

      if (!state.selectedTagIds.includes(target.id)) return;
      const remaining = state.selectedTagIds.filter((id) => id !== target.id);
      if (remaining.length > 0) {
        actions.setSelectedTags(remaining);
      } else {
        actions.clearSelectedTags();
        if (state.viewMode === "tag") actions.setViewMode("all");
      }
    } catch (error) {
      console.error("[SidebarMobile] failed to delete tag:", error);
    }
  };

  return (
    <aside
      ref={rootRef}
      className="flex h-full w-full min-w-0 flex-col overflow-hidden border-r border-app-border bg-app-sidebar text-tx-primary"
      data-unified-sidebar=""
      data-sidebar-variant={variant}
    >
      {variant === "desktop" && (
        <style data-knowledge-tree-scrollbar="">{KNOWLEDGE_TREE_SCROLLBAR_CSS}</style>
      )}

      {/* 桌面端不再渲染「BaseForge」标题行：
          用户 2026-10-16 要求按原型对齐（顶栏那一坨去掉）。
          功能保全：工作区切换仍在 Rail 头像菜单；railMode 切换按钮移到「面板 ⋯」行右侧（见 SidebarPanelContainer）。
          移动端仍需要这行（含移动端专属控件），保持原样。 */}
      {variant === "mobile" && (
        <header
          className="flex shrink-0 items-center justify-between border-b border-app-border px-4 py-3"
          style={{ paddingTop: "calc(var(--safe-area-top) + 12px)" }}
        >
          <button
            type="button"
            onClick={() => setMobileControlsCollapsed(!mobileControlsCollapsed)}
            title={t(mobileControlsCollapsed ? "sidebar.expandMobileControls" : "sidebar.collapseMobileControls")}
            aria-label={t(mobileControlsCollapsed ? "sidebar.expandMobileControls" : "sidebar.collapseMobileControls")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
          >
            {mobileControlsCollapsed ? <PanelTopOpen size={16} /> : <PanelTopClose size={16} />}
          </button>
          <span className={cn("min-w-0 truncate font-semibold", classicText ? "text-[13px]" : "text-sm")}>
            {siteConfig.title || "BaseForge"}
          </span>
          {mobileRailHidden && (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                data-mobile-rail-show=""
                onClick={() => setMobileRailHidden(false)}
                title={t("sidebar.showMobileRail")}
                aria-label={t("sidebar.showMobileRail")}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
              >
                <PanelLeft size={16} />
              </button>
              <button
                type="button"
                data-mobile-sidebar-settings=""
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("nowen:open-settings"));
                }}
                title={t("settings.title", { defaultValue: "设置" })}
                aria-label={t("settings.title", { defaultValue: "设置" })}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
              >
                <Settings size={16} />
              </button>
            </div>
          )}
        </header>
      )}
      {/* 桌面端不再渲染「个人空间」卡片（用户 2026-10-16：按原型去掉顶栏那一坨）；
          工作区切换入口仍在 Rail 顶部的账号菜单（B1 已实现），功能不丢。
          移动端保持原样：仍显示工作区切换，并受移动端控件折叠开关控制。 */}
      {variant === "mobile" && !mobileControlsCollapsed && (
        <div className="shrink-0 px-3 py-2">
          <WorkspaceSwitcher />
        </div>
      )}

      <section className="flex min-h-0 flex-1 flex-col border-t border-app-border/60">
        {variant === "mobile" ? (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <MobileKnowledgeTreePanel />
          </div>
        ) : (
          /* 面板框架（S1）：容器按布局 store 渲染可见面板；面板头/折叠/排序由 Shell 统一提供。 */
          <SidebarPanelContainer
            treeContent={
              <TreePanelContent mode={desktopKnowledgeTreeMode === "quick" ? "quick" : "full"} />
            }
            contents={{
              tags: (
                <TagsPanelContent
                  tags={state.tags}
                  selectedTagIds={state.selectedTagIds}
                  onTagClick={handleTagClick}
                  onTagContextMenu={openTagColor}
                  onRequestDelete={(tag) =>
                    setDeleteTagTarget({ id: tag.id, name: tag.name, color: tag.color })
                  }
                  onLongPressFired={() => {
                    tagLongPressFired.current = false;
                  }}
                  onLongPressStart={(cb) => {
                    if (tagLongPressTimer.current) clearTimeout(tagLongPressTimer.current);
                    tagLongPressTimer.current = setTimeout(() => {
                      tagLongPressFired.current = true;
                      cb();
                    }, 500);
                  }}
                  onLongPressCancel={() => {
                    if (!tagLongPressTimer.current) return;
                    clearTimeout(tagLongPressTimer.current);
                    tagLongPressTimer.current = null;
                  }}
                  onLongPressEnd={() => {
                    if (!tagLongPressTimer.current) return;
                    clearTimeout(tagLongPressTimer.current);
                    tagLongPressTimer.current = null;
                  }}
                />
              ),
            }}
          />
        )}
      </section>

      <AnimatePresence>
        {deleteTagTarget && (
          <div className="fixed inset-0 z-[260] flex items-center justify-center p-4">
            <motion.button
              type="button"
              aria-label={t("common.close")}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setDeleteTagTarget(null)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="relative w-full max-w-sm rounded-xl border border-app-border bg-app-elevated p-5 shadow-2xl"
            >
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-danger/10 text-accent-danger">
                  <Trash2 size={18} />
                </span>
                <h4 className="text-base font-bold">{t("sidebar.deleteTagTitle")}</h4>
              </div>
              <p className="mb-5 flex items-center gap-2 pl-[52px] text-sm text-tx-secondary">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: deleteTagTarget.color }} />
                <span>{t("sidebar.confirmDeleteTag", { name: deleteTagTarget.name })}</span>
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteTagTarget(null)}
                  className="rounded-lg px-4 py-2 text-sm text-tx-secondary hover:bg-app-hover"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteTag(deleteTagTarget)}
                  className="rounded-lg bg-accent-danger px-4 py-2 text-sm font-medium text-white hover:bg-accent-danger/90"
                >
                  {t("sidebar.confirmDelete")}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* 工具入口已迁移到活动栏徽章区（固定 5 徽章 + 「更多」组），原底部工具条按原型移除；
          功能不丢：待办/小记/AI/分享仍从徽章或「＋添加徽章」进入。 */}

      {tagColorPopover && (
        <TagColorPopover
          x={tagColorPopover.x}
          y={tagColorPopover.y}
          currentColor={tagColorPopover.color}
          title={tagColorPopover.tagName}
          onPick={async (color) => {
            try {
              await api.updateTag(tagColorPopover.tagId, { color });
              actions.setTags(await api.getTags());
            } catch (error) {
              console.error("[SidebarMobile] failed to update tag color:", error);
            }
          }}
          onClose={() => setTagColorPopover(null)}
        />
      )}
    </aside>
  );
}
