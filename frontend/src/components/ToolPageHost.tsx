import React, { useEffect } from "react";
import FileManager from "@/components/FileManager";
import ShareManagementPage from "@/components/ShareManagementPage";
import TaskWorkspace from "@/components/TaskWorkspace";
import TrashPage from "@/features/trash/TrashPage";
import { useApp, useAppActions, type ToolTabKey } from "@/store/AppContext";
import { TOOL_PAGE_NAVIGATE_EVENT, type ToolPageNavigateDetail } from "@/components/toolTabs";

/**
 * 工具页宿主（方案 B · B2）。
 *
 * 两条关键约定（B 线的对接协议，见 .cmp/COLLAB-BOARD.md）：
 *
 * 1) **keepAlive 挂载（契约 4）**：所有「已打开」的工具页签同时挂载，非激活的用
 *    `hidden`（display:none）隐藏，而不是卸载——切页签时滚动位置、输入草稿、展开
 *    状态全部保留。代价是隐藏页签的 effect 仍在运行，工具页应避免高频轮询。
 *
 * 2) **跨页导航（契约 5）**：工具页需要「打开笔记」或「关闭自己」时，不要调用
 *    actions.setViewMode（会顶掉主区），改为派发 TOOL_PAGE_NAVIGATE_EVENT，
 *    由本宿主翻译成「打开笔记」/「关闭当前工具页签」。
 *
 * 工具页组件本身不因页签化而修改；旧的 viewMode 路径在 B2-P 完成前继续保留。
 */

interface Props {
  tool: ToolTabKey;
}

export default function ToolPageHost({ tool }: Props) {
  const { state } = useApp();
  const actions = useAppActions();

  // 跨页导航事件：作用于「当前激活的工具页签」。
  useEffect(() => {
    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<ToolPageNavigateDetail>).detail;
      if (!detail) return;
      if (detail.kind === "close") {
        actions.closeToolTab(tool);
        return;
      }
      if (detail.kind === "view") {
        // v1.1：关闭当前工具页签并切回笔记工作区（替代页面内直接 setViewMode）
        actions.closeToolTab(tool);
        actions.setViewMode(detail.view);
        return;
      }
      if (detail.kind === "note" && detail.noteId) {
        void (async () => {
          try {
            const { api } = await import("@/lib/api");
            const note = await api.getNote(detail.noteId as string);
            if (!note) return;
            actions.setActiveNote(note);
            actions.setActiveToolTab(null);
            actions.setMobileView("editor");
          } catch (err) {
            console.error("Tool page navigate failed:", err);
          }
        })();
      }
    };
    window.addEventListener(TOOL_PAGE_NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(TOOL_PAGE_NAVIGATE_EVENT, onNavigate);
  }, [actions, tool]);

  const openKeys = state.openToolTabs.length > 0 ? state.openToolTabs : [tool];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-tool-page-host="">
      {openKeys.map((key) => {
        const active = key === tool;
        return (
          <div
            key={key}
            data-tool-page={key}
            data-tool-page-active={active ? "true" : "false"}
            // keepAlive：非激活页签保留挂载，仅隐藏（状态不丢）
            className={active ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" : "hidden"}
            aria-hidden={active ? undefined : true}
          >
            {renderToolPage(key, actions)}
          </div>
        );
      })}
    </div>
  );
}

function renderToolPage(key: ToolTabKey, actions: ReturnType<typeof useAppActions>) {
  switch (key) {
    case "tasks":
      return <TaskWorkspace />;
    case "shares":
      return <ShareManagementPage />;
    case "files":
      return <FileManager />;
    case "trash":
      return <TrashPage />;
    default:
      return null;
  }
}
