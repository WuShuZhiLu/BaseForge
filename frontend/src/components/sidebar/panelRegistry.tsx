import React from "react";
import {
  BookOpen,
  CheckSquare,
  FileCode,
  FolderTree,
  ListTree,
  Paperclip,
  PanelLeft,
  Star,
  Tags,
  Trash2,
  Clock,
} from "lucide-react";
import type { SidebarPanelId } from "@/lib/sidebarPanels";

/**
 * 侧栏面板注册表（面板框架 S1，A 维护）
 *
 * 每个面板声明：标题（i18n）、图标、**按特性配置的头部动作**、能否关闭、能否移动、
 * 以及内容渲染函数。面板头由 SidebarPanelShell 统一渲染——内容组件**不要再自带头部**。
 *
 * 动作口径（用户 2026-10-16 定，见 .cmp/SPEC-sidebar-framework.md 第三节）：
 *  - 只有具备「新建/上传」语义的面板才有 new；只有需要重新拉数据的面板才有 refresh；
 *  - 关闭动作一律放在 ⋯ 菜单里，头部不出现 ✕；文档树固定，不提供关闭与移动。
 *
 * 已知边界（不改他人文件）：文档树面板自带的「＋新建根文件夹 / ⋯目录操作」位于其内部工具栏，
 * 暂不迁移到壳头（迁移需改 KnowledgeTreePanel.tsx，属 B 名下文件）；因此文档树的壳头动作
 * 只给「更多（全部展开 / 全部折叠 / 排序方式）」。
 */

export type PanelActionKey = "new" | "refresh" | "more";

export interface SidebarPanelDefinition {
  id: SidebarPanelId;
  /** i18n key（找不到时用 defaultTitle） */
  titleKey: string;
  defaultTitle: string;
  icon: React.ReactNode;
  actions: PanelActionKey[];
  closable: boolean;
  movable: boolean;
  /** 固定面板：不可关闭、不可移动（文档树） */
  fixed?: boolean;
  /** 计数来源：由内容组件通过 data 属性或 store 提供；此处仅作壳头展示的可选值 */
  count?: (ctx: { openNoteTabs: number; tags: number }) => number | null;
  render: () => React.ReactNode;
}

export const ICON_SIZE = 14;

export const SIDEBAR_PANELS: Record<SidebarPanelId, SidebarPanelDefinition> = {
  tree: {
    id: "tree",
    titleKey: "sidebar.panelTree",
    defaultTitle: "文档树",
    icon: <FolderTree size={ICON_SIZE} />,
    // 过渡期：树自身工具栏保留 ＋/⋯，面板头暂不重复；待新的树内容组件落地后由面板头统一
    actions: [],
    closable: false,
    movable: false,
    fixed: true,
    render: null as unknown as () => React.ReactNode, // 由 SidebarMobile 注入（需要 variant / 视图模式）
  },
  openEditors: {
    id: "openEditors",
    titleKey: "sidebar.openEditors",
    defaultTitle: "打开的",
    icon: <PanelLeft size={ICON_SIZE} />,
    actions: ["refresh"],
    closable: true,
    movable: true,
    count: ({ openNoteTabs }) => openNoteTabs,
    render: null as unknown as () => React.ReactNode,
  },
  tags: {
    id: "tags",
    titleKey: "sidebar.panelTags",
    defaultTitle: "标签",
    icon: <Tags size={ICON_SIZE} />,
    actions: ["more"],
    closable: true,
    movable: true,
    count: ({ tags }) => tags,
    render: null as unknown as () => React.ReactNode,
  },
  fav: {
    id: "fav",
    titleKey: "sidebar.panelFav",
    defaultTitle: "收藏",
    icon: <Star size={ICON_SIZE} />,
    actions: ["more"],
    closable: true,
    movable: true,
    render: null as unknown as () => React.ReactNode,
  },
  trash: {
    id: "trash",
    titleKey: "sidebar.panelTrash",
    defaultTitle: "回收站",
    icon: <Trash2 size={ICON_SIZE} />,
    actions: ["refresh", "more"],
    closable: true,
    movable: true,
    render: null as unknown as () => React.ReactNode,
  },
  files: {
    id: "files",
    titleKey: "sidebar.panelFiles",
    defaultTitle: "附件",
    icon: <Paperclip size={ICON_SIZE} />,
    actions: ["refresh", "more"],
    closable: true,
    movable: true,
    render: null as unknown as () => React.ReactNode,
  },
};

/** 供「面板清单」显示：可添加的面板（当前都被注册，后续可按需过滤）。 */
export const PANEL_ORDER_HINT: SidebarPanelId[] = ["tree", "openEditors", "tags", "fav", "trash", "files"];

export { FileCode };
