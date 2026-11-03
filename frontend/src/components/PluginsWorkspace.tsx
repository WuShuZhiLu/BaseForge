/**
 * PluginsWorkspace —— 插件模块工作区（VS Code 扩展详情式）
 *
 * 三分区模型：插件徽章 → 侧栏插件列表 + 本工作区详情页。
 * 详情源归一为三类，信息架构统一：
 * - builtin：官方内置插件（builtin registry），页内启停 + 打开面板/主区；
 * - installed：已安装社区插件（GET /plugins），管理员启停/回滚/卸载；
 * - catalog：市场目录（GET /plugins/ecosystem/catalog），管理员安装。
 * 页内 Tab 分组（管理/市场/配置）；侧栏点击内置插件 → nowen:plugin-selected 直达详情，
 * 侧栏点「市场」「管理」「配置」→ nowen:plugin-group 切到对应分组。
 *
 * 管理分组自上而下：社区插件区（列表 + 区头部的「检查更新」「安装插件包」，管理员可见）
 * → 内置插件区（默认折叠的次级分区，展开后启停）。更新与安装从属于社区插件区，
 * 不再夹在两份列表中间；
 * 配置分组（仅管理员）保留 Registry 来源、执行边界、开发者模式；单插件配置在详情页
 * 「设置与运行」分区。
 *
 * 选中状态经 nowen:plugin-selected 事件与侧栏共享（仅内置插件）；
 * 启停复用 builtin registry，变更广播 nowen:builtin-plugins-changed。
 * README/Changelog/Dependencies 区块在 Registry V2 索引提供数据前隐藏。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Download,
  ExternalLink,
  FolderOpen,
  ListTodo,
  Loader2,
  PackageOpen,
  PenLine,
  Puzzle,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAppActions } from "@/store/AppContext";
import { pluginApi, type InstalledPlugin, type PluginPermissionRow } from "@/lib/pluginApi";
import { getPluginRuntimePresentation } from "@/lib/pluginRuntimePresentation";
import { PluginConfigSections } from "@/components/plugins/PluginConfigSections";
import {
  PluginConfigPanel,
  PluginPackageInstallSection,
  PluginUpdatesResult,
  usePluginUpdateCheck,
} from "@/components/plugins/PluginAdminPanel";
import { ExternalHostList } from "@/components/plugins/ExternalHostList";
import {
  BUILTIN_ORIGIN_LABEL,
  BUILTIN_PLUGINS,
  isBuiltinPluginEnabled,
  setBuiltinPluginDisabled,
  type BuiltinPluginDef,
  type BuiltinPluginId,
} from "@/plugins/builtin/registry";

const PLUGIN_SELECTED_EVENT = "nowen:plugin-selected";
/** 侧栏插件视图点「市场」→ 工作区切到对应分组 */
const PLUGIN_GROUP_EVENT = "nowen:plugin-group";
const BUILTIN_CHANGED_EVENT = "nowen:builtin-plugins-changed";
/** 市场目录默认源（Registry V2 官方源） */
const MARKET_SOURCE_ID = "official-v2";

type DetailSource = "builtin" | "installed" | "catalog";
/** 配置分组不对应任何可选中对象，只承载全局配置能力（Registry 来源/执行边界/开发者模式） */
type GroupKey = DetailSource | "config";
type CatalogExtension = Awaited<ReturnType<typeof pluginApi.registryCatalog>>[number];

/** 与详情页共用的一份权限中文名（工作区的权限分区不再单独维护） */
const PERMISSION_LABELS: Record<string, string> = {
  "notes:read": "读取笔记", "notes:write": "创建和修改笔记",
  "notebooks:read": "读取笔记本", "notebooks:write": "创建和修改笔记本",
  "tags:read": "读取标签", "tags:write": "创建和修改标签",
  "tasks:read": "读取任务", "tasks:write": "创建和修改任务",
  "attachments:read": "读取附件信息", "attachments:write": "创建和修改附件",
  "plugin-storage:read": "读取插件自己的数据", "plugin-storage:write": "保存插件自己的数据",
  "capture:write": "抓取公网 HTTPS 文章和图片，保存到有写入权限的笔记本",
  "external:fetch": "访问声明的外部网络服务", "secrets:use": "使用你配置的连接密钥（插件看不到原值）",
  "diary:read": "读取日记", "diary:write": "创建和修改日记",
  "mindmaps:read": "读取思维导图", "mindmaps:write": "创建和修改思维导图",
};

const INSTALLED_STATUS_LABELS: Record<InstalledPlugin["status"], string> = {
  quarantined: "待确认", disabled: "已禁用", enabled: "已启用", error: "运行错误", incompatible: "不兼容",
};

const GROUP_TABS: Array<[GroupKey, string]> = [
  ["installed", "管理"],
  ["catalog", "市场"],
  ["config", "配置"],
];

/** 头部行标题：分组即当前范围，与分享中心「头部行 = 当前分类」同一读法 */
const GROUP_TITLES: Record<GroupKey, string> = {
  installed: "插件",
  catalog: "插件市场",
  config: "插件配置",
  builtin: "插件",
};

type InstalledFilter = "all" | "enabled" | "disabled";
type InstalledSort = "recent" | "name";
type CatalogSort = "recent" | "name";

const INSTALLED_FILTER_CHIPS: Array<{ value: InstalledFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "enabled", label: "已启用" },
  { value: "disabled", label: "已停用" },
];

const INSTALLED_SORT_OPTIONS: Array<{ value: InstalledSort; label: string }> = [
  { value: "recent", label: "最近更新" },
  { value: "name", label: "名称 A-Z" },
];

