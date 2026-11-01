import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useApp, useAppActions, type OpenNoteTab } from "@/store/AppContext";
import { api } from "@/lib/api";
import { useNoteLoader } from "@/hooks/useNoteLoader";
import { toast } from "@/lib/toast";

/** 关闭一个页签后应激活的相邻页签：右侧优先，否则左侧，否则 null。 */
export function getNextTabAfterClose(tabs: OpenNoteTab[], closingId: string): OpenNoteTab | null {
  const index = tabs.findIndex((tab) => tab.id === closingId);
  if (index === -1) return null;
  return tabs[index + 1] || tabs[index - 1] || null;
}

/**
 * 从页签 / 侧栏「打开的」面板打开一篇笔记的统一入口。
 *
 * 走 useNoteLoader 的 primaryNoteLoadCoordinator（缓存优先、最新意图优先、
 * 激活守卫 intent），与深链 / 列表 / 搜索是同一条加载链路——
 * 此前 OpenEditorsPanel 与 SidebarDesktop 用裸 api.getNote + setActiveNote
 * 绕过协调器，在加载竞态窗口内会被 NoteActivationGuard 静默丢弃（点不动）。
 */
export function useTabNoteOpener() {
  const { state } = useApp();
  const actions = useAppActions();
  const { t } = useTranslation();
  const { loadNote, cancelNoteLoad } = useNoteLoader();

  const openNote = useCallback(async (noteId: string) => {
    if (state.activeNote?.id === noteId) {
      // 已是当前笔记：若还有指向别的笔记的加载在途，取消它避免迟到的回写。
      const pendingNoteId = state.noteLoadingState?.pendingNoteId ?? null;
      if (pendingNoteId && pendingNoteId !== noteId) {
        cancelNoteLoad();
      }
      return;
    }
    try { window.dispatchEvent(new CustomEvent("nowen:before-note-switch")); } catch { /* ignore */ }
    const tab = state.openNoteTabs?.find((item) => item.id === noteId);
    const result = await loadNote({
      noteId,
      summary: {
        title: tab?.title ?? "",
        notebookId: tab?.notebookId ?? "",
        contentFormat: tab?.contentFormat,
      },
      request: () => api.getNote(noteId),
      onSuccess: (note) => {
        const existingTab = state.openNoteTabs?.find((item) => item.id === note.id);
        actions.setActiveNote(note);
        actions.setSelectedNotebook(note.notebookId);
        actions.setViewMode("notebook");
        actions.setActiveToolTab(null);
        actions.setMobileView("editor");
        actions.openNoteTab({
          id: note.id,
          title: note.title,
          notebookId: note.notebookId,
          workspaceId: note.workspaceId,
          contentFormat: note.contentFormat,
          isLocked: note.isLocked,
          isTrashed: note.isTrashed,
          updatedAt: note.updatedAt,
          pinned: existingTab?.pinned,
        });
      },
    });
    if (!result) return; // 加载被取消（协调器返回 undefined）
    // 404 自愈：页签指向已删除/不存在的笔记时，把死页签从「打开的」移除并清掉
    // 错误浮层。此前死页签永远留着，点击只会反复报「打开失败」。
    if (result.status === "error" && (result.error as { status?: number } | undefined)?.status === 404) {
      actions.removeNoteTab(noteId);
      cancelNoteLoad();
      toast.error(t("editorTabs.tabNoteMissing", { defaultValue: "笔记不存在或已被删除，已从「打开的」移除" }));
    }
  }, [actions, cancelNoteLoad, loadNote, state.activeNote?.id, state.noteLoadingState?.pendingNoteId, state.openNoteTabs, t]);

  return openNote;
}
