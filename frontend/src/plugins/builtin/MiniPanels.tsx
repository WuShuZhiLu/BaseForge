/**
 * 内置插件的侧栏迷你面板：待办 / 每日记录 / 项目管理。
 *
 * 由 SidebarDesktop 按 builtinId 渲染；数据走统一 api。
 * 界面独立原则：待办/日记/AI 打开时侧栏顶块就是插件模块顶块，知识库树不渲染；
 * 面板内部统一规格（12px 文字 / h32 行 / 圆点分区标题 / 统一 chip）。
 * 项目管理（pm）维持旧浮层卡规格（用户拍板暂不统一）。
 */
import React, { useCallback, useEffect, useState } from "react";
import { Check, ListTodo, Plus, RefreshCw } from "lucide-react";

import { api } from "@/lib/api";
import type { PmProject, PmWorkItem } from "@/types";
import { getTaskInbox } from "@/lib/taskInboxApi";
import type { Task } from "@/types";
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

/** 统一规格的任务行：h32、13px 复选框、12px 标题、10.5px 日期。 */
function TaskRow({ task, onToggle }: { task: Task; onToggle: (task: Task) => void }) {
  const done = Boolean(task.isCompleted);
  return (
    <div
      className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-app-hover"
      onClick={() => onToggle(task)}
    >
      <span
        className={cn(
          "flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded border",
          done ? "border-accent-primary bg-accent-primary" : "border-app-border bg-app-bg",
        )}
      >
        {done && <Check size={9} className="text-white" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[12px]", done ? "text-tx-tertiary line-through" : "text-tx-primary")}>
          {task.title}
        </span>
      </span>
      {task.dueAt && <span className="shrink-0 text-[10.5px] tabular-nums text-tx-tertiary">{task.dueAt.slice(0, 10)}</span>}
    </div>
  );
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

/** ============ 待办迷你面板（统一规格） ============ */
export function TasksMiniPanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"inbox" | "today" | "all">("inbox");
  const [quickText, setQuickText] = useState("");
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    const load = mode === "inbox"
      ? getTaskInbox().then((r) => r.items as Task[])
      : api.getTasks(mode === "today" ? "today" : undefined);
    load
      .then((items) => setTasks(items))
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, [mode]);

  useEffect(() => { reload(); }, [reload]);

  const toggleDone = useCallback((task: Task) => {
    api.updateTask(task.id, { isCompleted: task.isCompleted ? 0 : 1 } as never)
      .then(() => reload())
      .catch(() => undefined);
  }, [reload]);

  const quickAdd = useCallback(async () => {
    const title = quickText.trim();
    if (!title) return;
    setAdding(true);
    try {
      await api.createTask({ title } as never);
      setQuickText("");
      reload();
    } catch (error) {
      console.error("[TasksMiniPanel] quick add failed:", error);
    } finally {
      setAdding(false);
    }
  }, [quickText, reload]);

  return (
    <div>
      <div className="border-b border-app-border px-2 py-1.5">
        <PanelSectionHead label="视图" />
        <div className="flex flex-wrap gap-1 px-1">
          {([["inbox", "收件箱"], ["today", "今日"], ["all", "任务"]] as Array<[typeof mode, string]>).map(([value, label]) => (
            <span
              key={value}
              role="button"
              tabIndex={0}
              className={cn(
                "cursor-pointer rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                mode === value
                  ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary"
                  : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover",
              )}
              onClick={() => {
                setMode(value);
                // 同步主区：切到对应过滤视图
                window.dispatchEvent(new CustomEvent("nowen:task-panel-navigate", { detail: { target: value } }));
              }}
            >{label}</span>
          ))}
        </div>
      </div>
      <div className="border-b border-app-border px-2 py-1.5">
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
      <div className="px-2 py-1.5">
        <PanelSectionHead label={mode === "all" ? "任务" : mode === "today" ? "今日任务" : "收件箱"} action={<SectionRefresh onClick={reload} />} />
        {loading ? (
          <EmptyHint text="加载中…" />
        ) : tasks.length === 0 ? (
          <EmptyHint text="暂无任务" />
        ) : (
          <div className="space-y-0.5">
            {tasks.slice(0, 30).map((task) => (
              <TaskRow key={task.id} task={task} onToggle={toggleDone} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface JournalItem {
  id: string;
  title: string;
  subtitle: string;
  journalDate: string;
}

/** ============ 每日记录迷你面板（统一规格） ============ */
export function DiaryMiniPanel() {
  const [items, setItems] = useState<JournalItem[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    api.journals.list({ limit: 20, sort: "date_desc" })
      .then((r) => setItems(r.items as JournalItem[]))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      <div className="px-2 py-1.5">
        <PanelSectionHead label="记录" action={<SectionRefresh onClick={reload} />} />
        {loading ? (
          <EmptyHint text="加载中…" />
        ) : items.length === 0 ? (
          <EmptyHint text="暂无记录" />
        ) : (
          <div className="space-y-0.5">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-app-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-tx-primary">{item.title || item.journalDate}</span>
                </span>
                <span className="shrink-0 text-[10.5px] text-tx-tertiary">{item.subtitle || item.journalDate}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
