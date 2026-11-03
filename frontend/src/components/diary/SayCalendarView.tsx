import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Image, Video, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { Diary } from "@/types";
import { formatDateKey, getMonthGrid, groupDiariesByDate } from "@/lib/sayCalendar";
import SayCalendarDayPanel from "@/components/diary/SayCalendarDayPanel";

function getTodayKey(): string {
  const d = new Date();
  return formatDateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function monthLabel(year: number, month: number, t: (k: string) => string): string {
  const months = Array.from({ length: 12 }, (_, i) => t(`calendar.months.${i}`));
  return `${year} ${months[month - 1]}`;
}

export default function SayCalendarView({
  onClose,
  onWriteEntry,
  onLocateItem,
}: {
  onClose: () => void;
  onWriteEntry: () => void;
  onLocateItem: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(getTodayKey());
  const [items, setItems] = useState<Diary[]>([]);
  const [loading, setLoading] = useState(false);

  const grid = useMemo(() => getMonthGrid(year, month), [year, month]);
  const itemsByDate = useMemo(() => groupDiariesByDate(items) as Map<string, Diary[]>, [items]);

  const fetchMonthItems = useCallback(async () => {
    const from = formatDateKey(year, month, 1);
    const to = formatDateKey(year, month + 1, 0);
    setLoading(true);
    try {
      const data = await api.getDiaryTimeline(undefined, 200, { from, to });
      setItems(data.items || []);
    } catch (e) {
      console.error("Load calendar month failed:", e);
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    void fetchMonthItems();
  }, [fetchMonthItems]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const goPrev = () => {
    const d = new Date(year, month - 2, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setSelectedDateKey(null);
  };
  const goNext = () => {
    const d = new Date(year, month, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setSelectedDateKey(null);
  };
  const goToday = () => {
    const d = new Date();
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setSelectedDateKey(getTodayKey());
  };

  const weekLabels = [t("calendar.week.mon"), t("calendar.week.tue"), t("calendar.week.wed"), t("calendar.week.thu"), t("calendar.week.fri"), t("calendar.week.sat"), t("calendar.week.sun")];
  const todayKey = getTodayKey();
  const selectedItems = selectedDateKey ? itemsByDate.get(selectedDateKey) || [] : [];

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-app-bg">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-app-border bg-app-surface/40">
        <div className="flex items-center gap-1">
          <button
            onClick={onClose}
            className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-app-border px-2.5 text-[11.5px] font-medium text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
          >
            {t("diary.exitCalendar")}
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={goPrev}
            className="inline-flex h-6 w-6 items-center justify-center rounded-[4px] text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-secondary"
          >
            <ChevronLeft size={15} />
          </button>
          <div className="min-w-[110px] text-center text-[12.5px] font-medium text-tx-primary">
            {monthLabel(year, month, t)}
          </div>
          <button
            onClick={goNext}
            className="inline-flex h-6 w-6 items-center justify-center rounded-[4px] text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-secondary"
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <button
          onClick={goToday}
          className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-app-border px-2.5 text-[11.5px] font-medium text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
        >
          {t("diary.calendarToday")}
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-full text-tx-tertiary">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
            <div className="min-w-0">
              <div className="grid grid-cols-7 text-[11px] text-tx-tertiary mb-1">
                {weekLabels.map((label) => (
                  <div key={label} className="px-1 py-1 text-center">{label}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {grid.map((cell) => {
                  const cellItems = itemsByDate.get(cell.dateKey) || [];
                  const count = cellItems.length;
                  const isSelected = selectedDateKey === cell.dateKey;
                  const isToday = todayKey === cell.dateKey;
                  const previewItems = cellItems.slice(0, 3);

                  return (
                    <button
                      key={cell.dateKey}
                      onClick={() => setSelectedDateKey(cell.dateKey)}
                      className={cn(
                        "group relative flex flex-col items-start p-2 min-h-[72px] sm:min-h-[88px] rounded-[8px] border transition-colors",
                        isSelected
                          ? "border-accent-primary/40 bg-accent-primary/5"
                          : "border-app-border/60 bg-app-surface/30 hover:border-accent-primary/30 hover:bg-app-surface/50"
                      )}
                    >
                      <div className="flex w-full items-center justify-between">
                        <span
                          className={cn(
                            "text-[11px] font-medium",
                            !cell.isCurrentMonth
                              ? "text-tx-tertiary/60"
                              : isToday
                                ? "text-accent-primary"
                                : "text-tx-primary"
                          )}
                        >
                          {cell.date}
                        </span>
                        {count > 0 && (
                          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-accent-primary/10 text-accent-primary tabular-nums">
                            {count}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex w-full flex-col gap-0.5 overflow-hidden max-h-[42px] sm:max-h-[56px]">
                        {previewItems.map((item) => (
                          <div key={item.id} className="flex items-center gap-1 text-[10px] text-tx-secondary truncate">
                            <span className="truncate">{item.contentText?.slice(0, 10) || t("diary.media")}</span>
                            {(item.images?.length > 0 || (item.media || []).some((m) => m.type === "image")) && <Image size={10} className="shrink-0 text-tx-tertiary/70" />}
                            {(item.media || []).some((m) => m.type === "video") && <Video size={10} className="shrink-0 text-tx-tertiary/70" />}
                          </div>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="hidden lg:block">
              <SayCalendarDayPanel
                dateKey={selectedDateKey || ""}
                items={selectedItems}
                onWriteEntry={onWriteEntry}
                onLocateItem={onLocateItem}
              />
            </div>
          </div>
        )}
      </div>

      <div className="lg:hidden border-t border-app-border bg-app-surface/40">
        <SayCalendarDayPanel
          dateKey={selectedDateKey || ""}
          items={selectedItems}
          onWriteEntry={onWriteEntry}
          onLocateItem={onLocateItem}
        />
      </div>
    </div>
  );
}
