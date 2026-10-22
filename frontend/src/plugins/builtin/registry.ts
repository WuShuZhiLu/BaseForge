/**
 * 官方内置插件注册表。
 *
 * 待办中心 / 每日记录以"官方内置插件"形态接入统一插件管线：
 * - contributes.sidebarPanels 侧栏迷你面板（宿主内置渲染）
 * - contributes.mainViewPanels 主区全屏中心（TaskCenter / DiaryCenter 原组件）
 * - 启停状态持久化到 localStorage；停用后侧栏/Rail 入口消失、主区不可达，数据保留。
 *
 * 与第三方插件的区别：代码在仓库内（不经 manifest 打包/沙箱），但走同一条
 * contributions 消费链路（registry → host → 面板），未来可平移为独立插件包。
 */
export type BuiltinPluginId = "tasks" | "diary" | "ai";

export interface BuiltinPluginDef {
  id: BuiltinPluginId;
  name: string;
  description: string;
  version: string;
  icon: "tasks" | "diary" | "ai";
  /** 主区 viewMode（ Rail / 打开主区用） */
  viewMode: "tasks" | "diary" | "ai-chat";
  /** 主区入口所需的 WorkspaceFeatures 键 */
  workspaceFeature: "tasks" | "diaries" | "notes";
  /** 侧栏迷你面板贡献 */
  sidebarPanel: {
    id: string;
    title: string;
  };
}

export const BUILTIN_PLUGINS: BuiltinPluginDef[] = [
  {
    id: "tasks",
    name: "待办事项",
    description: "官方 · 贡献 1 个侧栏面板与主区中心",
    version: "1.0.0",
    icon: "tasks",
    viewMode: "tasks",
    workspaceFeature: "tasks",
    sidebarPanel: { id: "tasks-panel", title: "待办" },
  },
  {
    id: "diary",
    name: "每日记录",
    description: "官方 · 贡献 1 个侧栏面板与主区中心",
    version: "1.0.0",
    icon: "diary",
    viewMode: "diary",
    workspaceFeature: "diaries",
    sidebarPanel: { id: "diary-panel", title: "日记" },
  },
  {
    id: "ai",
    name: "AI 问答",
    description: "官方 · 贡献 1 个侧栏面板与主区中心",
    version: "1.0.0",
    icon: "ai",
    viewMode: "ai-chat",
    workspaceFeature: "notes",
    sidebarPanel: { id: "ai-panel", title: "AI 问答" },
  },
];

const STORAGE_KEY = "nowen-builtin-plugins-disabled";

/** 已停用的内置插件 id 集合（启用 = 不在集合中） */
export function getDisabledBuiltinPlugins(): Set<BuiltinPluginId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    const valid = new Set(BUILTIN_PLUGINS.map((p) => p.id));
    return new Set(parsed.filter((id): id is BuiltinPluginId => valid.has(id as BuiltinPluginId)));
  } catch {
    return new Set();
  }
}

export function setBuiltinPluginDisabled(id: BuiltinPluginId, disabled: boolean): void {
  try {
    const disabledSet = getDisabledBuiltinPlugins();
    if (disabled) disabledSet.add(id);
    else disabledSet.delete(id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...disabledSet]));
    window.dispatchEvent(new CustomEvent("nowen:builtin-plugins-changed"));
  } catch {
    // storage failures are non-fatal
  }
}

export function isBuiltinPluginEnabled(id: BuiltinPluginId): boolean {
  return !getDisabledBuiltinPlugins().has(id);
}
