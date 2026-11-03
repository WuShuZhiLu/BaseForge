/**
 * 内置插件的侧栏迷你面板：待办 / 每日记录 / 项目管理。
 *
 * 由 PluginPanelHost 按 builtinId 渲染；数据走统一 api。
 * 注意：模块切换是导航栏（Rail）的职责，侧栏不放"在主区打开/返回知识库"这类跨模块跳转按钮——
 * 侧栏里出现跨模块入口会让"侧栏属于当前模块"这个前提失效，状态直接乱掉。
 */
import React, { useCallback, useEffect, useState } from "react";
import { ListTodo, Plus, RefreshCw } from "lucide-react";

import { api } from "@/lib/api";
import type { PmProject, PmWorkItem } from "@/types";
import { getTaskInbox } from "@/lib/taskInboxApi";
import type { Task } from "@/types";
import { cn } from "@/lib/utils";

interface MiniPanelShellProps {
  title: string;
  onRefresh: () => void;
  children: React.ReactNode;
}

function MiniPanelShell({ title, onRefresh, children }: MiniPanelShellProps) {
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

function EmptyHint({ text }: { text: string }) {
  return <p className="sbx-view-empty">{text}</p>;
}

/** ============ 项目管理迷你面板 ============ */
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
    <MiniPanelShell title="项目管理" onRefresh={reload}>
      {loading ? (
        <EmptyHint text="加载中…" />
      ) : projects.length === 0 ? (
        <EmptyHint text="还没有项目，在主区新建" />
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
    </MiniPanelShell>
  );
}

/** ============ 待办迷你面板 ============ */
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
    <MiniPanelShell title="待办" onRefresh={reload}>
      <div className="sbx-chips">
        {([["inbox", "收件箱"], ["today", "今日"], ["all", "任务"]] as Array<[typeof mode, string]>).map(([value, label]) => (
          <span
            key={value}
            className={cn("sbx-chip", mode === value && "on")}
            onClick={() => {
              setMode(value);
              // 同步主区：切到对应过滤视图
              window.dispatchEvent(new CustomEvent("nowen:task-panel-navigate", { detail: { target: value } }));
            }}
          >{label}</span>
        ))}
      </div>
      <div className="sbx-quick-add">
        <Plus size={13} className="shrink-0" />
        <input
          value={quickText}
          onChange={(e) => setQuickText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void quickAdd(); }}
          placeholder="快速添加任务"
          className="min-w-0 flex-1 bg-transparent text-[11px] text-tx-primary outline-none placeholder:text-tx-tertiary"
        />
        {quickText.trim() && (
          <button type="button" onClick={() => void quickAdd()} disabled={adding} className="text-[11px] text-accent-primary">
            {adding ? "…" : "添加"}
          </button>
        )}
      </div>
      <div className="px-1 pb-2">
        {loading ? (
          <EmptyHint text="加载中…" />
        ) : tasks.length === 0 ? (
          <EmptyHint text="暂无任务" />
        ) : tasks.slice(0, 30).map((task) => (
          <div key={task.id} className="sbx-row group" onClick={() => toggleDone(task)}>
            <span
              className={cn(
                "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                task.isCompleted ? "border-accent-primary bg-accent-primary" : "border-app-border",
              )}
            >
              {Boolean(task.isCompleted) && <ListTodo size={9} className="text-white" />}
            </span>
            <span className="min-w-0 flex-1">
              <div className={cn("truncate text-xs", task.isCompleted ? "text-tx-tertiary line-through" : "text-tx-primary")}>
                {task.title}
              </div>
              {task.dueAt && <div className="sbx-sub">{task.dueAt.slice(0, 10)}</div>}
            </span>
          </div>
        ))}
      </div>
    </MiniPanelShell>
  );
}

interface JournalItem {
  id: string;
  title: string;
  subtitle: string;
  journalDate: string;
}

/** ============ 每日记录迷你面板 ============ */
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
    <MiniPanelShell title="日记" onRefresh={reload}>
      <div className="px-1 pb-2">
        {loading ? (
          <EmptyHint text="加载中…" />
        ) : items.length === 0 ? (
          <EmptyHint text="暂无记录" />
        ) : items.map((item) => (
          <div key={item.id} className="sbx-row group">
            <span className="min-w-0 flex-1">
              <div className="truncate text-xs text-tx-primary">{item.title || item.journalDate}</div>
              <div className="sbx-sub">{item.subtitle || item.journalDate}</div>
            </span>
          </div>
        ))}
      </div>
    </MiniPanelShell>
  );
}
