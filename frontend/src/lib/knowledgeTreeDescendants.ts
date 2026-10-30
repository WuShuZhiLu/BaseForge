import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

/**
 * 收集节点子树里所有知识库（目录）的资源 id 与名称。
 * 导出目录为 Markdown 时需要用它把子目录层级一起交给导出任务。
 */
export function descendantNotebookResources(node: KnowledgeTreeNode, nodes: KnowledgeTreeNode[]) {
  const children = new Map<string, KnowledgeTreeNode[]>();
  for (const candidate of nodes) {
    if (!candidate.parentId) continue;
    const list = children.get(candidate.parentId) || [];
    list.push(candidate);
    children.set(candidate.parentId, list);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const stack = [node];
  const visited = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.resourceType === "notebook") {
      ids.add(current.resourceId);
      names.add(current.title);
    }
    for (const child of children.get(current.id) || []) stack.push(child);
  }
  return { ids, names };
}
