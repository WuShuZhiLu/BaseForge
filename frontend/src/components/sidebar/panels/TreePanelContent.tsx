import KnowledgeTreePanel from "@/components/KnowledgeTreePanel";
import MobileKnowledgeTreePanel from "@/components/MobileKnowledgeTreePanel";

/**
 * 文档树面板内容（内容层 v1 · B-10，B 名下）
 *
 * - 形态：`({ mode }: { mode: "quick" | "full" })`——quick = 快捷浏览（旧 MobileKnowledgeTreePanel
 *   的桌面形态），full = 递归文档树（旧 KnowledgeTreePanel）；按既有 desktopKnowledgeTreeMode 语义分派；
 * - 树渲染走**委托链**：树能力（展开/折叠、右键菜单、拖拽、行内建/导入、筛选行）全部由被委托的
 *   既有组件提供，本组件只做编排与包装，不复制其内部逻辑、不改旧组件文件；
 * - 筛选行：由旧树**自带**（输入框 + 「目录 / 内容」范围切换，data-knowledge-tree-search），
 *   本组件不重复实现第二份筛选输入；按用户口径「不给旧组件加抑制开关」，这里用**作用域样式**
 *   只隐藏与面板头重复的三个动作按钮（＋新建 / 全部展开收起 / 刷新），筛选行原样保留可用；
 * - 无重复动作按钮：动作统一收在面板头（A 的 Shell，⋯ 菜单：全部展开 / 全部折叠 / 排序 / 刷新）；
 * - 不自带头部：标题/计数/动作由 SidebarPanelShell 提供。
 *   TODO（迭代 b）：基于 knowledgeTreeApi 自建树渲染后，移除下方作用域样式。
 */
export type TreePanelContentMode = "quick" | "full";

/** 与面板头 ⋯ 重复的旧树内部动作按钮（title 为旧组件内硬编码文案，稳定）。 */
const TREE_TOOLBAR_DUPLICATE_BUTTONS = [
  "新建根文件夹",
  "更多目录操作",
  "全部展开",
  "全部收起",
  "刷新内容树",
] as const;

export default function TreePanelContent({ mode }: { mode: TreePanelContentMode }) {
  return (
    <div data-sidebar-tree-content="" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* 作用域样式：仅本面板内隐藏与壳头重复的动作按钮；旧树的筛选行（输入 + 范围切换）保留可用。 */}
      <style>
        {TREE_TOOLBAR_DUPLICATE_BUTTONS.map(
          (title) => `[data-sidebar-tree-content] button[title="${title}"]{display:none}`,
        ).join("")}
      </style>
      {mode === "quick" ? (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <MobileKnowledgeTreePanel variant="desktop" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <KnowledgeTreePanel variant="desktop" />
        </div>
      )}
    </div>
  );
}
