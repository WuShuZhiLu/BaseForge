import React, { useEffect, useRef } from "react";
import { confirm } from "@/components/ui/confirm";
import TaskWorkspaceImpl from "./TaskWorkspaceImpl";
import { TaskMetadataWorkspace } from "./tasks/TaskMetadataWorkspace";
import TaskEntryUxBridge from "./tasks/TaskEntryUxBridge";
import TaskDetailRichExperienceBridge from "./tasks/TaskDetailRichExperienceBridge";
import { shouldConfirmHabitDelete } from "./tasks/taskCenterHardening";
import type { ToolPageHeaderMode } from "@/lib/toolPage";

/** 页签契约：页面自带标题行（任务中心头部），宿主顶栏无需重复渲染。 */
export const TOOL_PAGE_HEADER_MODE: ToolPageHeaderMode = "own";

export * from "./TaskWorkspaceImpl";

export default function TaskWorkspace({ hideSidebar }: { hideSidebar?: boolean } = {}) {
  // 确认通过后重新派发的点击不再重复拦截
  const bypass = useRef(false);
  useEffect(() => {
    const handleDeleteCapture = (event: MouseEvent) => {
      if (bypass.current) { bypass.current = false; return; }
      if (!shouldConfirmHabitDelete(event.target)) return;
      const chinese = document.documentElement.lang.toLowerCase().startsWith("zh");
      // 先同步阻断原始点击（事件已经分发，无法等待异步结果），再弹应用内确认；
      // 确认通过后重新派发一次点击，由原监听器完成删除。
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const target = event.target;
      if (!(target instanceof Element)) return;
      void confirm({
        title: chinese ? "永久删除该习惯？" : "Permanently delete this habit?",
        description: chinese
          ? "该操作会同时删除全部打卡历史，且无法恢复。"
          : "All check-in history will also be deleted and cannot be restored.",
        confirmText: chinese ? "永久删除" : "Delete permanently",
        danger: true,
      }).then((accepted) => {
        if (!accepted) return;
        bypass.current = true;
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        // dispatchEvent 同步执行，捕获阶段会消费掉这个标记；这里兑底防止标记残留到下一次点击。
        bypass.current = false;
      });
    };
    document.addEventListener("click", handleDeleteCapture, true);
    return () => document.removeEventListener("click", handleDeleteCapture, true);
  }, []);

  return (
    <TaskMetadataWorkspace>
      <TaskEntryUxBridge />
      <TaskDetailRichExperienceBridge />
      <TaskWorkspaceImpl hideSidebar={hideSidebar} />
    </TaskMetadataWorkspace>
  );
}
