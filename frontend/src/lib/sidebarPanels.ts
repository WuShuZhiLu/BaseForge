import { getCurrentWorkspace } from "@/lib/api";

/**
 * 侧栏面板布局 store（面板框架 S1 · **接口冻结 v1**，2026-10-16）
 *
 * 为什么单独一个文件：SidebarMobile（面板容器）与 NavRailMobile（活动栏徽章）都要读同一份布局，
 * 但两者分属两个并行开发 agent（见 .cmp/COLLAB-BOARD.md 第六节）。把状态集中在此，
 * 双方各自订阅，**互不修改对方的组件文件**，从根本上避免并行冲突。
 *
 * 双线约定：
 *  - 本文件由 A 维护；B 只调用 readSidebarLayout / updateSidebarPanel / updateSidebarBadges /
 *    subscribeSidebarLayout，不得直接改本文件（需求走 .cmp/COLLAB-QUEUE.md）。
 *  - 命名注意：`lib/sidebarLayout.ts`（既有文件）是树缩进常量，**不是**本 store，勿混。
 */

export type SidebarPanelId = "tree" | "openEditors" | "tags" | "fav" | "trash" | "files";

export const SIDEBAR_PANEL_IDS: SidebarPanelId[] = ["tree", "openEditors", "tags", "fav", "trash", "files"];

export interface SidebarPanelState {
  visible: boolean;
  collapsed: boolean;
  order: number;
}

export interface SidebarLayoutState {
  panels: Record<SidebarPanelId, SidebarPanelState>;
  badges: {
    /** 活动栏「更多」组里的扩展徽章标识（面板 id / 工具 id）。 */
    extra: string[];
    /** 「更多」组是否收起——用户 2026-10-16：除固定徽章外，其余徽章要能折叠。 */
    extraCollapsed: boolean;
  };
}

/** 默认布局：文档树固定展开；「打开的」默认折叠（让位给知识树）；其余面板默认隐藏。 */
export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayoutState = {
  panels: {
    openEditors: { visible: true, collapsed: true, order: 0 },
    tree: { visible: true, collapsed: false, order: 1 },
    tags: { visible: false, collapsed: false, order: 2 },
    fav: { visible: false, collapsed: false, order: 3 },
    trash: { visible: false, collapsed: false, order: 4 },
    files: { visible: false, collapsed: false, order: 5 },
  },
  badges: { extra: ["tasks", "diary"], extraCollapsed: true },
};

export const SIDEBAR_LAYOUT_EVENT = "nowen:sidebar-layout-changed";

const STORAGE_PREFIX = "nowen.sidebar.layout.v2";
/** v1（旧）：顺序为「文档树在上、打开的在下」——v2 起改为原型口径（打开的在上）。
 *  迁移时只保留用户的可见性/折叠偏好，**顺序一律采用新默认**，避免旧数据把顺序盖回去。 */
const LEGACY_STORAGE_PREFIX = "nowen.sidebar.layout.v1";

function legacyStorageKey(workspaceId: string | null): string {
  return `${LEGACY_STORAGE_PREFIX}:${workspaceId || "local"}`;
}

function storageKey(workspaceId: string | null): string {
  return `${STORAGE_PREFIX}:${workspaceId || "local"}`;
}

function isPanelId(value: unknown): value is SidebarPanelId {
  return typeof value === "string" && (SIDEBAR_PANEL_IDS as string[]).includes(value);
}

function cloneLayout(source: SidebarLayoutState): SidebarLayoutState {
  return {
    panels: { ...source.panels },
    badges: { extra: [...source.badges.extra], extraCollapsed: source.badges.extraCollapsed },
  };
}

function safeCurrentWorkspace(): string | null {
  try {
    return getCurrentWorkspace();
  } catch {
    return null;
  }
}