const CATALOG_SORT_OPTIONS: Array<{ value: CatalogSort; label: string }> = [
  { value: "recent", label: "最近发布" },
  { value: "name", label: "名称 A-Z" },
];

/** 「最近更新」取最新版本的安装时间；缺失时排到最后，而不是让空串混进比较 */
function installedUpdatedAt(plugin: InstalledPlugin): string {
  return plugin.versions?.[0]?.installedAt || "";
}

function iconFor(plug: BuiltinPluginDef, size: number) {
  switch (plug.icon) {
    case "tasks": return <ListTodo size={size} className="text-violet-500" />;
    case "diary": return <PenLine size={size} className="text-amber-500" />;
    case "ai": return <Sparkles size={size} className="text-accent-primary" />;
    case "remote-files": return <FolderOpen size={size} className="text-cyan-500" />;
    case "pm": return <ClipboardList size={size} className="text-emerald-500" />;
    default: return <Puzzle size={size} className="text-tx-tertiary" />;
  }
}

function sortVersionsDesc<T extends { version: string }>(versions: T[]): T[] {
  return [...versions].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

function formatDay(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] || permission;
}

/** 权限行归一：列表只关心"名字 / 是否已授予 / 附带的外网域名" */
type PermissionItem = { permission: string; granted: boolean; hosts?: string[] };

/**
 * 取 external:fetch 的域名白名单。
 * 后端 PermissionView 已把 manifest.permissionConfig.externalFetchHosts 解析成权限行的 hosts
 * （backend/src/plugins/permissions.ts）；旧响应没有 hosts 时回退解析 configJson.hosts。
 */
function permissionHosts(row: PluginPermissionRow): string[] {
  if (row.permission !== "external:fetch") return [];
  const isHostList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (isHostList(row.hosts)) return row.hosts;
  try {
    const parsed = JSON.parse(row.configJson || "{}") as { hosts?: unknown };
    return isHostList(parsed.hosts) ? parsed.hosts : [];
  } catch {
    return [];
  }
}

function Badge({ tone = "neutral", children }: { tone?: "ok" | "warn" | "bad" | "info" | "neutral"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px]",
        tone === "ok" && "bg-emerald-500/15 text-emerald-600",
        tone === "warn" && "bg-amber-500/15 text-amber-600",
        tone === "bad" && "bg-red-500/15 text-red-600",
        tone === "info" && "bg-indigo-500/15 text-indigo-600",
        tone === "neutral" && "bg-app-hover text-tx-secondary",
      )}
    >
      {children}
    </span>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-3 rounded-[10px] border border-app-border bg-app-surface p-4">
      <h3 className="text-[12.5px] font-semibold text-tx-primary">{title}</h3>
      {children}
    </section>
  );
}

/** 工具条行：与分享中心同一规格（h-10 + 底边线，左搜索框 + 中 chips + 右排序） */
function ToolbarRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-app-border px-4 text-xs text-tx-secondary">
      {children}
    </div>
  );
}

/** 搜索框：尺寸照分享中心，左置 14px 线性图标 */
function ToolbarSearch({ label, value, placeholder, onChange }: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative block w-[210px] shrink-0">
      <Search size={14} className="pointer-events-none absolute left-2.5 top-2 text-tx-tertiary" />
      <Input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8 text-xs"
      />
    </label>
  );
}

/** 快捷筛选 chips：11px 圆角胶囊，选中 accent/10 + accent 文字 */
function FilterChips<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-full border px-2.5 py-[3px] text-[11px] transition-colors",
            value === option.value
              ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary dark:border-accent-primary/40 dark:bg-accent-primary/15"
              : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 排序下拉：与分享中心的「排序：xxx ▾」同一交互与尺寸 */
