import { api } from "@/lib/api";
import type { useAppActions } from "@/store/AppContext";
import { toast } from "@/lib/toast";

/** 从侧栏面板打开一篇笔记：主区切到笔记工作区并登记页签（面板内容层共用）。 */
export async function openNoteFromSidebarPanel(
  noteId: string,
  actions: ReturnType<typeof useAppActions>,
  t: (key: string, options?: Record<string, unknown>) => string,
): Promise<void> {
  try {
    const note = await api.getNote(noteId);
    if (!note) return;
    actions.setActiveNote(note);
    actions.setSelectedNotebook(note.notebookId);
    actions.setViewMode("notebook");
    actions.setActiveToolTab(null);
    actions.openNoteTab({
      id: note.id,
      title: note.title,
      notebookId: note.notebookId,
      workspaceId: note.workspaceId,
      contentFormat: note.contentFormat,
      isLocked: note.isLocked,
      isTrashed: note.isTrashed,
      updatedAt: note.updatedAt,
    });
    actions.setMobileView("editor");
  } catch {
    toast.error(t("sidebar.panelOpenFailed"));
  }
}