/** 读取并校验持久化布局；非法项回退默认值。 */
export function loadSidebarLayout(workspaceId: string | null): SidebarLayoutState {
  const next = cloneLayout(DEFAULT_SIDEBAR_LAYOUT);
  try {
    const raw =
      window.localStorage.getItem(storageKey(workspaceId)) ??
      window.localStorage.getItem(legacyStorageKey(workspaceId));
    if (!raw) return next;
    const parsed = JSON.parse(raw) as Partial<SidebarLayoutState>;
    if (parsed.panels && typeof parsed.panels === "object") {
      for (const id of SIDEBAR_PANEL_IDS) {
        const value = (parsed.panels as Record<string, unknown>)[id] as Partial<SidebarPanelState> | undefined;
        if (!value || typeof value !== "object") continue;
        next.panels[id] = {
          visible: typeof value.visible === "boolean" ? value.visible : next.panels[id].visible,
          collapsed: typeof value.collapsed === "boolean" ? value.collapsed : next.panels[id].collapsed,
          // 顺序不继承旧值：布局结构变更（v1→v2）后一律用新默认顺序，避免出现「文档树在上」的旧排布
          order: next.panels[id].order,
        };
      }
    }
    const badges = parsed.badges;
    if (badges && typeof badges === "object") {
      if (Array.isArray(badges.extra)) {
        next.badges.extra = badges.extra.filter((item): item is string => typeof item === "string");
      }
      if (typeof badges.extraCollapsed === "boolean") {
        next.badges.extraCollapsed = badges.extraCollapsed;
      }
    }
  } catch {
    // 存储不可用 / 数据损坏：使用默认布局
  }
  // 固定面板不可隐藏（文档树）
  next.panels.tree.visible = true;
  return next;
}

function saveSidebarLayout(workspaceId: string | null, value: SidebarLayoutState): void {
  try {
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(value));
  } catch {
    // 降级为仅本次会话有效
  }
}

let currentWorkspaceId: string | null = safeCurrentWorkspace();
let layout: SidebarLayoutState = loadSidebarLayout(currentWorkspaceId);
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
  try {
    window.dispatchEvent(new CustomEvent(SIDEBAR_LAYOUT_EVENT));
  } catch {
    // 非浏览器环境忽略
  }
}

function persist(): void {
  saveSidebarLayout(currentWorkspaceId, layout);
}

/** 读当前内存态（引用稳定；写操作才替换）。 */
export function readSidebarLayout(): SidebarLayoutState {
  return layout;
}

/** 订阅变更；返回退订函数。 */
export function subscribeSidebarLayout(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** 更新单个面板状态。固定面板（文档树）不可隐藏。 */
export function updateSidebarPanel(id: SidebarPanelId, patch: Partial<SidebarPanelState>): void {
  if (!isPanelId(id)) return;
  const current = layout.panels[id];
  const next: SidebarPanelState = {
    visible: patch.visible ?? current.visible,
    collapsed: patch.collapsed ?? current.collapsed,
    order: patch.order ?? current.order,
  };
  if (id === "tree") next.visible = true;
  if (next.visible === current.visible && next.collapsed === current.collapsed && next.order === current.order) {
    return;
  }
  layout = { ...layout, panels: { ...layout.panels, [id]: next } };
  persist();
  emit();
}

/** 拖拽排序：按新顺序列表批量写回 order。 */
export function reorderSidebarPanels(orderedIds: SidebarPanelId[]): void {
  const panels = { ...layout.panels };
  orderedIds.forEach((id, index) => {
    if (!isPanelId(id)) return;
    panels[id] = { ...panels[id], order: index };
  });
  layout = { ...layout, panels };
  persist();
  emit();
}

/** 更新徽章区（扩展徽章列表 / 「更多」折叠态）。 */
export function updateSidebarBadges(patch: Partial<SidebarLayoutState["badges"]>): void {
  const next = {
    extra: patch.extra ? [...new Set(patch.extra)] : layout.badges.extra,
    extraCollapsed: patch.extraCollapsed ?? layout.badges.extraCollapsed,
  };
  layout = { ...layout, badges: next };
  persist();
  emit();
}

/** 切换工作空间后重载布局（SidebarMobile 挂载与切空间时调用）。 */
export function reloadSidebarLayoutForWorkspace(): void {
  currentWorkspaceId = safeCurrentWorkspace();
  layout = loadSidebarLayout(currentWorkspaceId);
  emit();
}

/** 恢复默认布局（面板清单「重置布局」用）。 */
export function resetSidebarLayout(): void {
  layout = cloneLayout(DEFAULT_SIDEBAR_LAYOUT);
  persist();
  emit();
}

/** 可见面板按 order 排序后的 id 列表（渲染顺序）。 */
export function visiblePanelIdsSorted(): SidebarPanelId[] {
  return SIDEBAR_PANEL_IDS.filter((id) => layout.panels[id].visible).sort(
    (a, b) => layout.panels[a].order - layout.panels[b].order,
  );
}
