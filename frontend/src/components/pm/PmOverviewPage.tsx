import { useEffect, useState } from "react";
import { ListTree, Loader2 } from "lucide-react";
import type { PmWorkItemLog } from "@/types";
import { api } from "@/lib/api";

/** 概览页后端聚合数据（/api/pm/overview） */
export interface PmOverviewData {
  totals: {
    projects: number;
    items: number;
    byStatus: Record<string, number>;
    byType: Array<{ key: string; label: string; count: number }>;
    overdue: number;
  };
  projects: Array<{ id: string; name: string; color: string | null; total: number; done: number; byStatus: Record<string, number>; overdue: number }>;
  overdueItems: Array<{ id: string; itemNo: number | null; title: string; dueDate: string; status: string; projectName: string }>;
  recent: Array<{ itemId: string; itemNo: number | null; title: string; field: string; oldValue: string | null; newValue: string | null; createdAt: string }>;
}

const STATUS_META: Array<{ key: string; label: string; color: string }> = [
  { key: "todo", label: "待处理", color: "#F59E0B" },
  { key: "doing", label: "进行中", color: "#2563EB" },
  { key: "review", label: "待验证", color: "#8B5CF6" },
  { key: "done", label: "已完成", color: "#10B981" },
];

const TYPE_COLORS = ["#2563EB", "#10B981", "#EF4444", "#F59E0B", "#8B5CF6", "#06B6D4"];

const FIELD_LABELS: Record<string, string> = {
  __created__: "创建",
  title: "标题",
  description: "描述",
  status: "状态",
  priority: "优先级",
  dueDate: "截止日期",
  type: "类型",
  tags: "标签",
  noteId: "交付文档",
  gitIssueState: "平台状态",
  parentId: "父工作项",
  noteLinked: "关联文档",
  noteUnlinked: "解除文档关联",
};

const STATUS_LABELS: Record<string, string> = { todo: "待处理", doing: "进行中", review: "待验证", done: "已完成", canceled: "已取消" };
const PRIORITY_LABELS: Record<string, string> = { urgent: "紧急", high: "高", medium: "中", low: "低" };

function displayValue(field: string, value: string | null): string {
  if (value === null) return "（空）";
  if (field === "status") return STATUS_LABELS[value] ?? value;
  if (field === "priority") return PRIORITY_LABELS[value] ?? value;
  return value;
}

function formatLog(log: PmWorkItemLog): string {
  if (log.field === "__created__") return `创建「${log.newValue ?? ""}」`;
  const label = FIELD_LABELS[log.field] ?? log.field;
  return `${label}：${displayValue(log.field, log.oldValue)} → ${displayValue(log.field, log.newValue)}`;
}

/**
 * 概览页（禅道式图形化统计，跨项目）：
 * 统计卡 + 各项目进度条 + 状态环形图 + 类型分布 + 逾期/今日到期清单 + 最近动态。
 */