function SortMenu({ value, options, onChange }: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-bg px-2 py-1 text-[11px] text-tx-secondary transition-colors hover:bg-app-hover"
      >
        排序：<span className="font-medium text-tx-primary">{options.find((option) => option.value === value)?.label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div role="listbox" className="absolute right-0 z-40 mt-1 w-32 overflow-hidden rounded-lg border border-app-border bg-app-elevated py-1 shadow-xl">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={value === option.value}
              onClick={() => { onChange(option.value); setOpen(false); }}
              className={cn(
                "flex w-full items-center px-2.5 py-1 text-left text-[11px] hover:bg-app-hover",
                value === option.value ? "text-accent-primary" : "text-tx-secondary",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 列表容器：一块 surface + 1px 描边，行之间用细线分隔；空态时容器本身是虚线框 */
function ListPanel({ empty, children }: { empty?: boolean; children: React.ReactNode }) {
  return (
    <div
      data-plugin-list-panel
      className={cn(
        "overflow-hidden rounded-[10px] border bg-app-surface",
        empty ? "border-dashed border-app-border" : "border-app-border",
      )}
    >
      {children}
    </div>
  );
}

const STATUS_DOT: Record<"ok" | "warn" | "bad" | "neutral", string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  neutral: "bg-tx-tertiary/50",
};

/** 统一行：图标 + 名称/次级信息 +（常驻控件）+（hover 操作） */
function PluginRow({ rowId, icon, name, meta, state, controls, hoverActions, onOpen }: {
  rowId: string;
  icon: React.ReactNode;
  name: string;
  meta: string;
  state?: { label: string; tone: "ok" | "warn" | "bad" | "neutral" };
  controls?: React.ReactNode;
  hoverActions?: React.ReactNode;
  onOpen?: () => void;
}) {
  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      data-plugin-row={rowId}
      onClick={onOpen}
      onKeyDown={onOpen
        ? (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }
        : undefined}
      className={cn(
        "group flex min-h-[44px] items-center gap-2.5 border-b border-app-border/60 px-3 py-1.5 outline-none transition-colors last:border-b-0",
        onOpen ? "cursor-pointer hover:bg-app-hover focus-visible:bg-app-hover" : "hover:bg-app-hover",
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-app-border bg-app-bg">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] text-tx-primary">{name}</span>
          {state && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-tx-tertiary">
              <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[state.tone])} />
              {state.label}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-tx-tertiary">{meta}</span>
      </span>
      {hoverActions && (
        <span
          className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex"
          onClick={(event) => event.stopPropagation()}
        >
          {hoverActions}
        </span>
      )}
      {controls}
      {onOpen && <ChevronRight size={13} className="shrink-0 text-tx-tertiary" />}
    </div>
  );
}

/** 启停开关：与侧栏设置项同一套 17×30 胶囊规格 */
function RowSwitch({ checked, label, disabled, onToggle }: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => { event.stopPropagation(); onToggle(); }}
      className={cn(
        "relative h-[17px] w-[30px] shrink-0 rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-accent-primary" : "bg-app-border",
      )}
    >
      <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all", checked ? "left-[15px]" : "left-0.5")} />
    </button>
  );
}

/** 空态：虚线容器内的中性内容（32px 线性图标 + 13px 主文案 + 11px 说明），入口用 chips 样式 */
function EmptyPanel({ icon, title, description, action }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <span className="text-tx-tertiary">{icon}</span>
      <p className="mt-2.5 text-[13px] text-tx-primary">{title}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-tx-tertiary">{description}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

function DetailHeader({ icon, name, uniqueId, version, badges, description }: {
  icon: React.ReactNode;
  name: string;
  uniqueId: string;
  version: string;
  badges: React.ReactNode;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-app-border bg-app-surface">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-[14px] font-semibold text-tx-primary">{name}</h2>
          {badges}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-tx-tertiary">{uniqueId}</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-tx-secondary">{description}</p>
        <p className="mt-1 text-[11px] text-tx-tertiary">v{version}</p>
      </div>
    </div>
  );
}

function OverviewSection({ description, repository, homepage, license, publishedAt }: {
  description: string;
  repository?: string;
  homepage?: string;
  license?: string;
  publishedAt?: string;
}) {
  const links: Array<[string, string]> = [];
  if (repository) links.push(["仓库", repository]);
  if (homepage) links.push(["主页", homepage]);
  if (license) links.push(["许可证", license]);
  return (
    <SectionCard title="概述">
      <p className="mt-1 text-[11.5px] leading-relaxed text-tx-secondary">{description || "暂无说明"}</p>
      {(links.length > 0 || publishedAt) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-tx-tertiary">
          {links.map(([label, href]) => (
            <a key={label} href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-primary hover:underline">
              {label}<ExternalLink size={11} />
            </a>
          ))}
          {publishedAt && <span>发布于 {formatDay(publishedAt)}</span>}
        </div>
      )}
    </SectionCard>
  );
}

function PermissionList({ items, emptyText }: { items: PermissionItem[]; emptyText: string }) {
  if (!items.length) return <p className="mt-2 text-xs text-tx-tertiary">{emptyText}</p>;
  return (
    <ul className="mt-2 space-y-1">
      {items.map((item) => (
        <li key={item.permission}>
          <div className="flex items-baseline gap-2 text-xs text-tx-secondary">
            <ShieldCheck size={12} className={cn("mt-0.5 shrink-0", item.granted ? "text-emerald-500" : "text-amber-500")} />
            <span>{permissionLabel(item.permission)}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-tx-tertiary">{item.permission}</span>
          </div>
          {/* external:fetch 直接列出会访问的外部域名，缺数据时只显示上面的权限名 */}
          {item.hosts && item.hosts.length > 0 && <ExternalHostList hosts={item.hosts} />}
        </li>
      ))}
    </ul>
  );
}

function VersionHistory({ versions, current }: { versions: Array<{ version: string; date?: string; note?: string }>; current: string }) {
  if (!versions.length) return null;
  return (
    <SectionCard title="版本历史">
      <ul className="mt-2 space-y-1">
        {versions.map((item) => (
          <li
            key={item.version}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1 text-xs",
              item.version === current ? "bg-indigo-500/10 text-indigo-600" : "text-tx-secondary",
            )}
          >
            <span className="font-mono">v{item.version}</span>
            {item.date && <span className="text-tx-tertiary">{formatDay(item.date)}</span>}
            {item.note && <span className="truncate text-tx-tertiary">{item.note}</span>}
            {item.version === current && <span className="ml-auto text-[10px]">当前版本</span>}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function BuiltinDetail({ plug }: { plug: BuiltinPluginDef }) {
  const actions = useAppActions();
  const enabled = isBuiltinPluginEnabled(plug.id);

  const toggleEnabled = () => {
    setBuiltinPluginDisabled(plug.id, enabled);
    window.dispatchEvent(new CustomEvent(BUILTIN_CHANGED_EVENT));
  };

  return (
    <div>
      <DetailHeader
        icon={iconFor(plug, 22)}
        name={plug.name}
        uniqueId={`内置插件 · ${plug.id}`}
        version={plug.version}
        description={plug.description}
        badges={
          <>
            <Badge tone="info">{BUILTIN_ORIGIN_LABEL[plug.origin]}</Badge>
            <Badge tone={enabled ? "ok" : "neutral"}>{enabled ? "已启用" : "已停用"}</Badge>
          </>
        }
      />
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggleEnabled}
          className={cn(
            "rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
            enabled
              ? "border border-app-border bg-app-surface text-tx-primary hover:bg-app-hover"
              : "bg-accent-primary text-white hover:opacity-90",
          )}
        >
          {enabled ? "停用" : "启用"}
        </button>
        {enabled && (
          <span className="text-xs text-tx-tertiary">
            入口：{plug.entryHint}
          </span>
        )}
      </div>
      <SectionCard title="功能与贡献">
        <ul className="mt-2 space-y-1 text-xs text-tx-secondary">
          <li>· 侧栏迷你面板：{plug.sidebarPanel.title}（知识库视图内嵌）</li>
          <li>· 主区视图：{plug.embedded ? "无（嵌入文件管理）" : plug.viewMode}</li>
          <li>· 停用后入口消失，数据始终保留</li>
        </ul>
      </SectionCard>
    </div>
  );
}

/** 已安装插件的功能贡献归一列表：commands/settings/menus/automationTemplates/noteTemplates/promptPacks/noteThemes/uiComponents */
function installedContributionGroups(plugin: InstalledPlugin): Array<[string, string[]]> {
  const c = plugin.contributes || {};
  const groups: Array<[string, string[]]> = [
    ["命令", (c.commands || []).map((item) => item.title || item.id)],
    ["设置项", (c.settings || []).map((item) => item.title || item.key)],
    ["菜单", (c.menus || []).map((item) => `${item.location} → ${item.command}`)],
    ["Automation 模板", (c.automationTemplates || []).map((item) => item.title || item.id)],
    ["笔记模板", (c.noteTemplates || []).map((item) => item.name || item.id)],
    ["提示词包", (c.promptPacks || []).map((item) => item.name || item.id)],
    ["笔记主题", (c.noteThemes || []).map((item) => item.name || item.id)],
    ["UI 组件", (c.uiComponents || []).map((item) => item.label || item.id)],
  ];
  return groups.filter(([, items]) => items.length > 0);
}

function InstalledDetail({ plugin, isAdmin, busy, actionError, onToggle, onRollback, onUninstall, onChanged }: {
  plugin: InstalledPlugin;
  isAdmin: boolean;
  busy: boolean;
  actionError: string;
  onToggle: (plugin: InstalledPlugin) => void;
  onRollback: (plugin: InstalledPlugin) => void;
  onUninstall: (plugin: InstalledPlugin) => void;
  onChanged: () => Promise<void>;
}) {
  const presentation = getPluginRuntimePresentation(plugin);
  const groups = installedContributionGroups(plugin);
  const currentVersion = plugin.versions?.find((item) => item.version === plugin.version);
  return (
    <div>
      <DetailHeader
        icon={<Puzzle size={22} className="text-tx-tertiary" />}
        name={plugin.name}
        uniqueId={plugin.id}
        version={plugin.version}
        description={plugin.description}
        badges={
          <>
            <Badge tone={plugin.status === "enabled" ? "ok" : plugin.status === "error" ? "bad" : "warn"}>
              {INSTALLED_STATUS_LABELS[plugin.status]}
            </Badge>
            <Badge tone="neutral">{plugin.trustLevel}</Badge>
            {plugin.signatureState === "verified" && <Badge tone="ok">签名已验证</Badge>}
            <Badge tone="neutral">{presentation.runtimeLabel} · {presentation.executionLabel}</Badge>
          </>
        }
      />
      {(plugin.repository || plugin.homepage || plugin.license || currentVersion?.installedAt) && (
        <OverviewSection
          description={plugin.description}
          repository={plugin.repository}
          homepage={plugin.homepage}
          license={plugin.license}
          publishedAt={currentVersion?.installedAt}
        />
      )}
      <SectionCard title="功能与贡献">
        {groups.length ? (
          <ul className="mt-2 space-y-2 text-xs text-tx-secondary">
            {groups.map(([label, items]) => (
              <li key={label}>
                <span className="font-medium text-tx-primary">{label}（{items.length}）</span>
                <span className="ml-2">{items.join("、")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-tx-tertiary">未声明功能贡献</p>
        )}
      </SectionCard>
      <SectionCard title="权限">
        <PermissionList
          items={plugin.permissions.map((row) => ({
            permission: row.permission,
            granted: Boolean(row.granted),
            hosts: permissionHosts(row),
          }))}
          emptyText={presentation.declarative ? "零数据权限（Manifest 安装阶段强制）" : "不请求数据权限"}
        />
      </SectionCard>
      {/* 插件自有设置项 / 连接密钥 / Actions 试跑 / Inbound / 执行记录：
          原先在 设置 → 插件 的卡片里，现在就在这里配 */}
      <SectionCard title="设置与运行">
        <div className="mt-3">
          <PluginConfigSections plugin={plugin} onChanged={onChanged} />
        </div>
      </SectionCard>
      <VersionHistory
        versions={(plugin.versions || []).map((item) => ({ version: item.version, date: item.installedAt, note: item.trustLevel }))}
        current={plugin.version}
      />
      <SectionCard title="操作">
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <>
              {plugin.status === "enabled" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onToggle(plugin)}
                  className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11.5px] text-tx-primary transition-colors hover:bg-app-hover disabled:opacity-50"
                >
                  禁用
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onToggle(plugin)}
                  className="rounded-md bg-accent-primary px-2.5 py-1 text-[11.5px] text-white transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {presentation.enableLabel}
                </button>
              )}
              {plugin.previousVersion && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRollback(plugin)}
                  className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11.5px] text-tx-primary transition-colors hover:bg-app-hover disabled:opacity-50"
                >
                  <RotateCcw size={13} />回滚到 v{plugin.previousVersion}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => onUninstall(plugin)}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2.5 py-1 text-[11.5px] text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50"
              >
                <Trash2 size={13} />卸载
              </button>
            </>
          ) : (
            <p className="text-xs text-tx-tertiary">启停 / 回滚 / 卸载为管理员操作。</p>
          )}
        </div>
        {actionError && <p role="alert" className="mt-2 text-xs text-red-600">{actionError}</p>}
      </SectionCard>
    </div>
  );
}

