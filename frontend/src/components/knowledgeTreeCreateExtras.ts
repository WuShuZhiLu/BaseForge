import { prompt } from "@/components/ui/confirm";
import { knowledgeTreeApi } from "@/lib/knowledgeTreeApi";
import { revealCreatedKnowledgeTreeNote } from "@/lib/knowledgeTreeCreateVisibility";
import { pushSheetAppPath } from "@/lib/sheetDeepLink";
import { emitKnowledgeTreeRefresh } from "@/lib/workspaceRefreshBridge";
import { toast } from "@/lib/toast";

/**
 * 从知识树创建轻量表格：弹出标题输入 → 建 sheet 节点 → 跳到 /sheets/:id。
 * 供知识树「新建」下拉与移动端知识树复用，与 NoteList 的创建行为保持一致。
 */
export async function createSheetInKnowledgeTree(parentId: string | null): Promise<void> {
  try {
    const entered = await prompt({
      title: "新建轻量表格",
      defaultValue: "无标题表格",
      confirmText: "创建",
    });
    if (!entered?.trim()) return;

    const node = await knowledgeTreeApi.create({
      parentId,
      nodeType: "sheet",
      title: entered.trim(),
    });

    revealCreatedKnowledgeTreeNote(parentId);
    emitKnowledgeTreeRefresh("sheet-created-from-knowledge-tree");
    pushSheetAppPath(node.resourceId);
  } catch (error: any) {
    console.error("Failed to create sheet from knowledge tree:", error);
    toast.error(error?.message || "创建表格失败，请重试");
  }
}
