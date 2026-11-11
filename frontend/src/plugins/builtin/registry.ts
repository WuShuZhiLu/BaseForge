/**
 * 官方内置插件注册表。
 *
 * 待办中心以"官方内置插件"形态接入统一插件管线：
 * - contributes.sidebarPanels 侧栏迷你面板（宿主内置渲染）
 * - contributes.mainViewPanels 主区全屏中心（TaskWorkspace 原组件）
 * - 启停状态持久化到 localStorage；停用后侧栏/Rail 入口消失、主区不可达，数据保留。
 *
 * 与社区插件的区别：代码在仓库内（不经 manifest 打包/沙箱），但走同一条
 * contributions 消费链路（registry → host → 面板），未来可平移为独立插件包。
 *
 * 注意：远程文件（WebDAV / SMB / 百度网盘）是内核能力，不从属于本注册表——
 * 它是文件管理里的一个来源，没有启停开关，也不在插件工作区里出现。
 */
export type BuiltinPluginId = "tasks" | "pm";

/**
 * 内置插件来源：用于在 UI 上如实标注，而不是笼统写成"官方内置"。
 * - baseforge：沿用 baseforge note（上游）的实现，随本仓库一起发布
 * - builtin：本仓库自研的内置插件（不经市场分发，代码在仓库内）
 */
export type BuiltinPluginOrigin = "baseforge" | "builtin";

export interface BuiltinPluginDef {
  id: BuiltinPluginId;
  name: string;
  description: string;
  version: string;
  icon: "tasks" | "pm";
  /** 主区 viewMode（ Rail / 打开主区用） */
  viewMode: "tasks" | "projects";
  /** 主区入口所需的 WorkspaceFeatures 键 */
  workspaceFeature: "tasks" | "notes";
  /** 来源：baseforge = 沿用上游实现；builtin = 本仓库自研内置 */
  origin: BuiltinPluginOrigin;
  /** 首次安装时的默认启停；false 的插件需用户手动开启 */
  defaultEnabled: boolean;
  /** 启用后进入该插件的入口位置（详情页展示，避免用户找不到） */
  entryHint: string;
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
    description: "任务 / 提醒 / 统计",
    version: "1.0.0",
    icon: "tasks",
    viewMode: "tasks",
    workspaceFeature: "tasks",
    origin: "baseforge",
    defaultEnabled: false,
    entryHint: "导航栏徽章「待办」",
    sidebarPanel: { id: "tasks-panel", title: "待办" },
  },
  {
    id: "pm",
    name: "项目管理",
    description: "项目 / 工作项（需求·任务·缺陷）看板，联动笔记与 git",
    version: "0.1.0",
    icon: "pm",
    viewMode: "projects",
    workspaceFeature: "notes",
    origin: "builtin",
    defaultEnabled: false,
    entryHint: "导航栏徽章「项目」",
    sidebarPanel: { id: "pm-panel", title: "项目" },
  },
];

const STORAGE_KEY = "baseforge-builtin-plugins-disabled";

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
    window.dispatchEvent(new CustomEvent("baseforge:builtin-plugins-changed"));
  } catch {
    // storage failures are non-fatal
  }
}

export function isBuiltinPluginEnabled(id: BuiltinPluginId): boolean {
  return !getDisabledBuiltinPlugins().has(id);
}

/** 首次加载时把 defaultEnabled=false 的插件写入停用集合（只做一次，之后完全尊重用户选择）。
 *  v2：从 baseforge 继承的内置插件一律默认关闭——用户明确表示暂时不需要，重新播种一次
 *  把老 profile 里残留的启用状态也关掉。 */
const DEFAULTS_SEEDED_KEY = "baseforge-builtin-plugins-defaults-seeded-v2";

export function seedBuiltinPluginDefaults(): void {
  try {
    if (localStorage.getItem(DEFAULTS_SEEDED_KEY) === "1") return;
    const disabled = getDisabledBuiltinPlugins();
    for (const plug of BUILTIN_PLUGINS) {
      if (!plug.defaultEnabled) disabled.add(plug.id);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...disabled]));
    localStorage.setItem(DEFAULTS_SEEDED_KEY, "1");
    window.dispatchEvent(new CustomEvent("baseforge:builtin-plugins-changed"));
  } catch {
    // storage failures are non-fatal
  }
}

/** 来源徽标文案（内置插件没有"官方内置"这种含糊说法，按实际来源标注） */
export const BUILTIN_ORIGIN_LABEL: Record<BuiltinPluginOrigin, string> = {
  baseforge: "来自 baseforge note",
  builtin: "内置插件",
};

// 模块加载即播种默认启停（幂等，只在首次运行时写一次）：
// registry 被 NavRail / 侧栏 / 插件工作区共同引用，早于任何启停判断执行。
seedBuiltinPluginDefaults();