function CatalogDetail({ extension, isAdmin, nodeRuntimeAllowed, busy, actionError, onInstall }: {
  extension: CatalogExtension;
  isAdmin: boolean;
  nodeRuntimeAllowed: boolean | null;
  busy: boolean;
  actionError: string;
  onInstall: (extension: CatalogExtension) => void;
}) {
  const latest = sortVersionsDesc(extension.versions)[0];
  // 与插件市场的安装门槛一致：Node Runtime 插件需管理员先在「配置」分组放行
  const needsPolicy = extension.runtime === "node-action" && nodeRuntimeAllowed !== true;
  const permissions = latest?.permissions || [];
  // 市场索引里的外网白名单在版本级 permissionConfig（后端 ecosystemRegistry 原样透传）
  const externalHosts = latest?.permissionConfig?.externalFetchHosts || [];
  return (
    <div>
      <DetailHeader
        icon={<Puzzle size={22} className="text-tx-tertiary" />}
        name={extension.name}
        uniqueId={extension.id}
        version={extension.latestVersion}
        description={extension.description || "暂无说明"}
        badges={
          <>
            <Badge tone="info">市场</Badge>
            <Badge tone="neutral">{extension.trustLevel || "community"}</Badge>
            {latest?.runtime && <Badge tone="neutral">{latest.runtime}</Badge>}
          </>
        }
      />
      {(extension.repository || latest?.publishedAt) && (
        <OverviewSection
          description={extension.description || ""}
          repository={extension.repository}
          publishedAt={latest?.publishedAt}
        />
      )}
      {permissions.length > 0 && (
        <SectionCard title="权限">
          <PermissionList
            items={permissions.map((permission) => ({
              permission,
              granted: true,
              hosts: permission === "external:fetch" ? externalHosts : [],
            }))}
            emptyText="不请求数据权限"
          />
        </SectionCard>
      )}
      <VersionHistory
        versions={sortVersionsDesc(extension.versions).map((item) => ({ version: item.version, date: item.publishedAt }))}
        current={extension.latestVersion}
      />
      <SectionCard title="操作">
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <button
              type="button"
              disabled={busy || needsPolicy}
              onClick={() => onInstall(extension)}
              className="inline-flex items-center gap-1 rounded-md bg-accent-primary px-2.5 py-1 text-[11.5px] text-white transition-colors hover:opacity-90 disabled:opacity-50"
            >
              <Download size={13} />{busy ? "正在安装" : "安装"}
            </button>
          ) : (
            <p className="text-xs text-tx-tertiary">安装为管理员操作。</p>
          )}
          {isAdmin && needsPolicy && (
            <p className="text-xs text-amber-600">
              {nodeRuntimeAllowed === null ? "正在读取 Runtime 策略" : "此插件需要 Node Runtime，请先到本页「配置」分组放行"}
            </p>
          )}
        </div>
        {actionError && <p role="alert" className="mt-2 text-xs text-red-600">{actionError}</p>}
      </SectionCard>
    </div>
  );
}