export default function PmOverviewPage({ onOpenProject }: { onOpenProject: () => void }) {
  const [data, setData] = useState<PmOverviewData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .listPmOverview()
      .then((res) => {
        if (alive) setData(res as unknown as PmOverviewData);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : "加载概览失败");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="p-5 text-xs text-red-500">{error}</div>;
  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-xs text-zinc-400">
        <Loader2 size={14} className="animate-spin" /> 加载概览…
      </div>
    );
  }

  const { totals, projects, overdueItems, recent } = data;
  const totalItems = Math.max(totals.items, 1);
  const doneRate = Math.round(((totals.byStatus.done ?? 0) / totalItems) * 100);

  const donutStops: string[] = [];
  let cursor = 0;
  for (const meta of STATUS_META) {
    const share = ((totals.byStatus[meta.key] ?? 0) / totalItems) * 100;
    donutStops.push(`${meta.color} ${cursor}% ${cursor + share}%`);
    cursor += share;
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const dueToday = overdueItems.filter((item) => item.dueDate <= todayIso);
  const typeMax = Math.max(1, ...totals.byType.map((t) => t.count));
  void typeMax;

  return (
    <div className="p-4 pb-8">
      {/* 统计卡 */}
      <div className="grid grid-cols-5 gap-3">
        {[
          { lab: "项目", num: totals.projects, hint: "全部项目", bg: "var(--accent-soft)", color: "var(--accent)" },
          { lab: "工单总数", num: totals.items, hint: "跨项目累计", bg: "#FEF3C7", color: "#F59E0B" },
          { lab: "进行中", num: totals.byStatus.doing ?? 0, hint: `待处理 ${totals.byStatus.todo ?? 0} · 待验证 ${totals.byStatus.review ?? 0}`, bg: "#DBEAFE", color: "#2563EB" },
          { lab: "已完成", num: totals.byStatus.done ?? 0, hint: `完成率 ${doneRate}%`, bg: "#D1FAE5", color: "#10B981" },
          { lab: "逾期", num: totals.overdue, hint: `今日到期 ${dueToday.length}`, bg: "#FEE2E2", color: "#EF4444" },
        ].map((card) => (
          <div key={card.lab} className="rounded-xl border border-app-border bg-app-elevated/60 p-3.5">
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <span className="flex h-6 w-6 items-center justify-center rounded-md" style={{ backgroundColor: card.bg, color: card.color }}>
                <ListTree size={12} />
              </span>
              {card.lab}
            </div>
            <div className="mt-1.5 text-2xl font-bold tabular-nums" style={card.lab === "逾期" ? { color: "var(--red)" } : undefined}>
              {card.num}
            </div>
            <div className="mt-0.5 text-[10px] text-zinc-400">{card.hint}</div>
          </div>
        ))}
      </div>

      {/* 各项目进度 */}
      <p className="mb-2.5 mt-5 text-[12.5px] font-semibold text-tx-primary">各项目进度</p>
      <div className="rounded-xl border border-app-border bg-app-elevated/60 p-4">
        {projects.map((p) => {
          const donePct = p.total ? Math.round(((p.byStatus.done ?? 0) / p.total) * 100) : 0;
          const doingPct = p.total ? Math.round(((p.byStatus.doing ?? 0) / p.total) * 100) : 0;
          const reviewPct = p.total ? Math.round(((p.byStatus.review ?? 0) / p.total) * 100) : 0;
          const todoPct = p.total ? Math.round(((p.byStatus.todo ?? 0) / p.total) * 100) : 0;
          return (
            <div key={p.id} className="mb-3.5 flex items-center gap-3 last:mb-0" onClick={() => onOpenProject()} title="进入该项目看板">
              <span className="w-44 shrink-0 truncate text-xs text-tx-secondary" title={p.name}>
                <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-[3px] align-[-1px]" style={{ backgroundColor: p.color || "#6b7280" }} />
                {p.name}
              </span>
              <span className="flex h-2.5 flex-1 overflow-hidden rounded-full bg-app-hover">
                <i style={{ width: `${donePct}%`, background: "var(--emerald)" }} />
                <i style={{ width: `${doingPct}%`, background: "var(--blue)" }} />
                <i style={{ width: `${reviewPct}%`, background: "var(--violet)" }} />
                <i style={{ width: `${todoPct}%`, background: "var(--amber)" }} />
              </span>
              <span className="w-28 shrink-0 text-right text-[10.5px] tabular-nums text-zinc-400">
                完成 <b className="text-tx-primary">{donePct}%</b> · {p.done}/{p.total}
                {p.overdue > 0 ? <span className="ml-1 text-red-500">逾期 {p.overdue}</span> : null}
              </span>
            </div>
          );
        })}
      </div>

      {/* 状态分布 + 类型分布 */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-app-border bg-app-elevated/60 p-4">
          <p className="mb-3 text-[12.5px] font-semibold text-tx-primary">状态分布</p>
          <div className="flex items-center gap-5">
            <div
              className="flex h-[104px] w-[104px] shrink-0 items-center justify-center rounded-full"
              style={{ background: `conic-gradient(${donutStops.join(", ")})` }}
            >
              <span className="flex h-[68px] w-[68px] flex-col items-center justify-center rounded-full bg-white dark:bg-zinc-900">
                <b className="text-lg tabular-nums">{totals.items}</b>
                <span className="text-[9px] text-zinc-400">工单</span>
              </span>
            </div>
            <div className="space-y-1.5 text-[11.5px] text-tx-secondary">
              {STATUS_META.map((meta) => (
                <div key={meta.key} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-[3px]" style={{ backgroundColor: meta.color }} />
                  {meta.label}
                  <b className="ml-auto tabular-nums text-tx-primary">{totals.byStatus[meta.key] ?? 0}</b>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-app-border bg-app-elevated/60 p-4">
          <p className="mb-3 text-[12.5px] font-semibold text-tx-primary">类型分布</p>
          <div className="space-y-2.5">
            {totals.byType.length === 0 ? <p className="text-[11px] text-zinc-400">暂无工单</p> : null}
            {totals.byType.map((t, index) => {
              const pct = totals.items ? Math.round((t.count / totals.items) * 100) : 0;
              const color = TYPE_COLORS[index % TYPE_COLORS.length];
              return (
                <div key={t.key} className="flex items-center gap-2.5">
                  <span className="w-12 shrink-0 text-xs text-tx-secondary">{t.label}</span>
                  <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-app-hover">
                    <span className="block h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                  </span>
                  <span className="w-8 shrink-0 text-right text-[10.5px] tabular-nums text-zinc-400">{t.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 逾期与最近动态 */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-app-border bg-app-elevated/60 p-4">
          <p className="mb-2.5 text-[12.5px] font-semibold text-tx-primary">逾期与今日到期</p>
          {overdueItems.length === 0 ? (
            <p className="text-[11px] text-zinc-400">没有逾期工单</p>
          ) : (
            <div className="space-y-1">
              {overdueItems.map((item) => (
                <div key={item.id} className="flex items-center gap-2 text-[11px] text-tx-secondary">
                  <span className="shrink-0 font-mono text-[10px] text-zinc-400">#{item.itemNo ?? "—"}</span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className="shrink-0 text-[9.5px] text-zinc-400">{item.projectName}</span>
                  <span className="shrink-0 text-[9.5px] text-red-500">{item.dueDate <= todayIso ? "今日到期" : "已逾期"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-xl border border-app-border bg-app-elevated/60 p-4">
          <p className="mb-2.5 text-[12.5px] font-semibold text-tx-primary">最近动态</p>
          {recent.length === 0 ? (
            <p className="text-[11px] text-zinc-400">暂无动态</p>
          ) : (
            <div className="space-y-1.5">
              {recent.map((log, index) => (
                <div key={`${log.itemId}-${index}`} className="flex items-center gap-2 text-[11px] text-tx-secondary">
                  <span className="shrink-0 font-mono text-[10px] text-zinc-400">#{log.itemNo ?? "—"}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {log.title} · {formatLog(log)}
                  </span>
                  <span className="shrink-0 text-[9.5px] text-zinc-400">{new Date(log.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
