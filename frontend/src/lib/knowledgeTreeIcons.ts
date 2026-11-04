import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

/** 知识库可换的"书"封面色：默认蓝色，用户可在总览 ⋯ 菜单或侧栏图标选择器里换。 */
export const NOTEBOOK_EMOJIS = ["📘", "📗", "📙", "📕", "📔"];

/** 按格式取文档 emoji（无完整树节点时用，如打开的编辑器/搜索结果行）。 */
export function docEmojiForFormat(contentFormat?: string | null, noteType?: string | null): string {
  if (noteType === "sheet") return "📊";
  if (noteType === "word") return "📘";
  if (contentFormat === "board") return "🎨";
  if (contentFormat === "mindmap") return "🧠";
  if (contentFormat === "pdf") return "📕";
  if (contentFormat === "markdown") return "📝";
  if (contentFormat === "plain") return "🗒️";
  return "📄"; // 富文本（tiptap-json）
}

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
  // 导图遗留数据：nodeType/resourceType 是 mindmap 但 contentFormat 可能已归一，优先判断
  if (node.nodeType === "mindmap" || node.resourceType === "mindmap") return "🧠";
  return docEmojiForFormat(node.contentFormat, node.noteType);
}
