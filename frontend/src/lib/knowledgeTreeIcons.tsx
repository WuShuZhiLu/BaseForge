import { BookMarked, File, FileCode, FileText, FileType2, Folder, Link2, Network, PenTool, Table } from "lucide-react";
import type { ReactNode } from "react";

import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

/**
 * 知识树 / 知识库总览的图标映射（原 emoji 版）。
 *
 * 统一改成 lucide 线性图标并着色：形状与「回收站 / 文件管理」的类型筛选一致，
 * 颜色按类型区分（文件夹琥珀、表格绿、脑图紫、画板粉、PDF 红…）。
 * 知识库封面用 BookMarked + 5 种色调，新值存 `cover:<key>`，历史 emoji 读取时自动映射。
 */

export type NotebookCoverKey = "indigo" | "emerald" | "amber" | "rose" | "violet";

export const NOTEBOOK_COVERS: Array<{ key: NotebookCoverKey; label: string; className: string }> = [
  { key: "indigo", label: "蓝", className: "text-indigo-600 dark:text-indigo-400" },
  { key: "emerald", label: "绿", className: "text-emerald-600 dark:text-emerald-400" },
  { key: "amber", label: "橙", className: "text-amber-600 dark:text-amber-400" },
  { key: "rose", label: "红", className: "text-rose-600 dark:text-rose-400" },
  { key: "violet", label: "紫", className: "text-violet-600 dark:text-violet-400" },
];

/** 历史 emoji 封面 → 最近色系；其余 emoji / 脏数据统一回落默认蓝。 */
const LEGACY_COVER: Record<string, NotebookCoverKey> = {
  "📘": "indigo",
  "📗": "emerald",
  "📙": "amber",
  "📕": "rose",
  "📔": "violet",
  "📒": "indigo",
  "📓": "indigo",
  "📚": "indigo",
  "📖": "indigo",
};

export function notebookCoverKey(icon?: string | null): NotebookCoverKey {
  const raw = String(icon ?? "");
  if (raw.startsWith("cover:")) {
    const key = raw.slice("cover:".length) as NotebookCoverKey;
    return NOTEBOOK_COVERS.some((cover) => cover.key === key) ? key : "indigo";
  }
  return LEGACY_COVER[raw] ?? "indigo";
}

/** 写入 notebooks.icon 的新值（保留字符串字段，不动后端契约）。 */
export function notebookCoverValue(key: NotebookCoverKey): string {
  return `cover:${key}`;
}

export function notebookCoverClassName(icon?: string | null): string {
  const key = notebookCoverKey(icon);
  return NOTEBOOK_COVERS.find((cover) => cover.key === key)?.className || NOTEBOOK_COVERS[0].className;
}

/** 知识库封面图标（树行 / 总览 / 选择器共用）。 */
export function notebookCoverIcon(icon?: string | null, size = 14): ReactNode {
  return <BookMarked size={size} strokeWidth={2} className={`shrink-0 ${notebookCoverClassName(icon)}`} aria-hidden />;
}

const DOC_ICON_CLASS = {
  rich: "text-blue-600 dark:text-blue-400",
  plain: "text-slate-500 dark:text-slate-400",
  markdown: "text-sky-600 dark:text-sky-400",
  mindmap: "text-violet-600 dark:text-violet-400",
  board: "text-pink-600 dark:text-pink-400",
  sheet: "text-emerald-600 dark:text-emerald-400",
  word: "text-blue-800 dark:text-blue-300",
  pdf: "text-red-600 dark:text-red-400",
} as const;

/** 按格式取文档图标（无完整树节点时用，如打开的编辑器 / 搜索结果行）。 */
export function docIconForFormat(contentFormat?: string | null, noteType?: string | null, size = 14): ReactNode {
  if (noteType === "sheet") return <Table size={size} strokeWidth={2} className={`shrink-0 ${DOC_ICON_CLASS.sheet}`} aria-hidden />;
  if (noteType === "word") return <FileType2 size={size} strokeWidth={2} className={`shrink-0 ${DOC_ICON_CLASS.word}`} aria-hidden />;
  if (contentFormat === "board") return <PenTool size={size} strokeWidth={2} className={`shrink-0 ${DOC_ICON_CLASS.board}`} aria-hidden />;
  if (contentFormat === "mindmap") return <Network size={size} strokeWidth={2} className={`shrink-0 ${DOC_ICON_CLASS.mindmap}`} aria-hidden />;
  if (contentFormat === "pdf") return <FileText size={size} strokeWidth={2} className={`shrink-0 ${DOC_ICON_CLASS.pdf}`} aria-hidden />;
  if (contentFormat === "markdown") return <FileCode size={size} strokeWidth={2} className={`shrink-0 ${DOC_ICON_CLASS.markdown}`} aria-hidden />;
  if (contentFormat === "plain") return <File size={size} strokeWidth={2} className={`shrink-0 ${DOC_ICON_CLASS.plain}`} aria-hidden />;
  return <FileText size={size} strokeWidth={2} className={`shrink-0 ${DOC_ICON_CLASS.rich}`} aria-hidden />;
}

/** 知识树节点图标：总览页与侧栏共用，保证两处类型视觉一致。 */
export function knowledgeTreeIconFor(node: KnowledgeTreeNode, isRoot = false, size = 14): ReactNode {
  if (node.nodeType === "folder") {
    // 根层知识库（笔记本）：BookMarked + 封面色调；其余文件夹用琥珀 Folder
    if (isRoot && node.resourceType === "notebook") return notebookCoverIcon(node.icon, size);
    return <Folder size={size} strokeWidth={2} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />;
  }
  // 导图遗留数据：nodeType/resourceType 是 mindmap 但 contentFormat 可能已归一，优先判断
  if (node.nodeType === "mindmap" || node.resourceType === "mindmap") {
    return <Network size={size} strokeWidth={2} className={`shrink-0 ${DOC_ICON_CLASS.mindmap}`} aria-hidden />;
  }
  return docIconForFormat(node.contentFormat, node.noteType, size);
}

/** 「引用 / 快捷方式」节点的角标。 */
export function referenceNodeIcon(size = 11): ReactNode {
  return <Link2 size={size} strokeWidth={2} className="shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />;
}
