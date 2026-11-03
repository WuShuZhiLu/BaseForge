import React, { useEffect, useState } from "react";
import { Archive, Check, CircleSlash, Minus, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Habit, HabitCheckinStatus } from "@/types";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";

export function HabitRow({
  habit,
  onCheckin,
  onArchiveToggle,
  onDelete,
}: {
  habit: Habit;
  onCheckin: (habit: Habit, status: HabitCheckinStatus, note: string) => Promise<void> | void;
  onArchiveToggle: (habit: Habit, archived: boolean) => Promise<void> | void;
  onDelete: (habit: Habit) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(habit.todayNote || "");
  const [submitting, setSubmitting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canManage = (habit as Habit & { canManage?: boolean }).canManage !== false;
  const isArchived = !!habit.archivedAt;

  useEffect(() => {
    setNote(habit.todayNote || "");
  }, [habit.id, habit.todayNote]);

  const statusLabel: Record<HabitCheckinStatus, string> = {
    success: t("habits.status.success"),
    partial: t("habits.status.partial"),
    failure: t("habits.status.failure"),
  };

  const showActionError = (error: unknown) => {
    console.error("Habit action failed:", error);
    toast.error(error instanceof Error ? error.message : "操作失败，请稍后重试");
  };

  // 打卡按钮：默认描边，选中态 accent/10 + accent 文字
  const actionCls = (active: boolean) =>
    cn(
      "inline-flex items-center gap-1 rounded-[6px] border px-2 py-1 text-[11px] transition-colors disabled:opacity-50",
      active
        ? "border-accent-primary/30 bg-accent-primary/10 text-accent-primary"
        : "border-app-border bg-app-surface text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
    );

  const runCheckin = async (status: HabitCheckinStatus) => {
    if (!canManage || submitting || isArchived) return;
    setSubmitting(true);
    try {
      await onCheckin(habit, status, note);
    } catch (error) {
      showActionError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const runArchiveToggle = async (archived: boolean) => {
    if (!canManage || archiving) return;
    setArchiving(true);
    try {
      await onArchiveToggle(habit, archived);
    } catch (error) {
      showActionError(error);
      setArchiving(false);
    }
  };

  const runDelete = async () => {
    if (!canManage || deleting || archiving || submitting) return;
    setDeleting(true);
    try {
      await onDelete(habit);
    } catch (error) {
      showActionError(error);
      setDeleting(false);
    }
  };

  return (
    <div className="px-1 py-2.5 transition-colors hover:bg-app-hover/60">
      <div className="flex items-start gap-2.5">
        <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: habit.color || "#10b981" }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-[13px] font-medium text-tx-primary">{habit.title}</div>
            {habit.todayStatus && (
              <span className={cn(
                "text-[11px]",
                habit.todayStatus === "success" && "text-emerald-600 dark:text-emerald-400",
                habit.todayStatus === "partial" && "text-amber-600 dark:text-amber-400",
                habit.todayStatus === "failure" && "text-accent-danger",
              )}>
                {statusLabel[habit.todayStatus]}
              </span>
            )}
            {isArchived && (
              <span className="text-[11px] text-tx-tertiary">
                {t("habits.status.archived")}
              </span>
            )}
            {habit.creatorName && (
              <span className="text-[11px] text-tx-tertiary">{habit.creatorName}</span>
            )}
          </div>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={!canManage || submitting || archiving || deleting || isArchived}
            placeholder={t("habits.notePlaceholder")}
            className="mt-1.5 w-full rounded-[6px] border border-app-border bg-app-bg px-2 py-1 text-[11px] text-tx-primary placeholder:text-tx-tertiary focus:border-accent-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          {canManage && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {!isArchived ? (
                <>
                  <button
                    onClick={() => runCheckin("success")}
                    disabled={submitting || archiving || deleting}
                    className={actionCls(habit.todayStatus === "success")}
                  >
                    <Check size={12} /> {t("habits.actions.success")}
                  </button>
                  <button
                    onClick={() => runCheckin("partial")}
                    disabled={submitting || archiving || deleting}
                    className={actionCls(habit.todayStatus === "partial")}
                  >
                    <Minus size={12} /> {t("habits.actions.partial")}
                  </button>
                  <button
                    onClick={() => runCheckin("failure")}
                    disabled={submitting || archiving || deleting}
                    className={actionCls(habit.todayStatus === "failure")}
                  >
                    <CircleSlash size={12} /> {t("habits.actions.failure")}
                  </button>
                  <button
                    onClick={() => runArchiveToggle(true)}
                    disabled={submitting || archiving || deleting}
                    className="ml-auto inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[11px] text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-secondary disabled:opacity-50"
                  >
                    <Archive size={12} /> {t("habits.actions.archive")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => runArchiveToggle(false)}
                    disabled={submitting || archiving || deleting}
                    className={actionCls(false)}
                  >
                    <RotateCcw size={12} /> {t("habits.actions.unarchive")}
                  </button>
                </>
              )}
              <button
                onClick={runDelete}
                disabled={submitting || archiving || deleting}
                className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[11px] text-tx-tertiary transition-colors hover:bg-app-hover hover:text-accent-danger disabled:opacity-50"
              >
                <Trash2 size={12} /> {t("habits.actions.delete")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
