/**
 * PluginsWorkspace —— 插件模块工作区（VSCode 扩展详情式）
 *
 * 三分区模型：插件徽章 → 侧栏插件列表 + 本工作区详情页。
 * 默认空白（提示从侧栏选择插件）；点击侧栏插件项 → 显示插件详情
 * （名称/描述/版本/启停状态 + 打开侧栏面板 / 在主区打开）。
 *
 * 选中状态经 localStorage + nowen:plugin-selected 事件与侧栏共享；
 * 启停复用 builtin registry，变更广播 nowen:builtin-plugins-changed。
 */
import React, { useEffect, useState } from "react";
import {
  ClipboardList,
  FolderOpen,
  ListTodo,
  PenLine,
  Puzzle,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppActions } from "@/store/AppContext";
import {
  BUILTIN_PLUGINS,
  isBuiltinPluginEnabled,
  setBuiltinPluginDisabled,
  type BuiltinPluginDef,
  type BuiltinPluginId,
} from "@/plugins/builtin/registry";

const SELECTED_KEY = "nowen-plugins-workspace-selected";
const PLUGIN_SELECTED_EVENT = "nowen:plugin-selected";
const BUILTIN_CHANGED_EVENT = "nowen:builtin-plugins-changed";

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

export default function PluginsWorkspace() {
  const actions = useAppActions();
  const [selectedId, setSelectedId] = useState<BuiltinPluginId | null>(() => {
    try {
      const raw = localStorage.getItem(SELECTED_KEY);
      return raw && BUILTIN_PLUGINS.some((p) => p.id === raw) ? (raw as BuiltinPluginId) : null;
    } catch {
      return null;
    }
  });
  // 启停状态变化时重渲染（本组件与侧栏都可改）
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const onSelect = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      if (id && BUILTIN_PLUGINS.some((p) => p.id === id)) setSelectedId(id as BuiltinPluginId);
    };
    const onChanged = () => setVersion((v) => v + 1);
    window.addEventListener(PLUGIN_SELECTED_EVENT, onSelect);
    window.addEventListener(BUILTIN_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(PLUGIN_SELECTED_EVENT, onSelect);
      window.removeEventListener(BUILTIN_CHANGED_EVENT, onChanged);
    };
  }, []);

  const plug = selectedId ? BUILTIN_PLUGINS.find((p) => p.id === selectedId) ?? null : null;
  const enabled = plug ? isBuiltinPluginEnabled(plug.id) : false;

  const toggleEnabled = () => {
    if (!plug) return;
    setBuiltinPluginDisabled(plug.id, enabled);
    window.dispatchEvent(new CustomEvent(BUILTIN_CHANGED_EVENT));
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-app-bg">
      {!plug ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <Puzzle size={44} className="mx-auto mb-3 text-tx-tertiary" />
            <h2 className="text-base font-semibold text-tx-primary">插件</h2>
            <p className="mt-1 text-sm text-tx-secondary">从左侧选择一个插件，查看详细信息。</p>
          </div>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-2xl p-6" key={`${plug.id}-${version}`}>
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface">
              {iconFor(plug, 28)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-lg font-semibold text-tx-primary">{plug.name}</h2>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px]",
                    enabled ? "bg-emerald-500/15 text-emerald-600" : "bg-zinc-500/15 text-tx-secondary",
                  )}
                >
                  {enabled ? "已启用" : "已停用"}
                </span>
              </div>
              <p className="mt-1 text-sm text-tx-secondary">{plug.description}</p>
              <p className="mt-1 text-xs text-tx-tertiary">
                v{plug.version} · 官方内置 · 侧栏面板：{plug.sidebarPanel.title}
              </p>
            </div>
          </div>

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
              <>
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent("nowen:open-plugin-panel", { detail: { id: plug.id } }))}
                  className="rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-sm text-tx-primary transition-colors hover:bg-app-hover"
                >
                  打开侧栏面板
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // 嵌入型插件（远程文件）无独立主区 → 进文件管理的远程文件页
                    if (plug.embedded) {
                      window.dispatchEvent(new CustomEvent("nowen:files-remote-tab"));
                      actions.setViewMode("files");
                      return;
                    }
                    if (plug.viewMode === "remote-files") {
                      actions.setViewMode("files");
                      return;
                    }
                    actions.setViewMode(plug.viewMode);
                  }}
                  className="rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-sm text-tx-primary transition-colors hover:bg-app-hover"
                >
                  在主区打开
                </button>
              </>
            )}
          </div>

          <div className="mt-8 rounded-lg border border-app-border bg-app-surface p-4">
            <h3 className="text-sm font-semibold text-tx-primary">功能与贡献</h3>
            <ul className="mt-2 space-y-1 text-xs text-tx-secondary">
              <li>· 侧栏迷你面板：{plug.sidebarPanel.title}（知识库视图内嵌）</li>
              <li>· 主区视图：{plug.embedded ? "无（嵌入文件管理）" : plug.viewMode}</li>
              <li>· 停用后入口消失，数据始终保留</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
