import type { ComponentType } from "react";
import type { SidebarPanelId } from "@/lib/sidebarPanels";
import OpenEditorsPanel from "@/components/sidebar/panels/OpenEditorsPanel";
import FavoritesPanel from "@/components/sidebar/panels/FavoritesPanel";
import AttachmentsPanel from "@/components/sidebar/panels/AttachmentsPanel";
import TrashPanel from "@/components/sidebar/panels/TrashPanel";

/**
 * 面板内容注册表（内容层 v1）
 *
 * 只登记**新实现**的内容组件（旧组件文件保留，但不再挂载）。
 * 未登记的面板由容器回退到：contents 注入（标签需回调接线、树需 mode）→ 占位提示。
 */
export const PANEL_CONTENT: Partial<Record<SidebarPanelId, ComponentType<Record<string, never>>>> = {
  openEditors: OpenEditorsPanel as ComponentType<Record<string, never>>,
  fav: FavoritesPanel as ComponentType<Record<string, never>>,
  files: AttachmentsPanel as ComponentType<Record<string, never>>,
  trash: TrashPanel as ComponentType<Record<string, never>>,
};
