/**
 * PluginsWorkspace —— 插件模块工作区（VS Code 扩展详情式）
 *
 * 三分区模型：插件徽章 → 侧栏插件列表 + 本工作区详情页。
 * 详情源归一为三类，信息架构统一：
 * - builtin：官方内置插件（builtin registry），页内启停 + 打开面板/主区；
 * - installed：已安装第三方插件（GET /plugins），管理员启停/回滚/卸载；
 * - catalog：市场目录（GET /plugins/ecosystem/catalog），管理员安装。
 * 页内 Tab 分组（内置/已安装/市场/管理）；侧栏点击内置插件 → nowen:plugin-selected 直达详情，
 * 侧栏点「市场」→ nowen:plugin-group 切到市场分组。
 *
 * 管理分组（仅管理员）收口原先在 设置 → 插件 里的全局能力：本地安装、检查更新、
 * Runtime 策略、Registry 来源、开发者模式；单插件配置在详情页「设置与运行」分区。
 *
 * 选中状态经 localStorage + nowen:plugin-selected 事件与侧栏共享（仅内置插件）；
 * 启停复用 builtin registry，变更广播 nowen:builtin-plugins-changed。
 * README/Changelog/Dependencies 区块在 Registry V2 索引提供数据前隐藏。
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ClipboardList,
  Download,
  ExternalLink,
  FolderOpen,
  ListTodo,
  Loader2,
  PenLine,
  Puzzle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useAppActions } from "@/store/AppContext";
import { pluginApi, type InstalledPlugin, type PluginPermissionRow } from "@/lib/pluginApi";
import { getPluginRuntimePresentation } from "@/lib/pluginRuntimePresentation";
import { PluginConfigSections } from "@/components/plugins/PluginConfigSections";
import { PluginAdminPanel } from "@/components/plugins/PluginAdminPanel";
import {
  BUILTIN_ORIGIN_LABEL,
  BUILTIN_PLUGINS,
  isBuiltinPluginEnabled,
  setBuiltinPluginDisabled,
  type BuiltinPluginDef,
  type BuiltinPluginId,
} from "@/plugins/builtin/registry";

const SELECTED_KEY = "nowen-plugins-workspace-selected";
const PLUGIN_SELECTED_EVENT = "nowen:plugin-selected";
/** 侧栏插件视图点「市场」→ 工作区切到对应分组 */
const PLUGIN_GROUP_EVENT = "nowen:plugin-group";
const BUILTIN_CHANGED_EVENT = "nowen:builtin-plugins-changed";
/** 市场目录默认源（Registry V2 官方源） */
const MARKET_SOURCE_ID = "official-v2";

type DetailSource = "builtin" | "installed" | "catalog";
/** 管理分组不对应任何可选中对象，只承载全局管理能力 */
type GroupKey = DetailSource | "admin";
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
  ["builtin", "内置"],
  ["installed", "已安装"],
  ["catalog", "市场"],
  ["admin", "管理"],
];

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

function Badge({ tone = "neutral", children }: { tone?: "ok" | "warn" | "bad" | "info" | "neutral"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px]",
        tone === "ok" && "bg-emerald-500/15 text-emerald-600",
        tone === "warn" && "bg-amber-500/15 text-amber-600",
        tone === "bad" && "bg-red-500/15 text-red-600",
        tone === "info" && "bg-indigo-500/15 text-indigo-600",
        tone === "neutral" && "bg-zinc-500/15 text-tx-secondary",
      )}
    >
      {children}
    </span>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-app-border bg-app-surface p-4">
      <h3 className="text-sm font-semibold text-tx-primary">{title}</h3>
      {children}
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
    <div className="flex items-start gap-4">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-lg font-semibold text-tx-primary">{name}</h2>
          {badges}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-tx-tertiary">{uniqueId}</p>
        <p className="mt-1 text-sm text-tx-secondary">{description}</p>
        <p className="mt-1 text-xs text-tx-tertiary">v{version}</p>
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
      <p className="mt-1 text-sm text-tx-secondary">{description || "暂无说明"}</p>
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

