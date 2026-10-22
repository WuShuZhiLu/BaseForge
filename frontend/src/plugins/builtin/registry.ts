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
export type BuiltinPluginId = "tasks" | "diary" | "ai" | "remote-files" | "pm";

export interface BuiltinPluginDef {
  id: BuiltinPluginId;
  name: string;
  description: string;
  version: string;
  icon: "tasks" | "diary" | "ai" | "remote-files" | "pm";
  /** 主区 viewMode（ Rail / 打开主区用） */
  viewMode: "tasks" | "diary" | "ai-chat" | "remote-files" | "projects";
  /** 主区入口所需的 WorkspaceFeatures 键 */
  workspaceFeature: "tasks" | "diaries" | "notes";
  /** 增强型插件：不占独立导航徽章，嵌入宿主视图（如文件管理的远程文件面板） */
  embedded?: boolean;
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
  {
    id: "remote-files",
    name: "远程文件",
    description: "官方 · WebDAV/百度网盘等远程文档管理（读取/编辑/写回）",
    version: "0.1.0",
    icon: "remote-files",
    embedded: true,
    viewMode: "remote-files",
    workspaceFeature: "notes",
    sidebarPanel: { id: "remote-files-panel", title: "远程文件" },
  },
  {
    id: "pm",
    name: "项目管理",
    description: "官方 · 项目/工作项（需求·任务·缺陷）看板，联动笔记与 git",
    version: "0.1.0",
    icon: "pm",
    viewMode: "projects",
    workspaceFeature: "notes",
    sidebarPanel: { id: "pm-panel", title: "项目" },
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
