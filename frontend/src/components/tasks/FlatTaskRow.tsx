import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2, Circle, Flag, Trash2, User as UserIcon, Plus, Repeat, Link2, Bell,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { getCurrentWorkspace } from "@/lib/api";
import type { Task } from "@/types";
import { TitleView } from "./taskTitleTokens";
import { DateBadge } from "./DateBadge";
import { isRepeatingTask } from "./taskRepeatUtils";
import { SubtaskInput } from "./SubtaskInput";
import { hasEnabledReminder } from "./taskReminderUtils";

/**
 *  allTasks 中向上遍历 parentId 构建父任务路径).
 * 最多展示maxDepth 层，超出时"..." 省略).
 */
function buildParentPath(taskId: string, allTasks: Task[], maxDepth = 3): Task[] {
  const map = new Map(allTasks.map((t) => [t.id, t]));
  const path: Task[] = [];
  let currentId: string | null = taskId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const task = map.get(currentId);
    if (!task?.parentId) break;
    const parent = map.get(task.parentId);
    if (!parent) break;
    path.unshift(parent);
    if (path.length >= maxDepth) break;
    currentId = parent.parentId;
  }
  return path;
}

/** Flat task row (used in filtered mode) */
export const FlatTaskRow = React.forwardRef<HTMLDivElement, {
  task: Task;
  /** All tasks (for building parent task path / breadcrumb) */
  allTasks?: Task[];
  onToggle: (id: string) => void;
  onSelect: (task: Task) => void;
  onDelete: (id: string) => void;
  onCreateChild?: (title: string, parentId: string) => Promise<void>;
  onSelectTask?: (taskId: string) => void;
  blockedByDependency?: boolean;
}>(({ task, allTasks, onToggle, onSelect, onDelete, onCreateChild, onSelectTask, blockedByDependency }, ref) => {
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

  // Parent task breadcrumb path
  const parentPath = useMemo(() => {
    if (!allTasks || !task.parentId) return [];
    return buildParentPath(task.id, allTasks);
  }, [task.id, task.parentId, allTasks]);

  return (
    <>
      <motion.div
        ref={ref}
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, x: -20, transition: { duration: 0.15 } }}
        className={cn(
          "group flex min-h-10 w-full min-w-0 cursor-pointer items-start gap-2.5 px-2 py-2 transition-colors",
          isCompleted ? "opacity-60" : "hover:bg-app-hover"
        )}
        onClick={() => onSelect(task)}
      >
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

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Parent task breadcrumb */}
          {parentPath.length > 0 && (
            <div className="mb-0.5 flex min-w-0 items-center gap-1 text-[11px] text-tx-tertiary">
              {parentPath.map((p, i) => (
                <React.Fragment key={p.id}>
                  {i > 0 && <span className="opacity-50">/</span>}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectTask?.(p.id);
                    }}
                    className="hover:text-accent-primary hover:underline truncate max-w-[80px] transition-colors"
                    title={p.title}
                  >
                    {p.title.length > 12 ? p.title.slice(0, 12) + "…" : p.title}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}

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

        <div className="mt-0.5 flex flex-shrink-0 items-center gap-1.5">
          {/* Add subtask button */}
          {onCreateChild && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowSubtaskInput(true); }}
              className="flex-shrink-0 rounded p-0.5 text-tx-tertiary opacity-100 transition-all hover:bg-app-hover hover:text-accent-primary md:opacity-0 md:group-hover:opacity-100"
              title={t('tasks.addChild')}
            >
              <Plus size={14} />
            </button>
          )}
          <span className="hidden md:inline-flex">
            <DateBadge dateStr={task.dueDate} dueAt={task.dueAt} isCompleted={isCompleted} />
          </span>
          {hasEnabledReminder(task) && <span title={t("tasks.reminder.title")}><Bell size={12} className="text-tx-tertiary" /></span>}
          {isRepeatingTask(task) && <span title={t(`tasks.repeat.${task.repeatRule}`)}><Repeat size={12} className="text-tx-tertiary" /></span>}
          {blockedByDependency && !isCompleted && <span title={t("tasks.dependencies.blockedByIncomplete")}><Link2 size={12} className="text-accent-warning" /></span>}
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

      {/* Inline 子任务输入框 */}
      <AnimatePresence>
        {showSubtaskInput && onCreateChild && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
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

FlatTaskRow.displayName = "FlatTaskRow";
