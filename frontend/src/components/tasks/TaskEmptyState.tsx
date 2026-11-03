import React from "react";
import { Inbox, Search, CalendarDays, FileText, BellOff, Link2, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export type TaskEmptyStateType =
  | "no-tasks"
  | "no-search"
  | "no-scheduled"
  | "no-templates"
  | "no-reminders"
  | "no-dependencies"
  | "no-projects";

interface TaskEmptyStateProps {
  type: TaskEmptyStateType;
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}

const ICONS: Record<TaskEmptyStateType, React.ReactNode> = {
  "no-tasks": <Inbox size={28} strokeWidth={1.5} />,
  "no-search": <Search size={28} strokeWidth={1.5} />,
  "no-scheduled": <CalendarDays size={28} strokeWidth={1.5} />,
  "no-templates": <FileText size={28} strokeWidth={1.5} />,
  "no-reminders": <BellOff size={28} strokeWidth={1.5} />,
  "no-dependencies": <Link2 size={28} strokeWidth={1.5} />,
  "no-projects": <FolderOpen size={28} strokeWidth={1.5} />,
};

const COMPACT_ICONS: Record<TaskEmptyStateType, React.ReactNode> = {
  "no-tasks": <Inbox size={20} strokeWidth={1.5} />,
  "no-search": <Search size={20} strokeWidth={1.5} />,
  "no-scheduled": <CalendarDays size={20} strokeWidth={1.5} />,
  "no-templates": <FileText size={20} strokeWidth={1.5} />,
  "no-reminders": <BellOff size={20} strokeWidth={1.5} />,
  "no-dependencies": <Link2 size={20} strokeWidth={1.5} />,
  "no-projects": <FolderOpen size={20} strokeWidth={1.5} />,
};

export function TaskEmptyState({ type, title, description, actionLabel, onAction, compact }: TaskEmptyStateProps) {
  const { t } = useTranslation();

  const resolvedTitle = title || t(`tasks.empty.${type}.title`);
  const resolvedDescription = description || t(`tasks.empty.${type}.description`);
  const resolvedAction = actionLabel || t(`tasks.empty.${type}.action`, { defaultValue: "" });

  return (
    <div className={cn(
      "flex flex-col items-center justify-center text-tx-tertiary",
      compact ? "px-4 py-5" : "px-4 py-10"
    )}>
      <div className="mb-2.5 opacity-70">
        {compact ? COMPACT_ICONS[type] : ICONS[type]}
      </div>
      <span className={cn("text-center font-medium text-tx-secondary", compact ? "text-[12px]" : "text-[13px]")}>
        {resolvedTitle}
      </span>
      {resolvedDescription && (
        <span className="mt-1 max-w-[280px] text-center text-[11px] text-tx-tertiary">
          {resolvedDescription}
        </span>
      )}
      {resolvedAction && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-3 rounded-[6px] border border-app-border bg-app-surface px-2.5 py-1 text-[11.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
        >
          {resolvedAction}
        </button>
      )}
    </div>
  );
}
