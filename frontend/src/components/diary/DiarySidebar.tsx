import React, { useMemo } from "react";
import { BarChart3, Calendar, ChevronRight, Smile, TrendingUp, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Diary, DiaryStats } from "@/types";

// 心情选项
const MOODS = [
  { value: "happy", emoji: "😊" },
  { value: "excited", emoji: "🥳" },
  { value: "peaceful", emoji: "😌" },
  { value: "thinking", emoji: "🤔" },
  { value: "tired", emoji: "😴" },
  { value: "sad", emoji: "😢" },
  { value: "angry", emoji: "😤" },
  { value: "sick", emoji: "🤒" },
  { value: "love", emoji: "🥰" },
  { value: "cool", emoji: "😎" },
  { value: "laugh", emoji: "🤣" },
  { value: "shock", emoji: "😱" },
];

function getMoodEmoji(mood: string): string {
  return MOODS.find((m) => m.value === mood)?.emoji || "";
}

function SectionHeading({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">
      <Icon size={12} className="shrink-0" />
      <span>{children}</span>
    </div>
  );
}

interface DiarySidebarProps {
  stats: DiaryStats | null;
  moodFilter: string;
  onMoodFilterChange: (mood: string) => void;
  onOpenCalendar: () => void;
  recentItems: Diary[];
}

/**
 * 说说模块右侧面板（桌面端）
 *
 * 分区小标题 + 紧凑块，不堆叠独立圆角大卡：
 * - 日历入口
 * - 统计
 * - 心情筛选
 * - 心情分布
 */
export default function DiarySidebar({
  stats,
  moodFilter,
  onMoodFilterChange,
  onOpenCalendar,
  recentItems,
}: DiarySidebarProps) {
  const { t } = useTranslation();

  // 统计心情分布
  const moodDistribution = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of recentItems) {
      if (item.mood) {
        counts[item.mood] = (counts[item.mood] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
  }, [recentItems]);

  return (
    <div className="space-y-5">
      {/* 日历入口 */}
      <button
        onClick={onOpenCalendar}
        className="flex w-full items-center gap-2 rounded-[8px] border border-app-border bg-app-surface px-2.5 py-2 text-left transition-colors hover:bg-app-hover"
      >
        <Calendar size={14} className="shrink-0 text-tx-tertiary" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11.5px] font-medium text-tx-primary">
            {t("diary.calendarTitle") || "日历视图"}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-tx-tertiary">
            {t("diary.calendarSubtitle", { defaultValue: "按日期浏览说说" })}
          </span>
        </span>
        <ChevronRight size={13} className="shrink-0 text-tx-tertiary" />
      </button>

      {/* 统计 */}
      {stats && (
        <section>
          <SectionHeading icon={BarChart3}>
            {t("diary.statsTitle", { defaultValue: "统计" })}
          </SectionHeading>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[8px] border border-app-border bg-app-border">
            <div className="bg-app-surface px-3 py-2">
              <div className="text-[15px] font-semibold tabular-nums leading-5 text-tx-primary">{stats.total}</div>
              <div className="mt-0.5 text-[11px] text-tx-tertiary">{t("diary.statsTotal", { defaultValue: "总计" })}</div>
            </div>
            <div className="bg-app-surface px-3 py-2">
              <div className="text-[15px] font-semibold tabular-nums leading-5 text-tx-primary">{stats.todayCount}</div>
              <div className="mt-0.5 text-[11px] text-tx-tertiary">{t("diary.statsToday", { defaultValue: "今日" })}</div>
            </div>
          </div>
        </section>
      )}

      {/* 心情筛选 */}
      <section>
        <SectionHeading icon={Smile}>
          {t("diary.moodFilterTitle", { defaultValue: "心情" })}
        </SectionHeading>
        <div className="grid grid-cols-4 gap-1">
          <button
            onClick={() => onMoodFilterChange("")}
            className={cn(
              "h-8 rounded-[6px] text-[11px] font-medium transition-colors",
              !moodFilter
                ? "bg-accent-primary/10 text-accent-primary"
                : "text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary",
            )}
          >
            {t("diary.filterMoodAll")}
          </button>
          {MOODS.map(({ value: v, emoji }) => (
            <button
              key={v}
              onClick={() => onMoodFilterChange(moodFilter === v ? "" : v)}
              className={cn(
                "grid h-8 place-items-center rounded-[6px] text-base transition-colors",
                moodFilter === v
                  ? "bg-accent-primary/10"
                  : "hover:bg-app-hover",
              )}
              title={t(`diary.mood${v.charAt(0).toUpperCase() + v.slice(1)}`)}
            >
              {emoji}
            </button>
          ))}
        </div>
      </section>

      {/* 心情分布（最近说说） */}
      {moodDistribution.length > 0 && (
        <section>
          <SectionHeading icon={TrendingUp}>
            {t("diary.moodDistribution", { defaultValue: "心情分布" })}
          </SectionHeading>
          <div className="space-y-1.5">
            {moodDistribution.map(([mood, count]) => (
              <div key={mood} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-center text-[13px] leading-4">{getMoodEmoji(mood)}</span>
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-app-hover">
                  <div
                    className="h-full rounded-full bg-accent-primary/50"
                    style={{ width: `${Math.min(100, (count / recentItems.length) * 100)}%` }}
                  />
                </div>
                <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-tx-tertiary">{count}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