function PermissionList({ rows, emptyText }: { rows: PluginPermissionRow[] | string[]; emptyText: string }) {
  if (!rows.length) return <p className="mt-2 text-xs text-tx-tertiary">{emptyText}</p>;
  const items = (rows as Array<PluginPermissionRow | string>).map((row) =>
    typeof row === "string" ? { permission: row, granted: true } : row,
  );
  return (
    <ul className="mt-2 space-y-1">
      {items.map((item) => (
        <li key={item.permission} className="flex items-baseline gap-2 text-xs text-tx-secondary">
          <ShieldCheck size={12} className={cn("mt-0.5 shrink-0", item.granted ? "text-emerald-500" : "text-amber-500")} />
          <span>{permissionLabel(item.permission)}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-tx-tertiary">{item.permission}</span>
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
        icon={iconFor(plug, 28)}
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
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
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
        icon={<Puzzle size={28} className="text-tx-tertiary" />}
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
          rows={plugin.permissions}
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
                  className="rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-sm text-tx-primary transition-colors hover:bg-app-hover disabled:opacity-50"
                >
                  禁用
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onToggle(plugin)}
                  className="rounded-md bg-accent-primary px-3 py-1.5 text-sm text-white transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {presentation.enableLabel}
                </button>
              )}
              {plugin.previousVersion && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRollback(plugin)}
                  className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-sm text-tx-primary transition-colors hover:bg-app-hover disabled:opacity-50"
                >
                  <RotateCcw size={13} />回滚到 v{plugin.previousVersion}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => onUninstall(plugin)}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50"
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
  // 与插件市场的安装门槛一致：Node Runtime 插件需管理员先在「管理」分组放行
  const needsPolicy = extension.runtime === "node-action" && nodeRuntimeAllowed !== true;
  const permissions = latest?.permissions || [];
  return (
    <div>
      <DetailHeader
        icon={<Puzzle size={28} className="text-tx-tertiary" />}
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
          <PermissionList rows={permissions} emptyText="不请求数据权限" />
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
              className="inline-flex items-center gap-1 rounded-md bg-accent-primary px-3 py-1.5 text-sm text-white transition-colors hover:opacity-90 disabled:opacity-50"
            >
              <Download size={13} />{busy ? "正在安装" : "安装"}
            </button>
          ) : (
            <p className="text-xs text-tx-tertiary">安装为管理员操作。</p>
          )}
          {isAdmin && needsPolicy && (
            <p className="text-xs text-amber-600">
              {nodeRuntimeAllowed === null ? "正在读取 Runtime 策略" : "此插件需要 Node Runtime，请先到本页「管理」分组放行"}
            </p>
          )}
        </div>
        {actionError && <p role="alert" className="mt-2 text-xs text-red-600">{actionError}</p>}
      </SectionCard>
    </div>
  );
}

