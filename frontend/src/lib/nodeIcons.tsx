/**
 * 树节点图标体系（B2-I）：节点类型 → 线性图标 + 语义色。
 *
 * 规格（.cmp/SPEC-planB.md 第七节，2026-10-14 用户定稿）：
 *  - 全站线性图标（lucide，stroke 1.6），不使用 emoji；
 *  - 语义色：文件夹琥珀 #D97706 · 文档蓝 #2563EB · Markdown 灰 #8B8B93
 *    · 导图紫 #7C3AED · 表格绿 #059669；
 *  - 用户自选 emoji 图标（文件夹 node.icon）保留，缩至 14px 与线性图标同基线。
 */
import { FileCode, FileText, FileType2, Folder, Table2, Waypoints, FileDigit, PenTool } from "lucide-react";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { cn } from "@/lib/utils";

export const NODE_ICON_SEMANTIC_COLORS = {
  folder: "#D97706",
  note: "#2563EB",
  markdown: "#8B8B93",
  plain: "#64748B",
  board: "#0D9488",
  mindmap: "#7C3AED",
  sheet: "#059669",
  word: "#2563EB",
  pdf: "#DC2626",
} as const;

export type NodeIconKind = keyof typeof NODE_ICON_SEMANTIC_COLORS;

const NODE_ICON_COMPONENTS = {
  folder: Folder,
  note: FileText,
  markdown: FileCode,
  plain: FileDigit,
  board: PenTool,
  mindmap: Waypoints,
  sheet: Table2,
  word: FileType2,
  pdf: FileText,
} as const;

/** 依据节点模型判定图标语义类别（nodeType 优先，resourceType 兜底导图）。
 *  注：知识树 trigger 将 plain 笔记的 nodeType 映射为 "note"（树内显示通用文档图标），
 *  "plain" 类别仅供内联新建草稿图标（NodeKindIcon）使用。
 *  导图归一后是 contentFormat="mindmap" 的笔记节点。 */
export function resolveNodeIconKind(node: Pick<KnowledgeTreeNode, "nodeType" | "resourceType" | "noteType" | "contentFormat">): NodeIconKind {
  if (node.nodeType === "folder") return "folder";
  if (node.nodeType === "markdown") return "markdown";
  if (node.nodeType === "mindmap" || node.resourceType === "mindmap" || node.contentFormat === "mindmap") return "mindmap";
  if (node.noteType === "sheet") return "sheet";
  if (node.contentFormat === "board") return "board";
  if (node.contentFormat === "pdf") return "pdf";
  if (node.nodeType === "word") return "word";
  return "note";
}

/** 依据语义类别直接渲染图标（树内联新建草稿等无完整 node 场景用）。 */
export function NodeKindIcon({ kind, size = 15, className }: {
  kind: NodeIconKind;
  size?: number;
  className?: string;
}) {
  const Icon = NODE_ICON_COMPONENTS[kind];
  return <Icon size={size} className={cn("shrink-0", className)} style={{ color: NODE_ICON_SEMANTIC_COLORS[kind] }} />;
}

const USER_EMOJI_ICON_SIZE_PX = 14;

export function NodeIcon({ node, size = 15, className }: {
  node: KnowledgeTreeNode;
  size?: number;
  className?: string;
}) {
  const kind = resolveNodeIconKind(node);
  if (kind === "folder" && node.icon) {
    // 用户自选 emoji：保留但缩到 14px，与线性图标同基线。
    return (
      <span
        className={cn("shrink-0 text-center leading-none", className)}
        style={{ width: size, height: size, fontSize: USER_EMOJI_ICON_SIZE_PX, lineHeight: 1 }}
      >
        {node.icon}
      </span>
    );
  }
  const Icon = NODE_ICON_COMPONENTS[kind];
  return <Icon size={size} className={cn("shrink-0", className)} style={{ color: NODE_ICON_SEMANTIC_COLORS[kind] }} />;
}
