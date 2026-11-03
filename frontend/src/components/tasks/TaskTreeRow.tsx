import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2, Circle, Flag, ChevronRight, ChevronDown,
  Trash2, User as UserIcon, Plus, Repeat, Link2, Bell,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { getCurrentWorkspace } from "@/lib/api";
import type { Task, TaskPriority } from "@/types";
import { isRepeatingTask } from "./taskRepeatUtils";
import type { TaskTreeNode } from "./taskProgress";
import { calculateTaskProgress } from "./taskProgress";
import { TitleView } from "./taskTitleTokens";
import { DateBadge } from "./DateBadge";
import { SubtaskInput } from "./SubtaskInput";
import { hasEnabledReminder } from "./taskReminderUtils";

/* ===== Tree task row ===== */
export const TaskTreeRow = React.forwardRef<HTMLDivElement, {
  task: TaskTreeNode;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
  onToggle: (id: string) => void;
  onSelect: (task: Task) => void;
  onDelete: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onCreateChild: (title: string, parentId: string) => Promise<void>;
  blockedByDependency?: boolean;
}>(({
  task,
  depth,
  isExpanded,
  hasChildren,
  onToggle,
  onSelect,
  onDelete,
  onToggleExpand,
  onCreateChild,
  blockedByDependency,
}, ref) => {
  const { t } = useTranslation();
  const isCompleted = task.isCompleted === 1;
  const [showSubtaskInput, setShowSubtaskInput] = useState(false);

  const PRIORITY_CONFIG: Record<number, { label: string; color: string; flagClass: string }> = {
    3: { label: t('tasks.high'), color: "text-red-500", flagClass: "text-red-500" },
    2: { label: t('tasks.medium'), color: "text-amber-500", flagClass: "text-amber-500" },
    1: { label: t('tasks.low'), color: "text-blue-400", flagClass: "text-blue-400" },
  };
  const pri = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG[2];
  const descriptionPreview = (task.description ?? "").trim();

  const showCreator =
    !!task.creatorName && getCurrentWorkspace() !== "personal";

  const progressInfo = hasChildren ? calculateTaskProgress(task) : null;
  const indentPx = Math.min(depth, 6) * 24;

  return (
    <>
      <motion.div
        ref={ref}
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, x: -20, transition: { duration: 0.15 } }}
        style={{ paddingLeft: `${indentPx}px` }}
        className={cn(
          "group flex min-h-10 w-full min-w-0 cursor-pointer items-start gap-2 py-2 pr-2 transition-colors",
          isCompleted ? "opacity-60" : "hover:bg-app-hover"
        )}
        onClick={() => onSelect(task)}
      >
        {/* Expand/collapse arrow */}
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleExpand(task.id); }}
            className="mt-0.5 flex-shrink-0 rounded p-0.5 text-tx-tertiary transition-colors hover:bg-app-hover"
            title={isExpanded ? t('tasks.collapse') : t('tasks.expand')}
          >
            {isExpanded
              ? <ChevronDown size={14} className="text-tx-tertiary" />
              : <ChevronRight size={14} className="text-tx-tertiary" />}
          </button>
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}

        {/* Checkbox */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(task.id); }}
          className="mt-0.5 flex-shrink-0 transition-colors"
          aria-pressed={isCompleted}
        >
          {isCompleted ? (
            <CheckCircle2 size={15} className="text-accent-primary" />
          ) : (
            <Circle size={15} className="text-tx-tertiary transition-colors group-hover:text-accent-primary" />
          )}
        </button>

        {/* Title + metadata */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "text-[13px] leading-relaxed break-words [overflow-wrap:anywhere] line-clamp-2 transition-all",
              isCompleted ? "line-through text-tx-tertiary" : "text-tx-primary"
            )}
            title={task.title}
          >
            <TitleView title={task.title} compact isCompleted={isCompleted} />
          </span>
          {descriptionPreview && (
            <p className="text-[11px] leading-snug line-clamp-1 break-words [overflow-wrap:anywhere] text-tx-tertiary">
              {descriptionPreview}
            </p>
          )}
          {(task.dueDate || showCreator) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 md:hidden">
              <DateBadge dateStr={task.dueDate} dueAt={task.dueAt} isCompleted={isCompleted} />
              {showCreator && (
                <span
                  className="flex min-w-0 items-center gap-1 text-[11px] text-tx-tertiary"
                  title={t('common.createdBy', { name: task.creatorName })}
                >
                  <UserIcon size={11} className="shrink-0" />
                  <span className="truncate">{task.creatorName}</span>
                </span>
              )}
            </div>
          )}
          {showCreator && (
            <span
              className="hidden items-center gap-1 truncate text-[11px] text-tx-tertiary md:flex"
              title={t('common.createdBy', { name: task.creatorName })}
            >
              <UserIcon size={11} className="shrink-0" />
              <span className="truncate">{task.creatorName}</span>
            </span>
          )}
        </div>

        {/* Right side badges */}
        <div className="mt-0.5 flex flex-shrink-0 items-center gap-1.5">
          {/* Action buttons (visible on hover) */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowSubtaskInput(true);
              if (!isExpanded && hasChildren) onToggleExpand(task.id);
            }}
            className="flex-shrink-0 rounded p-0.5 text-tx-tertiary opacity-100 transition-all hover:bg-app-hover hover:text-accent-primary md:opacity-0 md:group-hover:opacity-100"
            title={t('tasks.addChild')}
          >
            <Plus size={14} />
          </button>
          {progressInfo && (
            <div className="hidden items-center gap-1.5 sm:flex" title={`${progressInfo.completedChildren}/${progressInfo.totalChildren}`}>
              <span className="whitespace-nowrap text-[10px] tabular-nums text-tx-tertiary">
                {progressInfo.completedChildren}/{progressInfo.totalChildren}
              </span>
              <div className="h-1 w-12 overflow-hidden rounded-full bg-app-border">
                <div
                  className="h-full rounded-full bg-accent-primary transition-all duration-300"
                  style={{ width: `${progressInfo.progress}%` }}
                />
              </div>
            </div>
          )}
          <span className="hidden md:inline-flex">
            <DateBadge dateStr={task.dueDate} dueAt={task.dueAt} isCompleted={isCompleted} />
          </span>
          {hasEnabledReminder(task) && <span title={t("tasks.reminder.title")}><Bell size={12} className="text-tx-tertiary" /></span>}
          {isRepeatingTask(task) && <span title={t(`tasks.repeat.${task.repeatRule}`)}><Repeat size={12} className="text-tx-tertiary" /></span>}
          {blockedByDependency && !task.isCompleted && <span title={t("tasks.dependencies.blockedByIncomplete")}><Link2 size={12} className="text-accent-warning" /></span>}
          <Flag
            size={13}
            className={cn(
              pri.flagClass,
              task.priority < 3 && "md:opacity-0 md:group-hover:opacity-100",
              "transition-opacity",
            )}
          />
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
            className="hidden text-tx-tertiary transition-all hover:text-accent-danger md:inline-flex md:opacity-0 md:group-hover:opacity-100"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </motion.div>

      {/* Inline subtask input */}
      <AnimatePresence>
        {showSubtaskInput && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            style={{ paddingLeft: `${indentPx}px` }}
          >
            <SubtaskInput
              parentId={task.id}
              onSubmit={onCreateChild}
              onCancel={() => setShowSubtaskInput(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
});

TaskTreeRow.displayName = "TaskTreeRow";
