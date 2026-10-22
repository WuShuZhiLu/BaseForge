import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PmWorkItemLog } from "@/types";
import { api } from "@/lib/api";

/** 活动流字段 → 展示名（含 M3 特殊记录） */
const FIELD_LABELS: Record<string, string> = {
  __created__: "创建工作项",
  title: "标题",
  description: "描述",
  status: "状态",
  priority: "优先级",
  dueDate: "截止日期",
  type: "类型",
  tags: "标签",
  noteId: "交付文档",
  gitRepo: "仓库",
  gitBranch: "分支",
  gitIssue: "平台工单",
  gitIssueState: "平台状态",
  parentId: "父工作项",
  noteLinked: "关联文档",
  noteUnlinked: "解除文档关联",
};

const STATUS_LABELS: Record<string, string> = {
  todo: "待处理",
  doing: "进行中",
  review: "待验证",
  done: "已完成",
  canceled: "已取消",
};

const PRIORITY_LABELS: Record<string, string> = {
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

/** 值翻译：状态/优先级显示人话，其余原样（null → 空）。 */
function displayValue(field: string, value: string | null): string {
  if (value === null) return "（空）";
  if (field === "status") return STATUS_LABELS[value] ?? value;
  if (field === "priority") return PRIORITY_LABELS[value] ?? value;
  if (field === "tags") {
    try {
      const parsed = JSON.parse(value) as string[];
      return Array.isArray(parsed) ? parsed.join("、") : value;
    } catch {
      return value;
    }
  }
  return value;
}

/** 工单类型/状态等 key 在 label 里出现时用括号原样保留，便于排查。 */
function formatLogLine(field: string, oldValue: string | null, newValue: string | null): string {
  if (field === "__created__") return `创建工作项「${newValue ?? ""}」`;
  const label = FIELD_LABELS[field] ?? field;
  const changed = `${displayValue(field, oldValue)} → ${displayValue(field, newValue)}`;
  return `${label}：${changed}`;
}

/** 活动流时间线（M3 B9）：item详情抽屉内的字段级变更历史。 */
export default function PmActivityTimeline({ itemId }: { itemId: string }) {
  const [logs, setLogs] = useState<PmWorkItemLog[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLogs(null);
    setError("");
    api
      .listPmItemLogs(itemId)
      .then((res) => {
        if (alive) setLogs(res.logs);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : "加载活动流失败");
      });
    return () => {
      alive = false;
    };
  }, [itemId]);

  return (
    <div className="mt-3 rounded-lg border border-zinc-200 p-2 dark:border-zinc-700">
      <p className="flex items-center gap-1 text-[11px] font-medium text-tx-secondary">活动流</p>
      {error ? (
        <p className="mt-1.5 text-[11px] text-red-500">{error}</p>
      ) : logs === null ? (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-zinc-400">
          <Loader2 size={11} className="animate-spin" /> 加载中…
        </p>
      ) : logs.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-zinc-400">暂无变更记录</p>
      ) : (
        <div className="mt-2 space-y-2">
          {logs.map((log, index) => (
            <div key={`${log.createdAt}-${index}`} className="flex gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-[11px] leading-4 text-tx-secondary">{formatLogLine(log.field, log.oldValue, log.newValue)}</p>
                <p className="text-[9px] text-zinc-400">{new Date(log.createdAt).toLocaleString()}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
