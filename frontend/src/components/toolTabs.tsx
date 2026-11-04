import React from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, BrainCircuit, CheckSquare, Link2, Paperclip, Trash2, Sparkles, FileText } from "lucide-react";
import { useAppActions, type ToolTabKey } from "@/store/AppContext";

/**
 * 工具页签键 → 展示文案与图标（方案 B · B2）。
 * MainTopBar 的页签条与「工具」菜单共用这份定义，保证两处不会漂移。
 */

export interface ToolTabMeta {
  key: ToolTabKey;
  labelKey: string;
  defaultLabel: string;
  icon: React.ReactNode;
}

export const TOOL_TAB_META: ToolTabMeta[] = [
  { key: "tasks", labelKey: "sidebar.tasks", defaultLabel: "待办", icon: <CheckSquare size={13} /> },
  { key: "diary", labelKey: "sidebar.dailyRecords", defaultLabel: "小记", icon: <BookOpen size={13} /> },
  { key: "ai-chat", labelKey: "sidebar.aiChat", defaultLabel: "AI 对话", icon: <Sparkles size={13} /> },
  { key: "shares", labelKey: "sidebar.shareManagement", defaultLabel: "分享中心", icon: <Link2 size={13} /> },
  { key: "files", labelKey: "sidebar.fileManager", defaultLabel: "附件", icon: <Paperclip size={13} /> },
  { key: "trash", labelKey: "sidebar.trash", defaultLabel: "回收站", icon: <Trash2 size={13} /> },
];

export function toolTabMeta(key: ToolTabKey): ToolTabMeta {
  return TOOL_TAB_META.find((item) => item.key === key) || TOOL_TAB_META[0];
}

/** 供 ToolPageHost 复用：把跨视图跳转统一收敛为「打开笔记」或「切换工具页签」。 */
export function useToolPageNavigation() {
  const actions = useAppActions();
  return {
    openNoteTab: async (noteId: string) => {
      const { api } = await import("@/lib/api");
      const note = await api.getNote(noteId);
      if (!note) return;
      actions.setActiveNote(note);
      actions.setActiveToolTab(null);
      actions.setMobileView("editor");
    },
    openToolTab: (key: ToolTabKey) => actions.setActiveToolTab(key),
  };
}

/**
 * 工具页 → 宿主的导航事件（契约 5，协议 v1.1）。
 * 工具页作为页签挂载时不得调用 actions.setViewMode（会顶掉主区），
 * 需要「打开某篇笔记」「关闭自己」「切回笔记工作区」时派发本事件，由 ToolPageHost 翻译。
 */
export const TOOL_PAGE_NAVIGATE_EVENT = "nowen:tool-page-navigate";

export type ToolPageNavigateDetail =
  | { kind: "note"; noteId: string }
  | { kind: "close" }
  /** v1.1：关闭当前工具页签并切回笔记工作区（替代页面内直接 setViewMode）。 */
  | { kind: "view"; view: "notebook" | "all" };

export function navigateToolPage(detail: ToolPageNavigateDetail) {
  window.dispatchEvent(new CustomEvent<ToolPageNavigateDetail>(TOOL_PAGE_NAVIGATE_EVENT, { detail }));
}

export { FileText, BrainCircuit };
