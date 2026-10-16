import { useCallback, useEffect } from "react";
import { BrainCircuit, FileText, Folder, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getCurrentWorkspace } from "@/lib/api";
import { reportPanelCount } from "@/lib/sidebarPanelCounts";
import { useAppActions } from "@/store/AppContext";
import { useTrash } from "@/features/trash/useTrash";
import {
  PanelBody,
  PanelEmpty,
  PanelFooterButton,
  PanelLoading,
  PanelRow,
  usePanelRefresh,
} from "@/components/sidebar/panels/shared";

/**
 * 回收站面板（内容层 v1 · B-9，B 名下）
 *
 * - 数据源照旧：features/trash 的 useTrash（列表 + restore mutate；内部自带 reload、
 *   realtime/tree-changed 自动刷新与防重入）；框架刷新协议走 usePanelRefresh("trash", reload)；
 * - 行为：整行点击 = 恢复该条目（RotateCcw 视觉提示，恢复是非破坏操作）；
 * - 底部「打开完整页」= actions.setViewMode("trash")（契约允许的既有跳转）；
 * - 不自带头部：标题/计数/⋯ 动作由 SidebarPanelShell 提供，计数经 reportPanelCount 上报。
 */
export default function TrashPanel() {
  const { t } = useTranslation();
  const actions = useAppActions();
  const { items, loading, mutate, reload } = useTrash(getCurrentWorkspace(), 0);
  usePanelRefresh("trash", () => {
    void reload();
  });

  // 计数上报：面板头计数 pill 由容器读取。
  useEffect(() => {
    reportPanelCount("trash", items.length);
  }, [items.length]);

  const restore = useCallback(
    async (id: string) => {
      await mutate("restore", [id]);
    },
    [mutate],
  );

  const icon = (type: string) =>
    type === "notebook" || type === "folder" ? (
      <Folder size={13} className="shrink-0 text-amber-500" />
    ) : type === "mindmap" ? (
      <BrainCircuit size={13} className="shrink-0 text-violet-500" />
    ) : (
      <FileText size={13} className="shrink-0 text-accent-primary" />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelBody>
        {loading ? (
          <PanelLoading />
        ) : items.length === 0 ? (
          <PanelEmpty text={t("sidebar.trashEmpty")} />
        ) : (
          items.slice(0, 40).map((item) => (
            <PanelRow
              key={item.id}
              title={item.title}
              onClick={() => void restore(item.id)}
              leading={icon(String(item.resourceType))}
              trailing={<RotateCcw size={12} className="shrink-0 text-tx-tertiary" />}
            >
              {item.title || t("noteList.untitled")}
            </PanelRow>
          ))
        )}
      </PanelBody>
      <PanelFooterButton label={t("sidebar.openFullTrash")} onClick={() => actions.setViewMode("trash")} />
    </div>
  );
}
