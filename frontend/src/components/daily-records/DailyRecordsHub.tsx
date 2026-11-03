import React, { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  Clock3,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";

import DiaryWorkspaceImpl from "@/components/DiaryWorkspaceImpl";
import DiaryExperienceBridge from "@/components/diary/DiaryExperienceBridge";
import SayCalendarView from "@/components/diary/SayCalendarView";
import DailyJournalView from "@/components/daily-records/DailyJournalView";
import JournalPrivacyGate from "@/components/daily-records/JournalPrivacyGate";
import { getCurrentWorkspace } from "@/lib/api";
import {
  formatCurrentTimestamp,
  loadDailyRecordsView,
  relativeLocalDateKey,
  saveDailyRecordsView,
  type DailyRecordsView,
} from "@/lib/dailyRecords";
import { resolveJournalScope, type JournalScope } from "@/lib/journalScope";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { ToolPageHeaderMode } from "@/lib/toolPage";

/** 页签契约：页面自带标题行（每日记录 header），宿主顶栏无需重复渲染。 */
export const TOOL_PAGE_HEADER_MODE: ToolPageHeaderMode = "own";
import "@/components/daily-records/daily-records-mobile.css";

const VIEW_OPTIONS: Array<{
  key: DailyRecordsView;
  label: string;
  icon: LucideIcon;
}> = [
  { key: "moments", label: "瞬间", icon: MessageCircle },
  { key: "calendar", label: "日历", icon: CalendarDays },
  { key: "journal", label: "日记", icon: BookOpen },
];

export default function DailyRecordsHub() {
  const [view, setViewState] = useState<DailyRecordsView>(() => loadDailyRecordsView());
  const [selectedDate, setSelectedDate] = useState(() => relativeLocalDateKey(0));
  const [workspaceId, setWorkspaceId] = useState(() => getCurrentWorkspace());
  const [journalScope, setJournalScope] = useState<JournalScope>(() => resolveJournalScope());
  const momentRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const syncWorkspace = () => {
      const nextWorkspace = getCurrentWorkspace();
      setWorkspaceId(nextWorkspace);
      setJournalScope(resolveJournalScope(nextWorkspace));
    };
    window.addEventListener("nowen:workspace-changed", syncWorkspace);
    return () => window.removeEventListener("nowen:workspace-changed", syncWorkspace);
  }, []);

  const setView = (next: DailyRecordsView) => {
    setViewState(next);
    saveDailyRecordsView(next);
  };

  const selectJournalDate = (dateKey: string) => {
    setSelectedDate(dateKey);
    setView("journal");
  };

  const copyCurrentTime = async () => {
    const value = formatCurrentTimestamp();
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`已复制 ${value}`);
    } catch {
      toast.info(value);
    }
  };

  const activeWorkspaceId = workspaceId && workspaceId !== "personal" ? workspaceId : null;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-bg"
      data-daily-records-hub=""
    >
      <header
        className="shrink-0 border-b border-app-border bg-app-surface/80 px-0 pt-2.5 backdrop-blur sm:px-4 sm:pt-3 lg:px-6"
        data-daily-records-header=""
      >
        <div className="mx-auto w-full max-w-[1320px] px-4 sm:px-0">
          <div className="flex flex-col items-stretch gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-sm font-semibold tracking-tight text-tx-primary">每日记录</h1>
              <p className="mt-0.5 text-[11px] text-tx-tertiary">瞬间负责捕获，日记负责整理</p>
            </div>
            <nav
              className="flex w-full items-center gap-1.5 sm:w-auto"
              aria-label="每日记录视图"
              data-daily-records-views=""
            >
              {VIEW_OPTIONS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  className={cn(
                    "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors sm:h-7 sm:flex-none",
                    view === key
                      ? "border-accent-primary/30 bg-accent-primary/10 text-accent-primary"
                      : "border-app-border text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary",
                  )}
                  aria-current={view === key ? "page" : undefined}
                >
                  <Icon size={13} className="shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div
            className="-mx-4 mt-2 flex flex-wrap items-center gap-1.5 px-4 pb-2.5 sm:mx-0 sm:px-0"
            data-daily-records-shortcuts=""
          >
            <button
              type="button"
              onClick={() => selectJournalDate(relativeLocalDateKey(0))}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] bg-accent-primary px-3 text-[11.5px] font-medium text-white transition-colors hover:bg-accent-primary/90 sm:h-7"
            >
              <BookOpen size={13} />
              今天日记
            </button>
            <button
              type="button"
              onClick={() => void copyCurrentTime()}
              title="复制当前时间"
              aria-label="复制当前时间"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-app-border text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary sm:h-7 sm:w-7"
            >
              <Clock3 size={13} />
            </button>
            {[
              { label: "昨天", offset: -1 },
              { label: "今天", offset: 0 },
              { label: "明天", offset: 1 },
              { label: "后天", offset: 2 },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => selectJournalDate(relativeLocalDateKey(item.offset))}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-app-border px-2.5 text-[11.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary sm:h-7"
              >
                <CalendarDays size={13} className="text-tx-tertiary" />
                {item.label}
              </button>
            ))}
            <label className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] border border-app-border px-2.5 text-[11.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary sm:h-7">
              <CalendarDays size={13} className="text-tx-tertiary" />
              选择日期
              <input
                type="date"
                value={selectedDate}
                onChange={(event) => event.target.value && selectJournalDate(event.target.value)}
                className="sr-only"
              />
            </label>
          </div>
        </div>
      </header>

      {view === "moments" && (
        <div
          ref={momentRootRef}
          className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
          data-daily-records-moments=""
        >
          <DiaryWorkspaceImpl />
          <DiaryExperienceBridge rootRef={momentRootRef} />
        </div>
      )}

      {view === "calendar" && (
        <SayCalendarView
          onClose={() => setView("moments")}
          onWriteEntry={() => setView("moments")}
          onLocateItem={() => setView("moments")}
        />
      )}

      {view === "journal" && (
        <JournalPrivacyGate
          scope={journalScope}
          activeWorkspaceId={activeWorkspaceId}
          onUseWorkspace={() => {
            if (activeWorkspaceId) setJournalScope(resolveJournalScope(activeWorkspaceId));
          }}
        >
          <DailyJournalView
            selectedDate={selectedDate}
            onDateChange={setSelectedDate}
            onWriteMoment={() => setView("moments")}
            journalScope={journalScope}
            onJournalScopeChange={setJournalScope}
            activeWorkspaceId={activeWorkspaceId}
          />
        </JournalPrivacyGate>
      )}
    </div>
  );
}
