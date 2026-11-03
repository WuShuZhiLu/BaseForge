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
        className="shrink-0 border-b border-app-border bg-app-surface/80 px-0 backdrop-blur sm:px-4 lg:px-6"
        data-daily-records-header=""
      >
        {/* 标题行：与文件管理/分享中心/插件页同为 h-12 一条线 */}
        <div className="flex h-12 items-center gap-3 px-3 sm:px-4">
          <h1 className="shrink-0 text-[15px] font-semibold tracking-tight text-tx-primary">每日记录</h1>
          <span className="hidden min-w-0 truncate text-[11px] text-tx-tertiary sm:inline">瞬间负责捕获，日记负责整理</span>
          <nav
            className="ml-auto flex shrink-0 items-center gap-1.5"
            aria-label="每日记录视图"
            data-daily-records-views=""
          >
            {VIEW_OPTIONS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setView(key)}
                className={cn(
                  "inline-flex h-7 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors",
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

        {/* 工具条行：h-10，与其它模块的工具条同高 */}
        <div
          className="flex h-10 items-center gap-1.5 overflow-x-auto border-t border-app-border px-3 [scrollbar-width:none] sm:px-4 [&::-webkit-scrollbar]:hidden"
          data-daily-records-shortcuts=""
        >
          <button
            type="button"
            onClick={() => selectJournalDate(relativeLocalDateKey(0))}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] bg-accent-primary px-3 text-[11.5px] font-medium text-white transition-colors hover:bg-accent-primary/90"
          >
            <BookOpen size={13} />
            今天日记
          </button>
          <button
            type="button"
            onClick={() => void copyCurrentTime()}
            title="复制当前时间"
            aria-label="复制当前时间"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border border-app-border text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
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
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-app-border px-2.5 text-[11.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
            >
              <CalendarDays size={13} className="text-tx-tertiary" />
              {item.label}
            </button>
          ))}
          <label className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] border border-app-border px-2.5 text-[11.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary">
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
