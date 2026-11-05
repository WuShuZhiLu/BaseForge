/**
 * 内置插件的侧栏迷你面板：待办 / 每日记录 / 项目管理。
 *
 * 由 SidebarDesktop 按 builtinId 渲染；数据走统一 api。
 * 界面独立原则：待办/日记/AI 打开时侧栏顶块就是插件模块顶块，知识库树不渲染；
 * 面板内部统一规格（12px 文字 / h32 行 / 圆点分区标题 / 统一 chip）。
 * 项目管理（pm）维持旧浮层卡规格（用户拍板暂不统一）。
 */
import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Calendar, CalendarDays, CheckCheck, Clock3, FolderOpen, Inbox, ListTodo, Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api";
import type { PmProject, PmWorkItem, TaskFilter, TaskProject } from "@/types";
import { cn } from "@/lib/utils";

/** 统一规格的分区标题：实心圆点 + 12px/600 灰字（与 SidebarDesktop PanelSection 一致）。 */
function PanelSectionHead({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between pl-1 pr-1 pb-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-tx-tertiary" />
        <span className="min-w-0 truncate text-[12px] font-semibold text-tx-tertiary">{label}</span>
      </span>
      {action}
    </div>
  );
}

function SectionRefresh({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" title="刷新" onClick={onClick} className="text-tx-tertiary hover:text-tx-primary">
      <RefreshCw size={12} />
    </button>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="px-2 py-4 text-center text-[12px] text-tx-tertiary">{text}</p>;
}

/** ============ 项目管理迷你面板（旧规格保留，暂不统一） ============ */
function LegacyMiniShell({ title, onRefresh, children }: { title: string; onRefresh: () => void; children: React.ReactNode }) {
  return (
    <div className="sbx-view">
      <div className="sbx-view-head">
        <span>{title}</span>
        <span className="flex-1" />
        <button type="button" title="刷新" onClick={onRefresh} className="sbx-btn">
          <RefreshCw size={12} />
        </button>
      </div>
      {children}
    </div>
  );
}

export function PmMiniPanel() {
  const [projects, setProjects] = useState<PmProject[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    api.listPmProjects()
      .then(async (r) => {
        setProjects(r.projects);
        const entries = await Promise.all(
          r.projects.map(async (p) => {
            try {
              const res = await api.listPmWorkItems(p.id);
              return [p.id, res.items.filter((i) => i.status !== "done" && i.status !== "canceled").length] as const;
            } catch {
              return [p.id, 0] as const;
            }
          }),
        );
        setCounts(Object.fromEntries(entries));
      })
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return (
    <LegacyMiniShell title="项目管理" onRefresh={reload}>
      {loading ? (
        <p className="sbx-view-empty">加载中…</p>
      ) : projects.length === 0 ? (
        <p className="sbx-view-empty">还没有项目，在主区新建</p>
      ) : (
        <div className="px-2 pb-2 space-y-1">
          {projects.slice(0, 8).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("nowen:pm-focus-project", { detail: { projectId: p.id } }))}
              className="sbx-row w-full text-left flex items-center gap-2"
            >
              <ListTodo size={11} className="shrink-0 text-accent-primary" />
              <span className="min-w-0 flex-1 truncate text-[11px]">{p.name}</span>
              <span className="text-[10px] text-zinc-400">{counts[p.id] ?? 0} 未完成</span>
            </button>
          ))}
        </div>
      )}
    </LegacyMiniShell>
  );
}

/**
 * 待办迷你面板（统一规格）：侧栏待办导航层。
 *
 * 主区（TaskWorkspaceImpl）左栏已移除，本面板是唯一导航层：
 * - 「视图」分区行点击 dispatch `nowen:task-filter-select`（key 与主区 FILTERS 一致）；
 * - 「清单」分区行点击 dispatch `nowen:task-focus-project`；
 * - 选中态为本地记录（主区暂无回传事件）。
 */
const TASK_PANEL_VIEWS: { key: TaskFilter; labelKey: string; icon: React.ReactNode }[] = [
  { key: "all", labelKey: "tasks.allTasks", icon: <Inbox size={14} /> },
  { key: "today", labelKey: "tasks.today", icon: <CalendarDays size={14} /> },
  { key: "week", labelKey: "tasks.next7Days", icon: <Calendar size={14} /> },
  { key: "overdue", labelKey: "tasks.overdue", icon: <AlertTriangle size={14} /> },
  { key: "completed", labelKey: "tasks.completed", icon: <CheckCheck size={14} /> },
];

