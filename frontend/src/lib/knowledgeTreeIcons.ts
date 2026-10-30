import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

/** 知识库可换的"书"封面色：默认蓝色，用户可在总览 ⋯ 菜单或侧栏图标选择器里换。 */
export const NOTEBOOK_EMOJIS = ["📘", "📗", "📙", "📕", "📔"];

/**
 * 知识树节点 emoji 图标：总览页与侧栏共用，保证两处类型视觉一致。
 * 类型分支与后端 contentFormat/noteType 语义对齐（含导图归一与遗留数据）。
 */
export function knowledgeTreeEmojiFor(node: KnowledgeTreeNode, isRoot = false): string {
  if (node.nodeType === "folder") {
    // 根层知识库（笔记本）：只认五色书封面，历史遗留的其它 emoji 一律回落默认蓝色
    if (isRoot && node.resourceType === "notebook") {
      const icon = node.icon || "";
      return (NOTEBOOK_EMOJIS as string[]).includes(icon) ? icon : NOTEBOOK_EMOJIS[0];
    }
    return "📁";
  }
  if (node.noteType === "sheet") return "📊";
  if (node.noteType === "word") return "📘";
  if (node.contentFormat === "board") return "🎨";
  if (node.nodeType === "mindmap" || node.resourceType === "mindmap" || node.contentFormat === "mindmap") return "🧠";
  if (node.contentFormat === "pdf") return "📕";
  if (node.contentFormat === "markdown" || node.nodeType === "markdown") return "📝";
  if (node.contentFormat === "plain") return "🗒️";
  return "📄"; // 富文本（tiptap-json）
}