export default function PluginsWorkspace() {
  // /plugins 语义上默认进列表；选中态只由显式事件（侧栏点击 / 行点击）设置，不持久化
  const [selectedId, setSelectedId] = useState<BuiltinPluginId | null>(null);
  // 页内分组 Tab + 非内置插件选中态（不持久化；侧栏仅联动内置插件）
  const [group, setGroup] = useState<GroupKey>("installed");
  const [installedSelection, setInstalledSelection] = useState<string | null>(null);
  const [catalogSelection, setCatalogSelection] = useState<string | null>(null);
  // 启停状态变化时重渲染（本组件与侧栏都可改）
  const [version, setVersion] = useState(0);
  // 已安装 / 市场数据（null = 尚未加载）
  const [installed, setInstalled] = useState<InstalledPlugin[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogExtension[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [nodeRuntimeAllowed, setNodeRuntimeAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  // 内置插件为次级分区：默认折叠，点分区头展开
  const [builtinExpanded, setBuiltinExpanded] = useState(false);
  // 工具条：搜索 / 状态筛选 / 排序全部在前端做，只过滤已拉到的列表
  const [installedQuery, setInstalledQuery] = useState("");
  const [installedFilter, setInstalledFilter] = useState<InstalledFilter>("all");
  const [installedSort, setInstalledSort] = useState<InstalledSort>("recent");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogSort, setCatalogSort] = useState<CatalogSort>("recent");
  // 「检查更新」状态上提：触发按钮在头部行，结果区展示在列表上方（仅管理员）
  const { updates, updateSource, setUpdateSource, checking, check: checkUpdates } = usePluginUpdateCheck();

  const refreshInstalled = useCallback(async () => {
    try {
      setInstalled(await pluginApi.list());
    } catch {
      setInstalled([]);
    }
  }, []);

  /** 分组切换统一出口：主区自己换分组（如安装后跳已安装）时也广播出去，侧栏分类跟着高亮。
   *  自派事件带 source:"workspace"，onGroup 收到时不回清选中态（选中已由调用方显式管理）。 */
  const goGroup = useCallback((next: GroupKey) => {
    setGroup(next);
    window.dispatchEvent(new CustomEvent(PLUGIN_GROUP_EVENT, { detail: { group: next, source: "workspace" } }));
  }, []);

  useEffect(() => {
    const onSelect = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      if (BUILTIN_PLUGINS.some((p) => p.id === id)) {
        setSelectedId(id as BuiltinPluginId);
        setInstalledSelection(null);
        goGroup("installed");
        return;
      }
      // 社区插件：侧栏行点击 → 切到已安装分组并选中同一插件
      setInstalledSelection(id);
      goGroup("installed");
    };
    // 侧栏插件视图的「市场」分类 → 切到本页的市场分组；外部切分组即回列表态，
    // 否则详情页还挂着，看起来像点击没反应。主区自派的分组事件不动选中态。
    const onGroup = (event: Event) => {
      const detail = (event as CustomEvent<{ group?: GroupKey; source?: string }>).detail;
      const next = detail?.group;
      if (!next || !GROUP_TABS.some(([key]) => key === next)) return;
      setGroup(next);
      if (detail?.source === "workspace") return;
      setSelectedId(null);
      setInstalledSelection(null);
      setCatalogSelection(null);
      setActionError("");
    };
    const onChanged = () => setVersion((v) => v + 1);
    window.addEventListener(PLUGIN_SELECTED_EVENT, onSelect);
    window.addEventListener(PLUGIN_GROUP_EVENT, onGroup);
    window.addEventListener(BUILTIN_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(PLUGIN_SELECTED_EVENT, onSelect);
      window.removeEventListener(PLUGIN_GROUP_EVENT, onGroup);
      window.removeEventListener(BUILTIN_CHANGED_EVENT, onChanged);
    };
  }, [goGroup]);

  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((user) => { if (!cancelled) setIsAdmin((user as { role?: string })?.role === "admin"); })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    void refreshInstalled();
    return () => { cancelled = true; };
  }, [refreshInstalled]);

  // 市场目录懒加载：首次切到市场 Tab 时拉取；管理员同时读取 Runtime 策略（安装门槛用）
  useEffect(() => {
    if (group !== "catalog") return;
    if (isAdmin) {
      pluginApi.getRuntimePolicy()
        .then((policy) => setNodeRuntimeAllowed(policy.allowNodeRuntime))
        .catch(() => setNodeRuntimeAllowed(false));
    }
    if (catalog !== null || catalogLoading || catalogError) return;
    setCatalogLoading(true);
    pluginApi.registryCatalog(MARKET_SOURCE_ID)
      .then((extensions) => { setCatalog(extensions); setCatalogError(""); })
      .catch((error) => setCatalogError(error instanceof Error ? error.message : String(error)))
      .finally(() => setCatalogLoading(false));
  }, [group, isAdmin, catalog, catalogLoading, catalogError]);

  const plug = selectedId ? BUILTIN_PLUGINS.find((p) => p.id === selectedId) ?? null : null;
  const installedPlug = group === "installed" && installedSelection && installed
    ? installed.find((p) => p.id === installedSelection) ?? null
    : null;
  const marketExt = group === "catalog" && catalogSelection && catalog
    ? catalog.find((e) => e.id === catalogSelection) ?? null
    : null;
  const detail = group === "catalog" && marketExt ? { source: "catalog" as const, ext: marketExt }
    : group === "installed" && installedPlug ? { source: "installed" as const, plug: installedPlug }
      : plug ? { source: "builtin" as const, plug }
        : null;

  const selectBuiltin = (id: BuiltinPluginId) => {
    setSelectedId(id);
    setInstalledSelection(null);
    goGroup("installed");
  };

  /** 头部徽标 = 该分组的对象总数（管理=已装社区插件数，市场=目录条目数，配置无计数） */
  const headerCount = group === "installed"
    ? (installed === null ? null : installed.length)
    : group === "catalog"
      ? (catalog === null ? null : catalog.length)
      : null;

  /** 工具条只做前端过滤 / 排序：数据来源与启停事件都不变 */
  const installedRows = useMemo(() => {
    const keyword = installedQuery.trim().toLowerCase();
    const rows = (installed || []).filter((plugin) => {
      if (installedFilter === "enabled" && plugin.status !== "enabled") return false;
      if (installedFilter === "disabled" && plugin.status === "enabled") return false;
      if (!keyword) return true;
      return plugin.name.toLowerCase().includes(keyword) || plugin.id.toLowerCase().includes(keyword);
    });
    return [...rows].sort((a, b) => {
      if (installedSort === "name") return a.name.localeCompare(b.name, "zh-Hans");
      const left = installedUpdatedAt(a);
      const right = installedUpdatedAt(b);
      if (left === right) return a.name.localeCompare(b.name, "zh-Hans");
      return right.localeCompare(left);
    });
  }, [installed, installedFilter, installedQuery, installedSort]);

  const catalogRows = useMemo(() => {
    const keyword = catalogQuery.trim().toLowerCase();
    const rows = (catalog || []).filter((extension) => {
      if (!keyword) return true;
      return extension.name.toLowerCase().includes(keyword) || extension.id.toLowerCase().includes(keyword);
    });
    return [...rows].sort((a, b) => {
      if (catalogSort === "name") return a.name.localeCompare(b.name, "zh-Hans");
      const left = sortVersionsDesc(a.versions)[0]?.publishedAt || "";
      const right = sortVersionsDesc(b.versions)[0]?.publishedAt || "";
      if (left === right) return a.name.localeCompare(b.name, "zh-Hans");
      return right.localeCompare(left);
    });
  }, [catalog, catalogQuery, catalogSort]);

  const clearActionState = () => {
    setActionError("");
    setVersion((v) => v + 1);
  };

  const runInstalledAction = async (plugin: InstalledPlugin, operation: () => Promise<unknown>) => {
    setBusy(true);
    setActionError("");
    try {
      await operation();
      await refreshInstalled();
      clearActionState();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleInstalled = (plugin: InstalledPlugin) => {
    const presentation = getPluginRuntimePresentation(plugin);
    if (plugin.status === "enabled") {
      void runInstalledAction(plugin, () => pluginApi.disable(plugin.id));
      return;
    }
    // 与设置页一致：启用前先授予声明的全部权限（可执行插件需权限确认）
    void runInstalledAction(plugin, async () => {
      if (presentation.requiresPermissionConfirmation) {
        await pluginApi.grant(plugin.id, plugin.permissions.map((item) => item.permission));
      }
      await pluginApi.enable(plugin.id);
    });
  };

  const rollbackInstalled = (plugin: InstalledPlugin) => {
    if (!window.confirm(`回滚到 ${plugin.previousVersion}？插件数据不会回滚。`)) return;
    void runInstalledAction(plugin, () => pluginApi.rollback(plugin.id, plugin.previousVersion || undefined));
  };

  const uninstallInstalled = (plugin: InstalledPlugin) => {
    if (!window.confirm(`确定卸载 ${plugin.name}？`)) return;
    void runInstalledAction(plugin, async () => {
      await pluginApi.uninstall(plugin.id);
      if (installedSelection === plugin.id) setInstalledSelection(null);
    });
  };

  const installCatalog = (extension: CatalogExtension) => {
    setBusy(true);
    setActionError("");
    pluginApi.installFromRegistry(MARKET_SOURCE_ID, extension.id, extension.latestVersion)
      .then(async (result) => {
        await refreshInstalled();
        setInstalledSelection(result.plugin.id);
        goGroup("installed");
        clearActionState();
      })
      .catch((error) => setActionError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  const backToList = () => {
    setSelectedId(null);
    if (group === "installed") setInstalledSelection(null);
    if (group === "catalog") setCatalogSelection(null);
    clearActionState();
  };

  /** 分组导航在侧栏插件视图（管理/市场/配置），主区只跟事件跑，不再重复一排 tab。 */
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-app-bg">
      {/* ① 头部行：照分享中心（h-12 + 18px 图标 + 15px/600 标题 + 计数徽标 + 右侧次/主按钮），
          分组标题不再单独占一层 */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-app-border px-4">
        <h1 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-tx-primary">
          <Puzzle size={18} className="shrink-0 text-accent-primary" />
          <span className="truncate">{GROUP_TITLES[group]}</span>
          {headerCount !== null && (
            <span className="shrink-0 rounded-full border border-app-border px-2 py-0.5 text-[11px] font-normal tabular-nums text-tx-tertiary">
              {headerCount} 个
            </span>
          )}
        </h1>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {detail ? (
            <Button size="sm" variant="outline" onClick={backToList}>
              <ArrowLeft size={14} className="mr-1" />返回列表
            </Button>
          ) : group === "installed" && isAdmin ? (
            <>
              <PluginPackageInstallSection
                onInstalled={async () => {
                  await refreshInstalled();
                  goGroup("installed");
                  clearActionState();
                }}
              />
              <Button size="sm" disabled={checking} onClick={() => void checkUpdates()}>
                <RotateCcw size={14} className={cn("mr-1", checking && "animate-spin")} />
                {checking ? "检查中…" : "检查更新"}
              </Button>
            </>
          ) : null}
        </div>
      </header>

      {/* ② 工具条行：搜索 + 状态 chips + 排序（配置分组没有列表，不出工具条） */}
      {!detail && group !== "config" && (
        <ToolbarRow>
          {group === "installed" ? (
            <>
              <ToolbarSearch
                label="搜索已安装插件"
                value={installedQuery}
                placeholder="搜索插件名称 / ID"
                onChange={setInstalledQuery}
              />
              <FilterChips value={installedFilter} options={INSTALLED_FILTER_CHIPS} onChange={setInstalledFilter} />
              <SortMenu value={installedSort} options={INSTALLED_SORT_OPTIONS} onChange={(value) => setInstalledSort(value as InstalledSort)} />
            </>
          ) : (
            <>
              <ToolbarSearch
                label="搜索市场插件"
                value={catalogQuery}
                placeholder="搜索插件名称 / ID"
                onChange={setCatalogQuery}
              />
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 truncate text-[11px] text-tx-tertiary">
                公开 Registry 上的社区插件，安装后进入「管理」
              </span>
              <SortMenu value={catalogSort} options={CATALOG_SORT_OPTIONS} onChange={(value) => setCatalogSort(value as CatalogSort)} />
            </>
          )}
        </ToolbarRow>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-app-bg">
      <div className="w-full px-4 py-3">
        {detail?.source === "builtin" && <div key={`${detail.plug.id}-${version}`}><BuiltinDetail plug={detail.plug} /></div>}
        {detail?.source === "installed" && (
          <div className="mt-4">
            <InstalledDetail
              plugin={detail.plug}
              isAdmin={isAdmin}
              busy={busy}
              actionError={actionError}
              onToggle={toggleInstalled}
              onRollback={rollbackInstalled}
              onUninstall={uninstallInstalled}
              onChanged={refreshInstalled}
            />
          </div>
        )}
        {detail?.source === "catalog" && (
          <div className="mt-4">
            <CatalogDetail
              extension={detail.ext}
              isAdmin={isAdmin}
              nodeRuntimeAllowed={nodeRuntimeAllowed}
              busy={busy}
              actionError={actionError}
              onInstall={installCatalog}
            />
          </div>
        )}

        {!detail && (
          <div className="pb-2">
            {/* 检查更新结果：头部触发、列表上方展示，可改更新源后再次点「检查更新」 */}
            {group === "installed" && isAdmin && updates !== null && (
              <div className="mb-2.5">
                <PluginUpdatesResult updates={updates} updateSource={updateSource} onSourceChange={setUpdateSource} />
              </div>
            )}

            {group === "config" && (
              <PluginConfigPanel
                isAdmin={isAdmin}
                onInstalled={async () => {
                  await refreshInstalled();
                  goGroup("installed");
                  clearActionState();
                }}
              />
            )}

            {group === "installed" && (
              installed === null ? (
                <div className="flex items-center gap-2 py-8 text-[12px] text-tx-tertiary"><Loader2 size={14} className="animate-spin" />正在加载社区插件</div>
              ) : (
                /* ③ 内容容器：社区插件行与内置插件分区同在一个面板里，行之间只用细线分隔 */
                <ListPanel empty={installed.length === 0}>
                  {installed.length === 0 ? (
                    <EmptyPanel
                      icon={<PackageOpen size={32} />}
                      title="尚未安装社区插件"
                      description="到市场浏览公开 Registry，安装后会出现在这里"
                      action={(
                        <button
                          type="button"
                          onClick={() => goGroup("catalog")}
                          className="rounded-full border border-app-border bg-app-bg px-2.5 py-[3px] text-[11px] text-tx-secondary transition-colors hover:bg-app-hover"
                        >
                          去市场看看
                        </button>
                      )}
                    />
                  ) : installedRows.length === 0 ? (
                    <EmptyPanel
                      icon={<Search size={32} />}
                      title="没有匹配的插件"
                      description="换个关键词，或把筛选切回「全部」"
                    />
                  ) : (
                    installedRows.map((item) => {
                      const enabled = item.status === "enabled";
                      return (
                        <PluginRow
                          key={item.id}
                          rowId={item.id}
                          icon={<Puzzle size={14} className="text-tx-tertiary" />}
                          name={item.name}
                          meta={`${item.publisher || item.id} · v${item.version}`}
                          state={{
                            label: INSTALLED_STATUS_LABELS[item.status],
                            tone: enabled ? "ok" : item.status === "error" ? "bad" : "warn",
                          }}
                          controls={isAdmin ? (
                            <RowSwitch
                              checked={enabled}
                              disabled={busy}
                              label={enabled ? "停用插件" : "启用插件"}
                              onToggle={() => toggleInstalled(item)}
                            />
                          ) : null}
                          hoverActions={isAdmin ? (
                            <button
                              type="button"
                              title="卸载插件"
                              aria-label={`卸载 ${item.name}`}
                              disabled={busy}
                              onClick={() => uninstallInstalled(item)}
                              className="flex h-6 w-6 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-border/60 hover:text-red-600 disabled:opacity-50"
                            >
                              <Trash2 size={13} />
                            </button>
                          ) : null}
                          onOpen={() => { setInstalledSelection(item.id); clearActionState(); }}
                        />
                      );
                    })
                  )}

                  {/* 内置插件分区：同一个容器内的一行，点开后续接行列表 */}
                  <button
                    type="button"
                    data-plugin-builtin-section
                    aria-expanded={builtinExpanded}
                    onClick={() => setBuiltinExpanded((value) => !value)}
                    className="group flex h-8 w-full items-center gap-1.5 border-t border-app-border px-3 text-left transition-colors hover:bg-app-hover"
                  >
                    <ChevronRight
                      size={12}
                      className={cn("shrink-0 text-tx-tertiary transition-transform", builtinExpanded && "rotate-90")}
                    />
                    <span className="text-[11.5px] font-medium text-tx-secondary group-hover:text-tx-primary">内置插件</span>
                    <span className="text-[11px] text-tx-tertiary">· {BUILTIN_PLUGINS.length} 个</span>
                    <span className="ml-auto text-[11px] text-tx-tertiary">随应用内置，可启停</span>
                  </button>
                  {builtinExpanded && BUILTIN_PLUGINS.map((item) => {
                    const itemEnabled = isBuiltinPluginEnabled(item.id);
                    return (
                      <PluginRow
                        key={item.id}
                        rowId={`builtin-${item.id}`}
                        icon={iconFor(item, 14)}
                        name={item.name}
                        meta={item.description}
                        state={{ label: itemEnabled ? "已启用" : "已停用", tone: itemEnabled ? "ok" : "neutral" }}
                        controls={(
                          <RowSwitch
                            checked={itemEnabled}
                            label={itemEnabled ? "停用插件" : "启用插件"}
                            onToggle={() => setBuiltinPluginDisabled(item.id, itemEnabled)}
                          />
                        )}
                        onOpen={() => selectBuiltin(item.id)}
                      />
                    );
                  })}
                </ListPanel>
              )
            )}

            {group === "catalog" && (
              catalogLoading ? (
                <div className="flex items-center gap-2 py-8 text-[12px] text-tx-tertiary"><Loader2 size={14} className="animate-spin" />正在加载市场目录</div>
              ) : catalogError ? (
                <ListPanel empty>
                  <EmptyPanel
                    icon={<AlertCircle size={32} />}
                    title="市场目录加载失败"
                    description={catalogError}
                  />
                </ListPanel>
              ) : (
                <ListPanel empty={!catalogRows.length}>
                  {catalogRows.length ? catalogRows.map((item) => (
                    <PluginRow
                      key={item.id}
                      rowId={item.id}
                      icon={<Puzzle size={14} className="text-tx-tertiary" />}
                      name={item.name}
                      meta={`${item.id} · v${item.latestVersion}`}
                      controls={(
                        <span className="shrink-0 text-[11px] text-tx-tertiary">{item.trustLevel || "community"}</span>
                      )}
                      onOpen={() => { setCatalogSelection(item.id); clearActionState(); }}
                    />
                  )) : (
                    <EmptyPanel
                      icon={<Store size={32} />}
                      title={catalog && catalog.length ? "没有匹配的插件" : "市场暂无可显示的插件"}
                      description={catalog && catalog.length
                        ? "换个关键词，或清掉搜索再试"
                        : "Registry 暂无条目，可在「配置」中检查安装源或稍后重试"}
                    />
                  )}
                </ListPanel>
              )
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