export function TasksMiniPanel() {
  const { t } = useTranslation();
  // 本地记录最近点击的视图 / 项目（主区暂无回传事件，仅做选中高亮）
  const [selectedView, setSelectedView] = useState<TaskFilter>("all");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<TaskProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [quickText, setQuickText] = useState("");
  const [adding, setAdding] = useState(false);

  const reloadProjects = useCallback(() => {
    setProjectsLoading(true);
    // 与 TaskWorkspaceImpl 的 useTaskProjects 相同取数：api.getTaskProjects()
    api.getTaskProjects()
      .then((data) => setProjects(data))
      .catch(() => setProjects([]))
      .finally(() => setProjectsLoading(false));
  }, []);

  useEffect(() => { reloadProjects(); }, [reloadProjects]);

  const quickAdd = useCallback(async () => {
    const title = quickText.trim();
    if (!title) return;
    setAdding(true);
    try {
      await api.createTask({ title } as never);
      setQuickText("");
      reloadProjects();
    } catch (error) {
      console.error("[TasksMiniPanel] quick add failed:", error);
    } finally {
      setAdding(false);
    }
  }, [quickText, reloadProjects]);

  const selectView = useCallback((key: TaskFilter) => {
    setSelectedView(key);
    setSelectedProjectId(null);
    window.dispatchEvent(new CustomEvent("nowen:task-filter-select", { detail: { key } }));
  }, []);

  const selectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    window.dispatchEvent(new CustomEvent("nowen:task-focus-project", { detail: { projectId } }));
  }, []);

  // 行规格：12px / h32 / 无边框 / hover 变色 / 选中 #e8efff
  const rowCls = (active: boolean) =>
    cn(
      "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] transition-colors",
      active ? "bg-[#e8efff]" : "hover:bg-app-hover",
    );

  return (
    <div>
      <div className="px-2 py-1.5">
        <PanelSectionHead label="视图" />
        <div className="space-y-0.5">
          {TASK_PANEL_VIEWS.map((view) => (
            <div
              key={view.key}
              role="button"
              tabIndex={0}
              className={rowCls(selectedView === view.key)}
              onClick={() => selectView(view.key)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") selectView(view.key); }}
            >
              <span className="shrink-0 text-tx-tertiary">{view.icon}</span>
              <span className="min-w-0 flex-1 truncate text-tx-primary">{t(view.labelKey)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="px-2 py-1.5">
        <PanelSectionHead label="清单" action={<SectionRefresh onClick={reloadProjects} />} />
        {projectsLoading ? (
          <EmptyHint text="加载中…" />
        ) : projects.length === 0 ? (
          <EmptyHint text="暂无清单，在主区新建" />
        ) : (
          <div className="space-y-0.5">
            {projects.map((p) => (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                className={rowCls(selectedProjectId === p.id)}
                onClick={() => selectProject(p.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") selectProject(p.id); }}
              >
                <FolderOpen size={14} className="shrink-0 text-tx-tertiary" style={{ color: p.color }} />
                <span className="min-w-0 flex-1 truncate text-tx-primary">{p.name}</span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-tx-tertiary">
                  {Math.max(0, (p.taskCount ?? 0) - (p.completedCount ?? 0))}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="px-2 py-1.5">
        <PanelSectionHead label="快速添加" />
        <div className="px-1 pb-1">
          <div className="flex h-8 items-center gap-2 rounded-md border border-app-border bg-app-bg px-2">
            <Plus size={13} className="shrink-0 text-tx-tertiary" />
            <input
              value={quickText}
              onChange={(e) => setQuickText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void quickAdd(); }}
              placeholder="快速添加任务"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-tx-primary outline-none placeholder:text-tx-tertiary"
            />
            {quickText.trim() && (
              <button type="button" onClick={() => void quickAdd()} disabled={adding} className="shrink-0 text-[11px] text-accent-primary">
                {adding ? "…" : "添加"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