export default function PluginsWorkspace() {
  const [selectedId, setSelectedId] = useState<BuiltinPluginId | null>(() => {
    try {
      const raw = localStorage.getItem(SELECTED_KEY);
      return raw && BUILTIN_PLUGINS.some((p) => p.id === raw) ? (raw as BuiltinPluginId) : null;
    } catch {
      return null;
    }
  });
  // 页内分组 Tab + 非内置插件选中态（不持久化；侧栏仅联动内置插件）
  const [group, setGroup] = useState<GroupKey>("builtin");
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

  const refreshInstalled = useCallback(async () => {
    try {
      setInstalled(await pluginApi.list());
    } catch {
      setInstalled([]);
    }
  }, []);

  /** 分组切换统一出口：主区自己换分组（如安装后跳已安装）时也广播出去，侧栏分类跟着高亮 */
  const goGroup = useCallback((next: GroupKey) => {
    setGroup(next);
    window.dispatchEvent(new CustomEvent(PLUGIN_GROUP_EVENT, { detail: { group: next } }));
  }, []);

  useEffect(() => {
    const onSelect = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      if (BUILTIN_PLUGINS.some((p) => p.id === id)) {
        setSelectedId(id as BuiltinPluginId);
        goGroup("builtin");
        return;
      }
      // 第三方插件：侧栏行点击 → 切到已安装分组并选中同一插件
      setInstalledSelection(id);
      goGroup("installed");
    };
    // 侧栏插件视图的「市场」分类 → 切到本页的市场分组
    const onGroup = (event: Event) => {
      const next = (event as CustomEvent<{ group?: GroupKey }>).detail?.group;
      if (!next || !GROUP_TABS.some(([key]) => key === next)) return;
      setGroup(next);
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
  const detail = group === "builtin" && plug ? { source: "builtin" as const, plug }
    : group === "installed" && installedPlug ? { source: "installed" as const, plug: installedPlug }
      : group === "catalog" && marketExt ? { source: "catalog" as const, ext: marketExt }
        : null;

  const selectBuiltin = (id: BuiltinPluginId) => {
    try { localStorage.setItem(SELECTED_KEY, id); } catch { /* ignore */ }
    setSelectedId(id);
    goGroup("builtin");
  };

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
    if (group === "builtin") setSelectedId(null);
    if (group === "installed") setInstalledSelection(null);
    if (group === "catalog") setCatalogSelection(null);
    clearActionState();
  };

  /** 分组导航在侧栏插件视图（内置/已安装/市场/管理），主区只跟事件跑，不再重复一排 tab。 */
  const groupLabel = GROUP_TABS.find(([key]) => key === group)?.[1] ?? "";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-app-bg">
      {/* 标题行 h-12：与侧栏工作区头同一节奏；返回/分组 tab 右置 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-app-border px-4">
        <Puzzle size={18} className="shrink-0 text-tx-secondary" />
        <h2 className="text-[15px] font-semibold text-tx-primary">插件</h2>
        <span className="hidden truncate text-xs text-tx-tertiary sm:inline">
          {detail ? "查看插件详情" : group === "admin" ? "安装源、更新与执行边界" : groupLabel}
        </span>
        <span className="flex-1" />
        {detail ? (
          <button
            type="button"
            onClick={backToList}
            className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-surface px-2 py-1 text-xs text-tx-secondary transition-colors hover:bg-app-hover"
          >
            <ArrowLeft size={12} />返回列表
          </button>
        ) : <span />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl p-6 pt-5">
        {detail?.source === "builtin" && <div key={`${detail.plug.id}-${version}`}><BuiltinDetail plug={detail.plug} /></div>}
        {detail?.source === "installed" && (
          <div className="mt-6">
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
          <div className="mt-6">
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
          <div>
            {group === "builtin" && (
              <div className="space-y-2">
                {BUILTIN_PLUGINS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectBuiltin(item.id)}
                    className="flex w-full items-center gap-3 rounded-lg border border-app-border bg-app-surface p-3 text-left transition-colors hover:bg-app-hover"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-app-border bg-app-bg">
                      {iconFor(item, 18)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-tx-primary">{item.name}</span>
                      <span className="block truncate text-xs text-tx-tertiary">v{item.version} · {item.description}</span>
                    </span>
                    <Badge tone={isBuiltinPluginEnabled(item.id) ? "ok" : "neutral"}>
                      {isBuiltinPluginEnabled(item.id) ? "已启用" : "已停用"}
                    </Badge>
                  </button>
                ))}
              </div>
            )}

            {group === "admin" && (
              <PluginAdminPanel
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
                <div className="flex items-center gap-2 py-8 text-sm text-tx-tertiary"><Loader2 size={15} className="animate-spin" />正在加载已安装插件</div>
              ) : installed.length ? (
                <div className="space-y-2">
                  {installed.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => { setInstalledSelection(item.id); clearActionState(); }}
                      className="flex w-full items-center gap-3 rounded-lg border border-app-border bg-app-surface p-3 text-left transition-colors hover:bg-app-hover"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-app-border bg-app-bg">
                        <Puzzle size={16} className="text-tx-tertiary" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-tx-primary">{item.name}</span>
                        <span className="block truncate font-mono text-[11px] text-tx-tertiary">{item.id} · v{item.version}</span>
                      </span>
                      <Badge tone={item.status === "enabled" ? "ok" : item.status === "error" ? "bad" : "warn"}>
                        {INSTALLED_STATUS_LABELS[item.status]}
                      </Badge>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-app-border py-10 text-center text-sm text-tx-tertiary">
                  尚未安装第三方插件，可到「市场」浏览。
                </div>
              )
            )}

            {group === "catalog" && (
              catalogLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-tx-tertiary"><Loader2 size={15} className="animate-spin" />正在加载市场目录</div>
              ) : catalogError ? (
                <div className="rounded-lg border border-red-200 bg-red-500/5 px-4 py-8 text-center text-sm text-red-600">
                  <div className="font-medium">市场目录加载失败</div>
                  <div className="mt-1 text-xs opacity-80">{catalogError}</div>
                </div>
              ) : catalog && catalog.length ? (
                <div className="space-y-2">
                  {catalog.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => { setCatalogSelection(item.id); clearActionState(); }}
                      className="flex w-full items-center gap-3 rounded-lg border border-app-border bg-app-surface p-3 text-left transition-colors hover:bg-app-hover"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-app-border bg-app-bg">
                        <Puzzle size={16} className="text-tx-tertiary" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-tx-primary">{item.name}</span>
                        <span className="block truncate font-mono text-[11px] text-tx-tertiary">{item.id} · v{item.latestVersion}</span>
                        {item.description && <span className="block truncate text-xs text-tx-tertiary">{item.description}</span>}
                      </span>
                      <Badge tone="neutral">{item.trustLevel || "community"}</Badge>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-app-border py-10 text-center text-sm text-tx-tertiary">
                  Registry 暂无可显示插件。
                </div>
              )
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
