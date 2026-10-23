import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  BookOpen,
  Check,
  CheckSquare,
  ChevronDown,
  Clock,
  FolderTree,
  LayoutGrid,
  Link2,
  ListTree,
  Paperclip,
  Plus,
  Sparkles,
  Star,
  Tags,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  readSidebarLayout,
  subscribeSidebarLayout,
  updateSidebarBadges,
  updateSidebarPanel,
  type SidebarPanelId,
} from "@/lib/sidebarPanels";
import { cn } from "@/lib/utils";
import { useApp, useAppActions, type ToolTabKey } from "@/store/AppContext";

/**
 * 活动栏徽章区（面板框架 S2 · B 名下，见 .cmp/COLLAB-BOARD.md 第六节）
 *
 * - 固定徽章（用户 2026-10-16 拍板）：文档树 / 标签 / 收藏 / 回收站 / 附件，常驻不可移除；
 * - 其余徽章收进可折叠的「更多」组（默认折叠，展开/收起经 updateSidebarBadges 持久化）；
 * - 「＋ 添加徽章」位于「更多」之下：勾选加入 / 取消移除（只移除入口，不删功能）；
 * - 徽章点击 = updateSidebarPanel(id, { visible: true, collapsed: false })，
 *   不直接操作 SidebarMobile（协议：接口在 lib/sidebarPanels.ts，A 已冻结）；
 * - Rail 左下角的「设置」仍由 NavRailMobile 自行渲染，本组件不包含任何设置入口。
 *
 * 图标 / 标题键与 A 的 components/sidebar/panelRegistry.tsx 保持一致（同一对象同一图标）。
 */

const BADGE_ICON_SIZE = 15;

/** 固定徽章集合（顺序即渲染顺序）。 */
export const FIXED_BADGE_IDS = ["tree", "tags", "fav", "trash", "files"] as const;
export type FixedBadgeId = (typeof FIXED_BADGE_IDS)[number];

const FIXED_BADGE_META: Record<FixedBadgeId, { labelKey: string; icon: React.ReactNode }> = {
  tree: { labelKey: "sidebar.panelTree", icon: <FolderTree size={BADGE_ICON_SIZE} /> },
  tags: { labelKey: "sidebar.panelTags", icon: <Tags size={BADGE_ICON_SIZE} /> },
  fav: { labelKey: "sidebar.panelFav", icon: <Star size={BADGE_ICON_SIZE} /> },
  trash: { labelKey: "sidebar.panelTrash", icon: <Trash2 size={BADGE_ICON_SIZE} /> },
  files: { labelKey: "sidebar.panelFiles", icon: <Paperclip size={BADGE_ICON_SIZE} /> },
};

/** 「更多」组候选徽章 = **工具入口**（待办 / 小记 / AI 对话 / 分享管理）。
 *  用户口径（2026-10-16）：左侧活动栏可添加徽章，例如待办、小记；除固定 5 个外都要能折叠。
 *  这些是工具页（主区页签），不是侧栏面板，因此点击走 openToolTab。 */
export const EXTRA_BADGE_CATALOG: Array<{ id: ToolTabKey; labelKey: string; icon: React.ReactNode }> = [
  { id: "tasks", labelKey: "sidebar.tasks", icon: <CheckSquare size={BADGE_ICON_SIZE} /> },
  { id: "diary", labelKey: "sidebar.dailyRecords", icon: <BookOpen size={BADGE_ICON_SIZE} /> },
  { id: "ai-chat", labelKey: "sidebar.aiChat", icon: <Sparkles size={BADGE_ICON_SIZE} /> },
  { id: "shares", labelKey: "sidebar.shareManagement", icon: <Link2 size={BADGE_ICON_SIZE} /> },
];

interface ActivityBarBadgesProps {
  /** 与 NavRailMobile 的 railMode 联动：label 模式下徽章下显示文字。 */
  showLabel: boolean;
  /** 经典文字色偏好（同 NavRailMobile）。 */
  classicText: boolean;
}

