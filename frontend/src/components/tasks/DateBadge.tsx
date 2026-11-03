import { format, isToday, isPast, isTomorrow, isThisWeek, parseISO } from "date-fns";
import { zhCN, enUS } from "date-fns/locale";
import { Calendar } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 将 dueDate 字符串（YYYY-MM-DD）按本地日期解析为 Date 对象。
 * 避免 parseISO 在不同时区下的偏移问题。
 */
export function toLocalDate(dateStr: string): Date {
  const d = parseISO(dateStr);
  if (isNaN(d.getTime())) {
    const parts = dateStr.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  return d;
}

/**
 * 判断纯日期（YYYY-MM-DD）是否已逾期。
 * 规则：只有 dueDate 日期 < 今天本地日期才算逾期，今天截止不算逾期。
 */
export function isTaskDateOverdue(dueDate: string, dueAt?: string | null): boolean {
  // 有 dueAt 时按精确时间判断，否则按日期
  if (dueAt) {
    const dueTime = new Date(dueAt).getTime();
    return Date.now() > dueTime;
  }
  const d = toLocalDate(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d < today;
}

/* ===== 日期胶囊 ===== */
export function DateBadge({
  dateStr,
  dueAt,
  isCompleted = false,
}: {
  dateStr: string | null;
  dueAt?: string | null;
  isCompleted?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === "zh-CN" ? zhCN : enUS;
  if (!dateStr) return null;
  const d = toLocalDate(dateStr);
  const formatted = format(d, "M/d", { locale: dateLocale });

  let label: string;
  let cls: string;
  if (isCompleted) {
    // 已完成任务只展示日期本身，不再标红"已逾期"
    label = formatted;
    cls = "text-tx-tertiary";
  } else if (isToday(d)) {
    label = t('tasks.today');
    cls = "text-accent-primary";
  } else if (isTomorrow(d)) {
    label = t('tasks.tomorrow');
    cls = "text-tx-secondary";
  } else if (isPast(d) && !isToday(d)) {
    label = t('tasks.overdue');
    cls = "text-accent-danger";
  } else if (isThisWeek(d, { weekStartsOn: 1 })) {
    label = format(d, "EEEE", { locale: dateLocale });
    cls = "text-tx-secondary";
  } else {
    label = formatted;
    cls = "text-tx-tertiary";
  }

  // 如果有 dueAt，附加时间显示
  const timeStr = dueAt ? (dueAt.split("T")[1] || "") : "";
  const displayLabel = timeStr && !isToday(d) && !isTomorrow(d)
    ? label + " " + timeStr.slice(0, 5)
    : label;

  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[11px] tabular-nums", cls)}>
      <Calendar size={11} className="shrink-0 opacity-70" />
      {displayLabel}
    </span>
  );
}
