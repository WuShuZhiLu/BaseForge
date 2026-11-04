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
    // 同步侧栏高亮（侧栏「视图」分区监听）
    window.dispatchEvent(new CustomEvent("nowen:diary-view-changed", { detail: { view: next } }));
  };

  const selectJournalDate = (dateKey: string) => {
    setSelectedDate(dateKey);
    setView("journal");
  };

  // 侧栏是唯一导航层：模式与日期筛选由侧栏驱动（主区头部不再重复这两组控件）
  useEffect(() => {
    const onView = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: string }>).detail;
      if (detail?.view && VIEW_OPTIONS.some((option) => option.key === detail.view)) setView(detail.view as DailyRecordsView);
    };
    const onDate = (event: Event) => {
      const detail = (event as CustomEvent<{ date?: string }>).detail;
      if (detail?.date) selectJournalDate(detail.date);
    };
    window.addEventListener("nowen:diary-set-view", onView);
    window.addEventListener("nowen:diary-open-date", onDate);
    return () => {
      window.removeEventListener("nowen:diary-set-view", onView);
      window.removeEventListener("nowen:diary-open-date", onDate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        {/* 标题行：与文件管理/分享中心/插件页同为 h-12 一条线。
            模式切换与日期筛选已上移侧栏（唯一导航层）；顶栏放高频动作「复制当前时间」。 */}
        <div className="flex h-12 items-center gap-3 px-3 sm:px-4">
          <h1 className="shrink-0 text-[15px] font-semibold tracking-tight text-tx-primary">每日记录</h1>
          <span className="hidden min-w-0 truncate text-[11px] text-tx-tertiary sm:inline">瞬间负责捕获，日记负责整理</span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void copyCurrentTime()}
              title="复制当前时间"
              className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-app-border px-2.5 text-[11.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
            >
              <Clock3 size={13} />
              复制当前时间
            </button>
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