export default function ActivityBarBadges({ showLabel, classicText }: ActivityBarBadgesProps) {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();
  // 布局 store（A 冻结接口）：读 + 订阅，写一律走 update* 函数。
  const layout = useSyncExternalStore(subscribeSidebarLayout, readSidebarLayout);
  const [addMenuPos, setAddMenuPos] = useState<{ x: number; y: number } | null>(null);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  const itemBaseClass = showLabel
    ? "relative w-[52px] py-1.5 rounded-[9px] flex flex-col items-center justify-center gap-0.5 transition-colors"
    : "relative w-[34px] h-[34px] rounded-[9px] flex items-center justify-center transition-colors";
  const labelClass = cn(
    "text-[10px] leading-none mt-0.5 max-w-full truncate px-1",
    classicText && "text-tx-tertiary",
  );

  const extraIds = useMemo(
    () => layout.badges.extra.filter((id): id is ToolTabKey => EXTRA_BADGE_CATALOG.some((badge) => badge.id === id)),
    [layout.badges.extra],
  );
  const extraExpanded = !layout.badges.extraCollapsed;

  /** 固定徽章点击 = 显示并展开对应侧栏面板（协议 v1：updateSidebarPanel）。 */
  const openPanel = useCallback((id: SidebarPanelId) => {
    updateSidebarPanel(id, { visible: true, collapsed: false });
  }, []);

  /** 工具徽章点击 = 打开对应工具页签（与侧栏底部工具条同一语义）。 */
  const openTool = useCallback((key: ToolTabKey) => {
    actions.openToolTab(key);
  }, [actions]);

  const toggleMoreGroup = useCallback(() => {
    updateSidebarBadges({ extraCollapsed: layout.badges.extraCollapsed });
  }, [layout.badges.extraCollapsed]);

  const toggleExtraBadge = useCallback(
    (id: string) => {
      const exists = layout.badges.extra.includes(id);
      const nextExtra = exists
        ? layout.badges.extra.filter((item) => item !== id)
        : [...layout.badges.extra, id];
      // 新加入时顺手展开「更多」组，让用户立刻看到新徽章（折叠态持久化在 store）。
      if (exists) updateSidebarBadges({ extra: nextExtra });
      else updateSidebarBadges({ extra: nextExtra, extraCollapsed: false });
    },
    [layout.badges.extra],
  );

  const openAddMenu = useCallback(() => {
    const rect = addBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Rail 滚动容器会裁剪溢出内容，菜单用 fixed 定位挂到视口坐标。
    const menuWidth = 216;
    const menuHeight = 44 + EXTRA_BADGE_CATALOG.length * 32;
    const x = Math.max(8, Math.min(rect.right + 6, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(rect.top, window.innerHeight - menuHeight - 8));
    setAddMenuPos({ x, y });
  }, []);

  useEffect(() => {
    if (!addMenuPos) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (addMenuRef.current?.contains(target)) return;
      if (addBtnRef.current?.contains(target)) return;
      setAddMenuPos(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuPos(null);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [addMenuPos]);

  const renderBadgeButton = (
    id: string,
    label: string,
    icon: React.ReactNode,
    options: {
      onContextMenu?: (event: React.MouseEvent) => void;
      testId?: string;
      /** 默认：面板徽章（显示并展开侧栏面板）；工具徽章传入 onClick/active 覆盖 */
      onClick?: () => void;
      active?: boolean;
    } = {},
  ) => {
    const active = options.active ?? layout.panels[id as SidebarPanelId]?.visible === true;
    return (
      <button
        key={id}
        type="button"
        data-rail-panel={id}
        data-testid={options.testId}
        onClick={options.onClick ?? (() => openPanel(id as SidebarPanelId))}
        onContextMenu={options.onContextMenu}
        title={showLabel ? undefined : label}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          itemBaseClass,
          active ? "bg-accent-primary/12 text-accent-primary" : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
        )}
      >
        {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent-primary" aria-hidden />}
        {icon}
        {showLabel && <span className={labelClass}>{label}</span>}
      </button>
    );
  };

  const addMenuLabels = new Map(EXTRA_BADGE_CATALOG.map((badge) => [badge.id, t(badge.labelKey)] as const));

  return (
    <div className="flex w-full flex-col items-center gap-1" data-activity-badges>
      {/* 固定徽章：文档树 / 标签 / 收藏 / 回收站 / 附件（常驻，不可移除） */}
      {FIXED_BADGE_IDS.map((id) =>
        renderBadgeButton(id, t(FIXED_BADGE_META[id].labelKey), FIXED_BADGE_META[id].icon),
      )}

      <div className={cn("my-1 border-t border-app-border/60", showLabel ? "w-8" : "w-6")} aria-hidden />

      {/* 「更多」开关：折叠时只显示一个徽章（带扩展徽章数量角标） */}
      {extraIds.length > 0 && (
        <button
          type="button"
          data-activity-badge-more=""
          onClick={toggleMoreGroup}
          title={showLabel ? undefined : t("sidebar.badgeMore", "更多")}
          aria-label={t("sidebar.badgeMore", "更多")}
          aria-expanded={extraExpanded}
          className={cn(itemBaseClass, "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary")}
        >
          <span className="relative flex items-center justify-center">
            <LayoutGrid size={BADGE_ICON_SIZE} />
            <ChevronDown
              size={11}
              className={cn(
                "absolute -bottom-1 -right-1 rounded-full bg-app-hover text-tx-secondary transition-transform",
                extraExpanded && "rotate-180",
              )}
              aria-hidden
            />
          </span>
          {!extraExpanded && (
            <span
              className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-app-hover px-1 text-[9px] tabular-nums text-tx-tertiary"
              aria-hidden
            >
              {extraIds.length}
            </span>
          )}
          {showLabel && <span className={labelClass}>{t("sidebar.badgeMore", "更多")}</span>}
        </button>
      )}

      {/* 展开的扩展徽章组：右键徽章 = 从活动栏移除入口（功能不删，面板仍可从面板清单打开） */}
      {extraIds.length > 0 && extraExpanded && (
        <div
          data-activity-badge-extra-group=""
          className="flex w-full flex-col items-center gap-1 rounded-xl border border-app-border bg-app-elevated/40 px-0.5 py-1"
        >
          {extraIds.map((id) => {
            const badge = EXTRA_BADGE_CATALOG.find((item) => item.id === id);
            if (!badge) return null;
            // 扩展徽章 = 工具入口：点击打开对应工具页签，激活态看 activeToolTab
            return renderBadgeButton(id, t(badge.labelKey), badge.icon, {
              onClick: () => openTool(id),
              active: state.activeToolTab === id,
              onContextMenu: (event) => {
                event.preventDefault();
                toggleExtraBadge(id);
              },
            });
          })}
        </div>
      )}

      {/* ＋ 添加徽章：勾选加入 / 取消移除「更多」组 */}
      <button
        type="button"
        ref={addBtnRef}
        data-activity-badge-add=""
        onClick={(event) => {
          event.stopPropagation();
          if (addMenuPos) setAddMenuPos(null);
          else openAddMenu();
        }}
        title={showLabel ? undefined : t("sidebar.badgeAdd", "添加徽章")}
        aria-label={t("sidebar.badgeAdd", "添加徽章")}
        aria-haspopup="menu"
        aria-expanded={addMenuPos !== null}
        className="w-[34px] h-[34px] rounded-[9px] flex items-center justify-center border border-dashed border-app-border text-tx-tertiary hover:bg-app-hover hover:text-tx-primary hover:border-solid transition-colors"
      >
        <Plus size={BADGE_ICON_SIZE} />
      </button>

      {addMenuPos && (
        <div
          ref={addMenuRef}
          data-activity-badge-menu=""
          role="menu"
          className="fixed z-[120] w-[216px] overflow-hidden rounded-xl border border-app-border bg-app-elevated p-1.5 shadow-2xl"
          style={{ left: addMenuPos.x, top: addMenuPos.y }}
        >
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold text-tx-tertiary">
            {t("sidebar.badgeAdd", "添加徽章")}
          </div>
          {EXTRA_BADGE_CATALOG.map((badge) => {
            const member = layout.badges.extra.includes(badge.id);
            return (
              <button
                key={badge.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={member}
                data-activity-badge-option={badge.id}
                onClick={() => {
                  toggleExtraBadge(badge.id);
                  setAddMenuPos(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
              >
                <span
                  className={cn(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                    member ? "border-accent-primary bg-accent-primary text-white" : "border-app-border",
                  )}
                  aria-hidden
                >
                  {member && <Check size={10} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{addMenuLabels.get(badge.id)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
