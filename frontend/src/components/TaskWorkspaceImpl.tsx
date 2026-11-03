import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { AnimatePresence } from "framer-motion";
import {
  Calendar, ListTodo,
  CalendarDays, AlertTriangle, CheckCheck, Inbox,
  Search, X as XIcon, GripVertical,
  CheckSquare, Trash2, Square,
  LayoutGrid, LayoutList, Calendar as CalendarIcon, BarChart3, ChevronRight, Bell, Maximize2, Minimize2,
  MoreHorizontal, Trash2 as TrashIcon, FileText, ClipboardPlus, Sun, CalendarClock,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Task, TaskFilter, TaskStats, TaskStatus, TaskProject, TaskDependency, Habit, HabitStats, HabitCheckinStatus, HabitCheckinListItem } from "@/types";
import { cn } from "@/lib/utils";
import { isTaskBlockedByDependency } from "./tasks/taskDependencyUtils";
import {
  TASK_CENTER_MAIN_CLASS,
  TASK_WORKSPACE_ROOT_CLASS,
  TASK_MOBILE_FILTER_BAR_CLASS,
} from "@/lib/taskLayout";
import { useToolPageActive } from "@/lib/toolPage";

// sub-components & utilities
import { useTaskTree } from "./tasks/useTaskTree";
import { buildTaskTree } from "./tasks/taskProgress";
import type { TaskTreeNode } from "./tasks/taskProgress";
import { TaskTreeRow } from "./tasks/TaskTreeRow";
import { TaskQuickAdd } from "./tasks/TaskQuickAdd";
import { TaskEmptyState } from "./tasks/TaskEmptyState";
import { TaskDetailPanel } from "./tasks/TaskDetailPanel";
import { FlatTaskRow } from "./tasks/FlatTaskRow";
import { useTaskProjects } from "./tasks/useTaskProjects";
import { TaskBoardView } from "./tasks/TaskBoardView";
import { TaskCalendarView } from "./tasks/TaskCalendarView";
import TaskGanttView from "./tasks/TaskGanttView";
import { compareTasksByDueTime, moveTaskToDate } from "./tasks/taskDateUtils";
import { haveSameTaskCompletionState, orderTasksCompletedLast } from "./tasks/taskCompletionOrder";
import { TaskTemplatePicker } from "./tasks/TaskTemplatePicker";
import { ReminderCenter } from "./tasks/ReminderCenter";
import { TaskCalendarFeedSettings } from "./tasks/TaskCalendarFeedSettings";
import { CalendarExportTargetSettings } from "./tasks/CalendarExportTargetSettings";
import { MobileProjectTrigger, MobileProjectPicker } from "./tasks/MobileProjectPicker";
import { taskMatchesSearch } from "./tasks/taskSearch";
import { parseTaskQuickAdd, type TaskQuickAddParseResult } from "./tasks/taskSmartRecognition";
import { resolveTaskQuickAddDraft, type TaskQuickAddManualMeta } from "./tasks/taskQuickAddDraft";
import { loadTaskViewMode, saveTaskViewMode, type TaskViewMode } from "./tasks/taskViewMode";
import { loadTaskDueSort, saveTaskDueSort } from "./tasks/taskDueSortPreference";
import { HabitStatsOverview } from "./tasks/HabitStatsOverview";
import { HabitRow } from "./tasks/HabitRow";
import { StatsCenter } from "./tasks/StatsCenter";
import { TaskInboxPanel } from "./tasks/TaskInboxPanel";
import { MyDayPanel } from "./tasks/MyDayPanel";
import { TaskTimePlanner } from "./tasks/TaskTimePlanner";
import { openTaskQuickCapture } from "@/lib/taskInboxApi";
import { consumePendingTaskNotificationTaskId } from "@/lib/taskNotifications";
import { TASK_NOTIFICATION_OPEN_EVENT } from "@/lib/taskNotificationSchedule";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { isTaskCenterModuleVisible } from "@/lib/navigationVisibility";
import { confirm } from "@/components/ui/confirm";

/* ===== Filter 导航契约（应用侧栏与主区共享）=====
 * 应用侧栏按这里的 key 发 nowen:task-filter-select { key } 事件，
 * 主区监听后切换对应筛选；labelKey 供侧栏渲染同名 i18n 文案。
 */
export const FILTERS: { key: TaskFilter; labelKey: string; icon: React.ReactNode }[] = [
  { key: "all", labelKey: "tasks.allTasks", icon: <Inbox size={14} /> },
  { key: "today", labelKey: "tasks.today", icon: <CalendarDays size={14} /> },
  { key: "week", labelKey: "tasks.next7Days", icon: <Calendar size={14} /> },
  { key: "overdue", labelKey: "tasks.overdue", icon: <AlertTriangle size={14} /> },
  { key: "completed", labelKey: "tasks.completed", icon: <CheckCheck size={14} /> },
];

export function formatLocalDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getDefaultTaskPatchForFilter(filter: TaskFilter): Partial<Task> {
  if (filter === "today") {
    return { dueDate: formatLocalDateKey() };
  }
  return {};
}

function getQuickAddCreatePatch(parsed: TaskQuickAddParseResult): Partial<Task> {
  const patch: Partial<Task> & { repeatRuleJson?: unknown } = { ...parsed.taskPatch };
  if (patch.repeatRule === "custom" && typeof patch.repeatRuleJson === "string") {
    try {
      patch.repeatRuleJson = JSON.parse(patch.repeatRuleJson);
    } catch {
      delete patch.repeatRuleJson;
    }
  }
  return patch as Partial<Task>;
}

/* ===== Main Component ===== */
export default function TaskWorkspace(_props: { hideSidebar?: boolean } = {}) {
  const { t } = useTranslation();
  const { prefs: userPrefs } = useUserPreferences();

  type CenterMode = "inbox" | "tasks" | "my-day" | "planner" | "habits" | "stats";
  type HabitListMode = "active" | "archived" | "all";

  // 主区渲染用：由模块级 FILTERS 派生（label 走当前语言）
  const filterItems = FILTERS.map((f) => ({ key: f.key, label: t(f.labelKey), icon: f.icon }));

  // 统一筛选 chips / 按钮：选中 accent-primary/10 + accent 文字，未选中描边
  const chipCls = (active: boolean) =>
    cn(
      "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] transition-colors",
      active
        ? "border-accent-primary/30 bg-accent-primary/10 font-medium text-accent-primary"
        : "border-app-border bg-app-surface text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
    );
  const primaryBtnCls =
    "inline-flex items-center gap-1.5 rounded-[6px] bg-accent-primary px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40";
  const secondaryBtnCls =
    "inline-flex items-center gap-1.5 rounded-[6px] border border-app-border bg-app-surface px-2.5 py-1 text-[11.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary disabled:opacity-40";

  const selectTaskFilter = (nextFilter: TaskFilter) => {
    setCenterMode("tasks");
    setFilter(nextFilter);
    setSelectedTaskId(null);
    setSearchQuery("");
    setSelectedProjectId(null);
  };

  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [centerMode, setCenterMode] = useState<CenterMode>("tasks");

  // 侧栏迷你面板 chips → 主区切换对应视图
  useEffect(() => {
    const onNavigate = (event: Event) => {
      const target = (event as CustomEvent<{ target: string }>).detail?.target;
      if (target === "inbox") { setCenterMode("inbox"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }
      else if (target === "today") { setCenterMode("tasks"); selectTaskFilter("today"); }
      else if (target === "all") { setCenterMode("tasks"); selectTaskFilter("all"); }
    };
    window.addEventListener("nowen:task-panel-navigate", onNavigate);
    return () => window.removeEventListener("nowen:task-panel-navigate", onNavigate);
  }, []);

  useEffect(() => {
    if (!isTaskCenterModuleVisible(centerMode, userPrefs.hiddenTaskCenterModules)) {
      setCenterMode("tasks");
    }
  }, [centerMode, userPrefs.hiddenTaskCenterModules]);

  const [habits, setHabits] = useState<Habit[]>([]);
  const [habitStats, setHabitStats] = useState<HabitStats | null>(null);
  const [habitListMode, setHabitListMode] = useState<HabitListMode>("active");
  const [newHabitTitle, setNewHabitTitle] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingOrphansRef = useRef<string[]>([]);

  // Phase 4: search
  const [searchQuery, setSearchQuery] = useState("");
  const [workspaceVersion, setWorkspaceVersion] = useState(0);

  const [statsTasks, setStatsTasks] = useState<Task[]>([]);
  const [statsHabits, setStatsHabits] = useState<Habit[]>([]);
  const [statsHabitCheckins, setStatsHabitCheckins] = useState<HabitCheckinListItem[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const statsLoadGenerationRef = useRef(0);

  const activeHabits = useMemo(
    () => habits.filter((habit) => !habit.archivedAt),
    [habits],
  );

  const archivedHabits = useMemo(
    () => habits.filter((habit) => !!habit.archivedAt),
    [habits],
  );

  const visibleHabits = useMemo(() => {
    if (habitListMode === "archived") return archivedHabits;
    if (habitListMode === "all") return habits;
    return activeHabits;
  }, [activeHabits, archivedHabits, habitListMode, habits]);

  const pendingHabitCount = useMemo(
    () => activeHabits.filter((habit) => !habit.todayStatus).length,
    [activeHabits],
  );

  // Phase 5.2: dependencies
  const [dependencies, setDependencies] = useState<TaskDependency[]>([]);

  // Phase 4: projects
  const {
    projects,
    selectedProjectId,
    setSelectedProjectId,
    createProject,
    updateProject,
    deleteProject,
    refreshCounts,
    reload,
  } = useTaskProjects();

  const openTaskFromNotification = useCallback((taskId: string) => {
    if (!taskId) return;
    setCenterMode("tasks");
    setFilter("all");
    setSearchQuery("");
    setSelectedProjectId(null);
    setSelectedTaskId(taskId);
  }, [setSelectedProjectId]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId || "";
      openTaskFromNotification(taskId);
    };
    window.addEventListener(TASK_NOTIFICATION_OPEN_EVENT, onOpen);
    const pendingTaskId = consumePendingTaskNotificationTaskId();
    if (pendingTaskId) queueMicrotask(() => openTaskFromNotification(pendingTaskId));
    return () => window.removeEventListener(TASK_NOTIFICATION_OPEN_EVENT, onOpen);
  }, [openTaskFromNotification]);

  // 聚焦某项目：应用侧栏事件与移动端项目选择共用（原内部左栏项目行点击逻辑）
  const focusTaskProject = useCallback((projectId: string) => {
    if (!projects.some((p) => p.id === projectId)) return;
    setCenterMode("tasks");
    setSelectedProjectId(projectId);
    setFilter("all");
    setSelectedTaskId(null);
    setSearchQuery("");
  }, [projects, setSelectedProjectId]);

  // 应用侧栏导航事件 → 主区：切换筛选 / 聚焦项目
  useEffect(() => {
    const onFilterSelect = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      if (!key || !FILTERS.some((f) => f.key === key)) return;
      selectTaskFilter(key as TaskFilter);
    };
    const onFocusProject = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (!projectId) return;
      focusTaskProject(projectId);
    };
    window.addEventListener("nowen:task-filter-select", onFilterSelect);
    window.addEventListener("nowen:task-focus-project", onFocusProject);
    return () => {
      window.removeEventListener("nowen:task-filter-select", onFilterSelect);
      window.removeEventListener("nowen:task-focus-project", onFocusProject);
    };
  }, [focusTaskProject]);

  const [viewMode, setViewMode] = useState<TaskViewMode>(loadTaskViewMode);
  const changeViewMode = (mode: TaskViewMode) => {
    setViewMode(mode);
    saveTaskViewMode(mode);
  };

  // Phase 4: new project dialog
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [editingProject, setEditingProject] = useState<TaskProject | null>(null);
  const [editProjectName, setEditProjectName] = useState("");
  const [editProjectColor, setEditProjectColor] = useState("#6366f1");
  const [showProjectMenu, setShowProjectMenu] = useState<string | null>(null);
  const [mobileProjectOpen, setMobileProjectOpen] = useState(false);
  const isMobile = typeof navigator !== "undefined" && /Mobi|Android/i.test(navigator.userAgent);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showReminderCenter, setShowReminderCenter] = useState(false);
  const [taskFullscreen, setTaskFullscreen] = useState(false);
  const [reminderBadgeCount, setReminderBadgeCount] = useState(0);
  const [sortByDueTime, setSortByDueTime] = useState(loadTaskDueSort);
  useEffect(() => { saveTaskDueSort(sortByDueTime); }, [sortByDueTime]);
  const toggleDueSort = () => setSortByDueTime((previous) => !previous);

  // Phase 4: batch select mode
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Phase 4: drag state
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const treeSourceTasks = useMemo(() => {
    const roots = tasks.filter((task) => !task.parentId);
    const children = tasks.filter((task) => task.parentId);
    return [
      ...orderTasksCompletedLast(roots, sortByDueTime ? compareTasksByDueTime : undefined),
      ...orderTasksCompletedLast(children, sortByDueTime ? compareTasksByDueTime : undefined),
    ];
  }, [tasks, sortByDueTime]);

  // tree hook
  const {
    flatOrderedTasks,
    expandedTaskIds,
    toggleExpand,
    isTreeMode,
  } = useTaskTree(treeSourceTasks, filter);

  // getDescendantIds with cycle protection
  const getDescendantIds = useCallback((rootId: string, taskList: Task[], visited = new Set<string>()): string[] => {
    if (visited.has(rootId)) return [];
    visited.add(rootId);
    const ids: string[] = [rootId];
    const children = taskList.filter((t) => t.parentId === rootId);
    for (const child of children) {
      ids.push(...getDescendantIds(child.id, taskList, visited));
    }
    return ids;
  }, []);

  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    return tasks.find((t) => t.id === selectedTaskId) || null;
  }, [selectedTaskId, tasks]);

  const selectedTreeNode = useMemo<TaskTreeNode | null>(() => {
    if (!selectedTaskId || !isTreeMode) return null;
    const tree = buildTaskTree(tasks);
    const findNode = (nodes: TaskTreeNode[]): TaskTreeNode | null => {
      for (const n of nodes) {
        if (n.id === selectedTaskId) return n;
        const found = findNode(n.children);
        if (found) return found;
      }
      return null;
    };
    return findNode(tree);
  }, [selectedTaskId, tasks, isTreeMode]);

  // filtered tasks by search query
  const displayTasks = useMemo(() => {
    const source = searchQuery.trim() ? tasks.filter((t) => taskMatchesSearch(t, searchQuery)) : tasks;
    if (viewMode !== "list") {
      return sortByDueTime ? [...source].sort(compareTasksByDueTime) : source;
    }
    return orderTasksCompletedLast(
      source,
      sortByDueTime ? compareTasksByDueTime : undefined,
    );
  }, [tasks, searchQuery, sortByDueTime, viewMode]);

  // recompute flatOrdered for display (search-filtered)
  const displayFlatOrdered = useMemo(() => {
    if (!searchQuery.trim()) return flatOrderedTasks;
    return flatOrderedTasks.filter((item) => taskMatchesSearch(item.node, searchQuery));
  }, [flatOrderedTasks, searchQuery]);

  const loadTasks = useCallback(async () => {
    try {
      const [data, statsData] = await Promise.all([
        api.getTasks(filter, undefined, selectedProjectId || undefined),
        api.getTaskStats(),
      ]);
      setTasks(data);
      setStats(statsData);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setIsLoading(false);
    }
  }, [filter, selectedProjectId, workspaceVersion]);

  const loadHabits = useCallback(async () => {
    try {
      const checkinDate = formatLocalDateKey();
      const [list, statsData] = await Promise.all([
        api.getHabits(true, checkinDate),
        api.getHabitStats(true, checkinDate),
      ]);
      setHabits(list);
      setHabitStats(statsData);
    } catch (err) {
      console.error("Failed to load habits:", err);
    }
  }, []);

  const loadStatsCenter = useCallback(async () => {
    const generation = ++statsLoadGenerationRef.current;
    try {
      setStatsLoading(true);
      const checkinDate = formatLocalDateKey();
      const [taskList, taskStatsData, habitList, habitStatsData, habitCheckins] = await Promise.all([
        api.getTasks("all"),
        api.getTaskStats(),
        api.getHabits(true, checkinDate),
        api.getHabitStats(true, checkinDate),
        api.getHabitCheckinLog({ includeArchived: true }),
      ]);
      if (generation !== statsLoadGenerationRef.current) return;
      setStatsTasks(taskList);
      setStats(taskStatsData);
      setStatsHabits(habitList);
      setHabitStats(habitStatsData);
      setStatsHabitCheckins(habitCheckins);
    } catch (err) {
      console.error("Failed to load stats center:", err);
      toast.error(t("stats.loadFailed"));
    } finally {
      if (generation === statsLoadGenerationRef.current) setStatsLoading(false);
    }
  }, [t]);

  const loadDependencies = useCallback(async () => {
    try {
      const deps = await api.getTaskDependencies();
      setDependencies(deps);
    } catch (e) { /* ignore */ }
  }, []);

  const loadReminderBadge = useCallback(async () => {
    try {
      const data = await api.getReminderOverview(7);
      setReminderBadgeCount(data.missed.length + data.today.length);
    } catch { /* ignore */ }
  }, []);

  const handleReminderCountChange = useCallback((taskId: string, activeCount: number) => {
    setTasks((prev) => prev.map((task) => (
      task.id === taskId ? { ...task, activeReminderCount: activeCount } : task
    )));
    loadReminderBadge();
  }, [loadReminderBadge]);

  useEffect(() => { loadTasks(); loadDependencies(); loadReminderBadge(); loadHabits(); }, [loadTasks, loadDependencies, loadReminderBadge, loadHabits]);

  // 隐藏态治理：keepAlive 非激活页签期间任务/提醒数据可能过期，重新激活时补一次刷新。
  const pageRootRef = useRef<HTMLDivElement>(null);
  const pageActive = useToolPageActive(pageRootRef);
  const previousPageActiveRef = useRef(true);
  useEffect(() => {
    if (previousPageActiveRef.current === pageActive) return;
    previousPageActiveRef.current = pageActive;
    if (pageActive) {
      loadTasks();
      loadReminderBadge();
      refreshCounts();
    }
  }, [pageActive, loadTasks, loadReminderBadge, refreshCounts]);

  useEffect(() => {
    const onWs = () => {
      setSelectedTaskId(null);
      setSearchQuery("");
      setSelectedIds(new Set());
      setSelectMode(false);
      setSelectedProjectId(null);
      setWorkspaceVersion((v) => v + 1);
      reload();
      loadHabits();
      if (centerMode === "stats") void loadStatsCenter();
    };
    window.addEventListener("nowen:workspace-changed", onWs);
    return () => window.removeEventListener("nowen:workspace-changed", onWs);
  }, [centerMode, loadHabits, loadStatsCenter, loadTasks]);

  useEffect(() => {
    if (centerMode === "stats") {
      loadStatsCenter();
    }
  }, [centerMode, loadStatsCenter]);

  const handleCreateHabit = async (): Promise<boolean> => {
    const title = newHabitTitle.trim();
    if (!title) return false;
    try {
      const checkinDate = formatLocalDateKey();
      const habit = await api.createHabit({ title });
      setHabits((prev) => [habit, ...prev]);
      setNewHabitTitle("");
      const statsData = await api.getHabitStats(true, checkinDate);
      setHabitStats(statsData);
      return true;
    } catch (err) {
      console.error("Failed to create habit:", err);
      toast.error(t("habits.toast.createFailed"));
      return false;
    }
  };

  const handleHabitCheckin = async (habit: Habit, status: HabitCheckinStatus, note: string) => {
    const checkinDate = formatLocalDateKey();
    const updated = await api.checkInHabit(habit.id, { status, note, checkinDate });
    setHabits((prev) => prev.map((item) => (
      item.id === habit.id
        ? { ...item, todayStatus: updated.status, todayNote: updated.note, todayCheckinDate: updated.checkinDate }
        : item
    )));
    const statsData = await api.getHabitStats(true, checkinDate);
    setHabitStats(statsData);
    toast.success(t("habits.toast.checkinUpdated"));
  };

  const handleArchiveHabitToggle = async (habit: Habit, archived: boolean) => {
    const checkinDate = formatLocalDateKey();
    const updated = await api.archiveHabit(habit.id, archived);
    setHabits((prev) => prev.map((item) => (item.id === habit.id ? { ...item, ...updated } : item)));
    const statsData = await api.getHabitStats(true, checkinDate);
    setHabitStats(statsData);
    toast.success(archived ? t("habits.toast.archived") : t("habits.toast.unarchived"));
  };

  const handleDeleteHabit = async (habit: Habit) => {
    await api.deleteHabit(habit.id);
    setHabits((prev) => prev.filter((item) => item.id !== habit.id));
    const statsData = await api.getHabitStats(true, formatLocalDateKey());
    setHabitStats(statsData);
    toast.success(t("habits.toast.deleted"));
  };

  // === Keyboard shortcuts ===
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;

      if (e.key === "Escape") {
        if (selectMode) { setSelectMode(false); setSelectedIds(new Set()); return; }
        if (selectedTaskId) { setSelectedTaskId(null); return; }
        if (searchQuery) { setSearchQuery(""); return; }
      }
      if (isInput) return;

      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectMode, selectedTaskId, searchQuery]);

  // === CRUD Handlers ===
  const handleToggle = async (id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, isCompleted: t.isCompleted ? 0 : 1, status: t.isCompleted ? "todo" : "done" } : t))
    );
    try {
      const res = await api.toggleTask(id);
      // Use backend response for accurate state
      setTasks((prev) => {
        let updated = prev.map((t) => (t.id === id ? { ...t, ...res.task } : t));
        if (res.generatedTask) updated = [...updated, res.generatedTask];
        return updated;
      });
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch { loadTasks(); }
  };

  const handleCreate = async (orphanIds: string[] = [], manual: TaskQuickAddManualMeta = {}): Promise<boolean> => {
    if (!newTitle.trim()) return false;
    const titleToCreate = newTitle.trim();
    const parsed = resolveTaskQuickAddDraft(titleToCreate, getDefaultTaskPatchForFilter(filter), manual);
    const createPatch = getQuickAddCreatePatch(parsed);
    const taskTitle = parsed.cleanTitle || titleToCreate;
    try {
      const task = await api.createTask({
        title: taskTitle,
        projectId: selectedProjectId || undefined,
        ...createPatch,
      });
      setTasks((prev) => [task, ...prev]);
      setNewTitle("");
      inputRef.current?.focus();
      if (orphanIds.length) {
        await Promise.all(
          orphanIds.map((id) => api.taskAttachments.bind(id, task.id).catch(() => null))
        );
      }
      if (parsed.reminderOffsets.length) {
        await Promise.all(
          parsed.reminderOffsets.map((offset) =>
            api.createTaskReminder(task.id, offset).catch(() => null)
          )
        );
      }
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
      return true;
    } catch (err) {
      console.error("Failed to create task:", err);
      return false;
    }
  };

  const handleCreateChild = async (title: string, parentId: string): Promise<void> => {
    const childTitleToCreate = title.trim();
    const childParsed = parseTaskQuickAdd(childTitleToCreate);
    const childCreatePatch = getQuickAddCreatePatch(childParsed);
    const childTaskTitle = childParsed.cleanTitle || childTitleToCreate;
    try {
      // Inherit projectId from parent, or use selectedProjectId
      const parentTask = tasks.find((t) => t.id === parentId);
      const childProjectId = parentTask?.projectId || selectedProjectId || undefined;
      const task = await api.createTask({
        title: childTaskTitle,
        parentId,
        projectId: childProjectId,
        ...childCreatePatch,
      });
      setTasks((prev) => [task, ...prev]);
      if (childParsed.reminderOffsets.length) {
        await Promise.all(
          childParsed.reminderOffsets.map((offset) =>
            api.createTaskReminder(task.id, offset).catch(() => null)
          )
        );
      }
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch (err) {
      console.error("Failed to create child task:", err);
      toast.error(t("tasks.toast.createFailed"));
    }
  };

  const handleDelete = async (id: string) => {
    const descendantIds = getDescendantIds(id, tasks);
    if (descendantIds.length > 1) {
      const ok = await confirm({
        title: t("tasks.confirmDeleteWithChildren", { count: descendantIds.length - 1 }),
        confirmText: t("common.delete"),
        danger: true,
      });
      if (!ok) return;
    }
    setTasks((prev) => prev.filter((t) => !descendantIds.includes(t.id)));
    if (selectedTaskId && descendantIds.includes(selectedTaskId)) {
      setSelectedTaskId(null);
    }
    try {
      await api.deleteTask(id);
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch { toast.error(t("tasks.toast.deleteFailed")); loadTasks(); }
  };

  const handleUpdate = async (id: string, data: Partial<Task>) => {
    const isDescriptionUpdate = Object.prototype.hasOwnProperty.call(data, "description");
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...data } : t)));
    try {
      const res = await api.updateTask(id, data);
      if (res.task) setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...res.task } : t)));
      if (res.generatedTask) setTasks((prev) => {
        if (prev.some((t) => t.id === res.generatedTask!.id)) return prev;
        return [...prev, res.generatedTask!];
      });
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
      if (isDescriptionUpdate) toast.success(t("tasks.toast.descriptionUpdated"));
    } catch {
      if (isDescriptionUpdate) toast.error(t("tasks.toast.descriptionUpdateFailed"));
      loadTasks();
    }
  };

  // === Status change (kanban) ===
  const handleStatusChange = async (id: string, status: TaskStatus) => {
    const newIsCompleted = status === "done" ? 1 : 0;
    setTasks((prev) => prev.map((t) => t.id === id ? { ...t, status, isCompleted: newIsCompleted } : t));
    try {
      const res = await api.updateTask(id, { status, isCompleted: newIsCompleted });
      if (res.task) setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...res.task } : t)));
      if (res.generatedTask) setTasks((prev) => {
        if (prev.some((t) => t.id === res.generatedTask!.id)) return prev;
        return [...prev, res.generatedTask!];
      });
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch { loadTasks(); }
  };

  // === Calendar drag: move task to new date ===
  const handleMoveTaskDate = async (taskId: string, targetDateKey: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const patch = moveTaskToDate(task, targetDateKey);
    if (!patch) return; // same date, no-op

    // Optimistic update
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
    try {
      await api.updateTask(taskId, patch);
      await loadTasks();
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch { loadTasks(); }
  };

  // === Gantt drag: move task date range ===
  const handleUpdateTaskDateRange = async (taskId: string, patch: { startDate?: string | null; dueDate?: string | null }) => {
    // Optimistic update
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
    try {
      await api.updateTask(taskId, patch);
      await loadTasks();
    } catch { toast.error(t("tasks.toast.updateFailed")); loadTasks(); }
  };

  // === Create project ===
  const handleCreateProject = async (nameOverride?: string) => {
    const name = nameOverride || newProjectName.trim();
    if (!name) return;
    const p = await createProject(name);
    if (p) {
      setSelectedProjectId(p.id);
      setNewProjectName("");
      setShowNewProject(false);
    }
  };

  const handleDeleteProject = async (id: string) => {
    const ok = await confirm({
      title: t("tasks.deleteProjectConfirm"),
      confirmText: t("tasks.deleteProject"),
      danger: true,
    });
    if (!ok) return;
    await deleteProject(id);
    if (selectedProjectId === id) setSelectedProjectId(null);
    setShowProjectMenu(null);
  };

  const handleUpdateProject = async () => {
    if (!editingProject || !editProjectName.trim()) return;
    await updateProject(editingProject.id, { name: editProjectName.trim(), color: editProjectColor });
    setEditingProject(null);
    setShowProjectMenu(null);
  };

  // === Batch operations ===
  const toggleSelectId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    const allIds = new Set(flatOrderedTasks.map((t) => t.node.id));
    setSelectedIds(allIds);
  }, [flatOrderedTasks]);

  const handleDeselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleBatchComplete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setTasks((prev) => prev.map((t) => ids.includes(t.id) ? { ...t, isCompleted: 1, status: "done" as const } : t));
    setSelectMode(false);
    setSelectedIds(new Set());
    try {
      await api.batchTasks(ids, "complete");
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch (err: any) { const detail = err?.message || err?.error || ""; toast.error(detail ? `${t("tasks.toast.bulkCompleteFailed")}: ${detail}` : t("tasks.toast.bulkCompleteFailed")); loadTasks(); }
  };

  const handleBatchDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    // Collect all descendants
    const idsToRemove = new Set<string>();
    for (const id of ids) {
      for (const did of getDescendantIds(id, tasks)) {
        idsToRemove.add(did);
      }
    }
    if (idsToRemove.size > ids.length) {
      const ok = await confirm({
        title: t("tasks.confirmDeleteWithChildren", { count: idsToRemove.size - ids.length }),
        confirmText: t("common.delete"),
        danger: true,
      });
      if (!ok) return;
    }
    setTasks((prev) => prev.filter((t) => !idsToRemove.has(t.id)));
    if (selectedTaskId && idsToRemove.has(selectedTaskId)) setSelectedTaskId(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    try {
      await api.batchTasks(ids, "delete");
      const s = await api.getTaskStats();
      setStats(s);
      refreshCounts();
    } catch (err: any) { const detail = err?.message || err?.error || ""; toast.error(detail ? `${t("tasks.toast.bulkDeleteFailed")}: ${detail}` : t("tasks.toast.bulkDeleteFailed")); loadTasks(); }
  };

  // === Drag reorder ===
  const handleDragStart = useCallback((id: string, e: React.DragEvent) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    const img = document.createElement("div");
    img.style.opacity = "0";
    document.body.appendChild(img);
    e.dataTransfer.setDragImage(img, 0, 0);
    requestAnimationFrame(() => document.body.removeChild(img));
  }, []);

  const handleDragOver = useCallback((id: string, e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (id !== dragOverId) setDragOverId(id);
  }, [dragOverId]);

  const handleDrop = useCallback(async (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); setDragOverId(null); return; }
    if (sortByDueTime) { setDragId(null); setDragOverId(null); return; }

    const dragTask = tasks.find((t) => t.id === dragId);
    const targetTask = tasks.find((t) => t.id === targetId);
    if (!dragTask || !targetTask) { setDragId(null); setDragOverId(null); return; }
    if ((dragTask.parentId ?? null) !== (targetTask.parentId ?? null)) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    if (!haveSameTaskCompletionState(dragTask, targetTask)) {
      setDragId(null);
      setDragOverId(null);
      return;
    }

    const siblings = tasks
      .filter((t) => (t.parentId ?? null) === (dragTask.parentId ?? null))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (b.createdAt || "").localeCompare(a.createdAt || ""));
    const without = siblings.filter((t) => t.id !== dragId);
    const targetIdx = without.findIndex((t) => t.id === targetId);
    if (targetIdx < 0) { setDragId(null); setDragOverId(null); return; }
    const reordered = [...without];
    reordered.splice(targetIdx, 0, dragTask);
    const items = reordered.map((task, index) => ({ id: task.id, sortOrder: index }));
    const orderMap = new Map(items.map((item) => [item.id, item.sortOrder]));

    setTasks((prev) => {
      const updated = prev.map((task) =>
        orderMap.has(task.id) ? { ...task, sortOrder: orderMap.get(task.id)! } : task
      );
      const siblingIds = new Set(items.map((item) => item.id));
      const firstSiblingIndex = updated.findIndex((task) => siblingIds.has(task.id));
      if (firstSiblingIndex < 0) return updated;
      const nonSiblings = updated.filter((task) => !siblingIds.has(task.id));
      const reorderedSiblings = items
        .map((item) => updated.find((task) => task.id === item.id))
        .filter((task): task is Task => !!task);
      const result = [...nonSiblings];
      result.splice(firstSiblingIndex, 0, ...reorderedSiblings);
      return result;
    });

    try {
      await api.reorderTasks(items);
    } catch { loadTasks(); }

    setDragId(null);
    setDragOverId(null);
  }, [dragId, tasks, sortByDueTime, loadTasks]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverId(null);
  }, []);

  // filter count helper
  const filterCount = (key: TaskFilter): number => {
    if (!stats) return 0;
    switch (key) {
      case "all": return stats.total;
      case "today": return stats.today;
      case "week": return stats.week;
      case "overdue": return stats.overdue;
      case "completed": return stats.completed;
      default: return 0;
    }
  };

  // Esc 键退出全屏
  useEffect(() => {
    if (!taskFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTaskFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [taskFullscreen]);

  return (
    <div ref={pageRootRef} className={cn(TASK_WORKSPACE_ROOT_CLASS, "min-h-0 flex-1", taskFullscreen && "fixed inset-0 z-[80] bg-app-bg")}>
      {/* Center: Task List */}
      <div className={TASK_CENTER_MAIN_CLASS}>
        {/* Mobile: horizontal filter bar —— 单行 chips，选中态 accent/10 + accent 文字 */}
        <div className={TASK_MOBILE_FILTER_BAR_CLASS}>
          <button
            style={{ display: isTaskCenterModuleVisible("inbox", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("inbox"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={chipCls(centerMode === "inbox")}
          >
            <Inbox size={12} /> {t("tasks.inbox", { defaultValue: "收集箱" })}
          </button>
          {filterItems.map((f) => (
            <button
              key={f.key}
              onClick={() => selectTaskFilter(f.key)}
              className={chipCls(centerMode === "tasks" && filter === f.key)}
            >
              <span className="[&>svg]:h-3 [&>svg]:w-3">{f.icon}</span>
              {f.label}
              <span className={cn(
                "min-w-3 text-center text-[10px] tabular-nums",
                centerMode === "tasks" && filter === f.key ? "text-accent-primary" : "text-tx-tertiary"
              )}>
                {filterCount(f.key)}
              </span>
            </button>
          ))}
          <button
            style={{ display: isTaskCenterModuleVisible("my-day", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("my-day"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={chipCls(centerMode === "my-day")}
          >
            <Sun size={12} /> {t("tasks.myDay", { defaultValue: "我的一天" })}
          </button>
          <button
            style={{ display: isTaskCenterModuleVisible("planner", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("planner"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={chipCls(centerMode === "planner")}
          >
            <CalendarClock size={12} /> {t("tasks.timePlanning", { defaultValue: "时间规划" })}
          </button>
          <button
            style={{ display: isTaskCenterModuleVisible("habits", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("habits"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={chipCls(centerMode === "habits")}
          >
            <ListTodo size={12} />
            {t("habits.title")}
            <span className={cn(
              "min-w-3 text-center text-[10px] tabular-nums",
              centerMode === "habits" ? "text-accent-primary" : "text-tx-tertiary"
            )}>
              {pendingHabitCount}
            </span>
          </button>
          <button
            style={{ display: isTaskCenterModuleVisible("stats", userPrefs.hiddenTaskCenterModules) ? undefined : "none" }}
            onClick={() => { setCenterMode("stats"); setSelectedTaskId(null); setSearchQuery(""); setSelectedProjectId(null); }}
            className={chipCls(centerMode === "stats")}
          >
            <BarChart3 size={12} />
            {t("stats.title")}
          </button>
          {centerMode === "tasks" && (
            <>
              {/* Mobile project trigger */}
              <MobileProjectTrigger
                selectedProjectId={selectedProjectId}
                projects={projects}
                onClick={() => setMobileProjectOpen(true)}
                t={t}
              />
              {/* 移动端依次切换列表、看板、日历、时间线，并记住选择。 */}
              <button
                onClick={() => changeViewMode(viewMode === "list" ? "board" : viewMode === "board" ? "calendar" : viewMode === "calendar" ? "timeline" : "list")}
                className={cn(chipCls(false), "px-2")}
                title={viewMode === "list" ? t("tasks.boardView") : viewMode === "board" ? t("tasks.calendarView") : viewMode === "calendar" ? t("tasks.timelineView") : t("tasks.listView")}
                aria-label={t("tasks.view", { defaultValue: "视图" })}
              >
                {viewMode === "list" ? <LayoutGrid size={12} /> : viewMode === "board" ? <CalendarIcon size={12} /> : viewMode === "calendar" ? <CalendarClock size={12} /> : <LayoutList size={12} />}
              </button>
            </>
          )}
        </div>

        {centerMode === "habits" && !isLoading && (
          <HabitStatsOverview stats={habitStats} />
        )}

        {/* Header desktop with batch controls */}
        {centerMode === "tasks" ? (
          <div className="hidden items-center gap-3 border-b border-app-border px-5 py-2.5 md:flex">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[14px] font-semibold text-tx-primary">
                {selectedProjectId
                  ? projects.find((p) => p.id === selectedProjectId)?.name || t("tasks.allTasks")
                  : filterItems.find((f) => f.key === filter)?.label || t("tasks.allTasks")}
              </h1>
              <p className="mt-0.5 text-[11px] text-tx-tertiary">
                {t("tasks.visibleTaskCount", { count: displayTasks.length, defaultValue: `${displayTasks.length} 条任务` })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {selectMode ? (
                <>
                  <span className="text-[11px] text-tx-tertiary">{t("tasks.selectedCount", { count: selectedIds.size })}</span>
                  <button
                    onClick={selectedIds.size === flatOrderedTasks.length ? handleDeselectAll : handleSelectAll}
                    className={secondaryBtnCls}
                  >
                    <CheckSquare size={12} />
                    {selectedIds.size === flatOrderedTasks.length ? t("tasks.deselectAll") : t("tasks.selectAll")}
                  </button>
                  <button
                    onClick={handleBatchComplete}
                    disabled={selectedIds.size === 0}
                    className={secondaryBtnCls}
                  >
                    <CheckSquare size={12} /> {t("tasks.batchComplete")}
                  </button>
                  <button
                    onClick={handleBatchDelete}
                    disabled={selectedIds.size === 0}
                    className={cn(secondaryBtnCls, "text-accent-danger hover:text-accent-danger")}
                  >
                    <Trash2 size={12} /> {t("tasks.batchDelete")}
                  </button>
                  <button
                    onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                    className="px-2 py-1 text-[11.5px] text-tx-tertiary transition-colors hover:text-tx-secondary"
                  >
                    {t("tasks.batchCancel")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => openTaskQuickCapture({ sourceType: "manual" })}
                    className={primaryBtnCls}
                  >
                    <ClipboardPlus size={12} />
                    {t("tasks.quickCaptureToInbox", { defaultValue: "快速捕获" })}
                  </button>
                  <label className="inline-flex items-center gap-1.5 rounded-[6px] border border-app-border bg-app-surface px-2 py-1 text-[11.5px] text-tx-secondary">
                    <span className="text-tx-tertiary">{t("tasks.view", { defaultValue: "视图" })}</span>
                    <select
                      value={viewMode}
                      onChange={(event) => changeViewMode(event.target.value as TaskViewMode)}
                      className="bg-transparent text-[11.5px] text-tx-primary outline-none"
                    >
                      <option value="list">{t("tasks.listView")}</option>
                      <option value="board">{t("tasks.boardView")}</option>
                      <option value="calendar">{t("tasks.calendarView")}</option>
                      <option value="timeline">{t("tasks.timelineView")}</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={toggleDueSort}
                    aria-pressed={sortByDueTime}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-[6px] border px-2 py-1 text-[11.5px] transition-colors",
                      sortByDueTime
                        ? "border-accent-primary/30 bg-accent-primary/10 font-medium text-accent-primary"
                        : "border-app-border bg-app-surface text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                    )}
                    title={sortByDueTime ? t("tasks.backToManualOrder") : t("tasks.sortByDueTime")}
                  >
                    <CalendarDays size={12} />
                    <span>{sortByDueTime ? t("tasks.dueSoonFirst") : t("tasks.sortByDueTime")}</span>
                  </button>
                  <button
                    onClick={() => setSelectMode(true)}
                    className="rounded-[6px] p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
                    title={t("tasks.selectMode")}
                  >
                    <CheckSquare size={13} />
                  </button>
                  <button
                    onClick={() => setTaskFullscreen((v) => !v)}
                    className="rounded-[6px] p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
                    title={taskFullscreen ? t("tasks.exitFullscreen") : t("tasks.enterFullscreen")}
                  >
                    {taskFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                  </button>
                </>
              )}
            </div>
          </div>
        ) : centerMode === "habits" ? (
          <div className="hidden items-center justify-between gap-3 border-b border-app-border px-5 py-2.5 md:flex">
            <h1 className="text-[14px] font-semibold text-tx-primary">{t("habits.title")}</h1>
            <p className="min-w-0 truncate text-[11px] text-tx-tertiary">{t("habits.summary")}</p>
          </div>
        ) : centerMode === "stats" ? (
          <div className="hidden items-center justify-between gap-3 border-b border-app-border px-5 py-2.5 md:flex">
            <h1 className="text-[14px] font-semibold text-tx-primary">{t("stats.title")}</h1>
            <p className="min-w-0 truncate text-[11px] text-tx-tertiary">{t("stats.subtitle")}</p>
          </div>
        ) : null}

        {/* Search bar */}
        {centerMode === "tasks" ? (
          <div className="flex items-center gap-2 border-b border-app-border px-4 py-1.5 md:px-5">
            <Search size={13} className="shrink-0 text-tx-tertiary" />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("tasks.searchPlaceholder")}
              className="flex-1 bg-transparent text-[13px] text-tx-primary placeholder:text-tx-tertiary focus:outline-none"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="text-tx-tertiary transition-colors hover:text-tx-secondary">
                <XIcon size={13} />
              </button>
            )}
          </div>
        ) : centerMode === "habits" ? (
          <div className="flex items-center gap-2 border-b border-app-border px-4 py-1.5 md:px-5">
            <div className="flex flex-1 items-center gap-1.5">
              <input
                type="text"
                value={newHabitTitle}
                onChange={(e) => setNewHabitTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateHabit(); }}
                placeholder={t("habits.createPlaceholder")}
                className="flex-1 rounded-[6px] border border-app-border bg-app-bg px-2.5 py-1.5 text-[13px] text-tx-primary placeholder:text-tx-tertiary focus:border-accent-primary focus:outline-none"
              />
              <button
                onClick={handleCreateHabit}
                className={primaryBtnCls}
              >
                {t("habits.add")}
              </button>
            </div>
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
              {(["active", "archived", "all"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setHabitListMode(mode)}
                  className={chipCls(habitListMode === mode)}
                >
                  {mode === "active" ? t("habits.filters.active") : mode === "archived" ? t("habits.filters.archived") : t("habits.filters.all")}
                </button>
              ))}
            </div>
          </div>
        ) : centerMode === "stats" ? (
          <div className="border-b border-app-border px-4 py-1.5 text-[11px] text-tx-tertiary md:px-5">
            {t("stats.summaryHint")}
          </div>
        ) : null}

        {/* Quick Add */}
        {centerMode === "tasks" && (
          <div className="px-4 md:px-5 py-2 border-b border-app-border">
            <TaskQuickAdd
              value={newTitle}
              onChange={setNewTitle}
              onSubmit={handleCreate}
              defaults={getDefaultTaskPatchForFilter(filter)}
              inputRef={inputRef}
            />
            <div className="mt-2 flex items-center justify-between gap-2 md:justify-end">
              {/* In compact layouts the desktop sorting control is not visible. */}
              <button
                type="button"
                onClick={toggleDueSort}
                aria-pressed={sortByDueTime}
                className={cn(chipCls(sortByDueTime), "md:hidden")}
                title={sortByDueTime ? t("tasks.backToManualOrder") : t("tasks.sortByDueTime")}
              >
                <CalendarDays size={12} />
                <span>{sortByDueTime ? t("tasks.dueSoonFirst") : t("tasks.sortByDueTime")}</span>
              </button>
              <details className="group relative">
                <summary className={cn(secondaryBtnCls, "cursor-pointer list-none")}>
                  <MoreHorizontal size={12} />
                  {t("tasks.moreTools", { defaultValue: "更多工具" })}
                  {reminderBadgeCount > 0 && (
                    <span className="min-w-4 rounded-full bg-accent-primary/10 px-1 text-center text-[9px] leading-4 tabular-nums text-accent-primary">
                      {reminderBadgeCount}
                    </span>
                  )}
                </summary>
                <div className="absolute right-0 top-full z-30 mt-1 flex w-52 flex-col gap-0.5 rounded-[10px] border border-app-border bg-app-surface p-1.5 shadow-lg">
                  <button
                    type="button"
                    onClick={() => setShowTemplatePicker(true)}
                    className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[11.5px] text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                  >
                    <FileText size={12} /> {t("tasks.templates.button")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowReminderCenter(true)}
                    className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[11.5px] text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                  >
                    <Bell size={12} /> {t("tasks.reminderCenter.open")}
                  </button>
                  <div className="mt-0.5 border-t border-app-border pt-1">
                    <TaskCalendarFeedSettings />
                    <CalendarExportTargetSettings />
                  </div>
                </div>
              </details>
            </div>
          </div>
        )}

        {/* Task List / Board / Calendar View */}
        {centerMode === "inbox" ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-app-bg">
            <TaskInboxPanel
              initiallyExpanded
              standalone
              onTaskMutated={() => setWorkspaceVersion((value) => value + 1)}
            />
          </div>
        ) : centerMode === "my-day" ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-app-bg">
            <MyDayPanel
              initiallyExpanded
              standalone
              onTaskMutated={() => setWorkspaceVersion((value) => value + 1)}
            />
          </div>
        ) : centerMode === "planner" ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-app-bg">
            <TaskTimePlanner
              initiallyExpanded
              standalone
              onTaskMutated={() => setWorkspaceVersion((value) => value + 1)}
            />
          </div>
        ) : centerMode === "stats" ? (
          <StatsCenter
            tasks={statsTasks}
            projects={projects}
            taskStats={stats}
            habits={statsHabits}
            habitStats={habitStats}
            checkins={statsHabitCheckins}
            loading={statsLoading}
            onRefresh={loadStatsCenter}
          />
        ) : centerMode === "habits" ? (
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-2 md:px-5">
            {visibleHabits.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-[13px] text-tx-tertiary">
                {t("habits.empty")}
              </div>
            ) : (
              <div className="divide-y divide-app-border/60">
                {visibleHabits.map((habit) => (
                  <HabitRow
                    key={habit.id}
                    habit={habit}
                    onCheckin={handleHabitCheckin}
                    onArchiveToggle={handleArchiveHabitToggle}
                    onDelete={handleDeleteHabit}
                  />
                ))}
              </div>
            )}
          </div>
        ) : viewMode === "board" && !isLoading && displayTasks.length > 0 ? (
          <TaskBoardView
            tasks={displayTasks}
            onSelect={(task) => setSelectedTaskId(task.id)}
            onStatusChange={handleStatusChange}
          />
        ) : viewMode === "calendar" && !isLoading ? (
          <TaskCalendarView
            tasks={displayTasks}
            onSelect={(task) => setSelectedTaskId(task.id)}
            onMoveTaskDate={handleMoveTaskDate}
          />
        ) : viewMode === "timeline" && !isLoading ? (
          <TaskGanttView
            tasks={displayTasks}
            projects={projects}
            dependencies={dependencies}
            onSelect={(task) => setSelectedTaskId(task.id)}
            onUpdateTaskDateRange={handleUpdateTaskDateRange}
          />
        ) : (
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-1 md:px-5">
            {isLoading ? (
              <div className="flex h-32 items-center justify-center text-[13px] text-tx-tertiary">
                {t("common.loading")}
              </div>
            ) : displayTasks.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center text-tx-tertiary">
                {searchQuery ? (
                  <TaskEmptyState type="no-search" compact onAction={() => setSearchQuery("")} />
                ) : (
                  <TaskEmptyState type="no-tasks" onAction={() => inputRef.current?.focus()} />
                )}
              </div>
            ) : (
              <div className="divide-y divide-app-border/60">
                <AnimatePresence mode="popLayout">
                  {isTreeMode ? (
                    displayFlatOrdered.map((item) => (
                      <div
                        key={item.node.id}
                        className={cn(
                          "relative",
                          dragOverId === item.node.id && dragId !== item.node.id && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent-primary before:rounded-full before:-translate-y-1"
                        )}
                        draggable={!selectMode && !sortByDueTime && !isMobile}
                        onDragStart={(e) => handleDragStart(item.node.id, e)}
                        onDragOver={(e) => handleDragOver(item.node.id, e)}
                        onDrop={() => handleDrop(item.node.id)}
                        onDragEnd={handleDragEnd}
                      >
                        {selectMode && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleSelectId(item.node.id); }}
                            className="absolute left-0 top-1/2 z-10 -translate-y-1/2 p-1"
                          >
                            {selectedIds.has(item.node.id)
                              ? <CheckSquare size={14} className="text-accent-primary" />
                              : <Square size={14} className="text-tx-tertiary" />}
                          </button>
                        )}
                        <TaskTreeRow
                          task={item.node}
                          depth={item.depth}
                          isExpanded={expandedTaskIds.has(item.node.id)}
                          hasChildren={item.node.children.length > 0}
                          onToggle={handleToggle}
                          onSelect={(task) => { if (!selectMode) setSelectedTaskId(task.id); else toggleSelectId(task.id); }}
                          onDelete={handleDelete}
                          onToggleExpand={toggleExpand}
                          onCreateChild={handleCreateChild}
                          blockedByDependency={isTaskBlockedByDependency(item.node.id, dependencies, tasks)}
                        />
                      </div>
                    ))
                  ) : (
                    displayTasks.map((task) => (
                      <div
                        key={task.id}
                        className={cn(
                          "relative",
                          dragOverId === task.id && dragId !== task.id && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent-primary before:rounded-full before:-translate-y-1"
                        )}
                        draggable={!selectMode && !sortByDueTime && !isMobile}
                        onDragStart={(e) => handleDragStart(task.id, e)}
                        onDragOver={(e) => handleDragOver(task.id, e)}
                        onDrop={() => handleDrop(task.id)}
                        onDragEnd={handleDragEnd}
                      >
                        {selectMode && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleSelectId(task.id); }}
                            className="absolute left-0 top-1/2 z-10 -translate-y-1/2 p-1"
                          >
                            {selectedIds.has(task.id)
                              ? <CheckSquare size={14} className="text-accent-primary" />
                              : <Square size={14} className="text-tx-tertiary" />}
                          </button>
                        )}
                        <FlatTaskRow
                          task={task}
                          onToggle={handleToggle}
                          onSelect={(task) => { if (!selectMode) setSelectedTaskId(task.id); else toggleSelectId(task.id); }}
                          onDelete={handleDelete}
                          allTasks={tasks}
                          onCreateChild={handleCreateChild}
                          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
                          blockedByDependency={isTaskBlockedByDependency(task.id, dependencies, tasks)}
                        />
                      </div>
                    ))
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        )}

        {/* Mobile: batch action bar at bottom */}
        {selectMode && (
          <div className="flex items-center justify-between gap-2 border-t border-app-border bg-app-surface px-4 py-2.5 md:hidden">
            <span className="text-[11px] text-tx-tertiary">{t("tasks.selectedCount", { count: selectedIds.size })}</span>
            <div className="flex items-center gap-1.5">
              <button onClick={selectedIds.size === flatOrderedTasks.length ? handleDeselectAll : handleSelectAll}
                className={secondaryBtnCls}>
                <CheckSquare size={12} />
                {selectedIds.size === flatOrderedTasks.length ? t("tasks.deselectAll") : t("tasks.selectAll")}
              </button>
              <button onClick={handleBatchComplete} disabled={selectedIds.size === 0}
                className={secondaryBtnCls}>
                <CheckSquare size={12} /> {t("tasks.batchComplete")}
              </button>
              <button onClick={handleBatchDelete} disabled={selectedIds.size === 0}
                className={cn(secondaryBtnCls, "text-accent-danger hover:text-accent-danger")}>
                <Trash2 size={12} /> {t("tasks.batchDelete")}
              </button>
              <button onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                className="px-2 py-1 text-[11.5px] text-tx-tertiary">
                {t("tasks.batchCancel")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Project edit dialog */}
      {editingProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setEditingProject(null)}>
          <div className="w-72 space-y-3 rounded-[10px] border border-app-border bg-app-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[13px] font-semibold text-tx-primary">{t("tasks.projectName")}</h3>
            <input type="text" value={editProjectName} onChange={(e) => setEditProjectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleUpdateProject(); }}
              className="w-full rounded-[6px] border border-app-border bg-app-bg px-2.5 py-1.5 text-[13px] text-tx-primary focus:border-accent-primary focus:outline-none"
              autoFocus />
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-tx-tertiary">{t("tasks.projectColor")}</span>
              {["#6366f1", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280"].map((c) => (
                <button key={c} onClick={() => setEditProjectColor(c)}
                  className={cn("h-4 w-4 rounded-full border-2 transition-all", editProjectColor === c ? "border-tx-primary scale-110" : "border-transparent")}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
            <div className="flex justify-end gap-1.5">
              <button onClick={() => setEditingProject(null)} className={secondaryBtnCls}>{t("tasks.batchCancel")}</button>
              <button onClick={handleUpdateProject} className={primaryBtnCls}>{t("tasks.save")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile project picker */}
      {mobileProjectOpen && (
        <MobileProjectPicker
          projects={projects}
          selectedProjectId={selectedProjectId}
          onClose={() => setMobileProjectOpen(false)}
          onSelect={(id) => { if (id === null) setSelectedProjectId(null); else focusTaskProject(id); setMobileProjectOpen(false); }}
          onCreate={async (name) => { await handleCreateProject(name); setMobileProjectOpen(false); }}
          t={t}
        />
      )}

      {/* Right: Detail Panel — direct flex sibling, no AnimatePresence to avoid layout gap */}
      {centerMode === "tasks" && selectedTask && (
        <TaskDetailPanel
          key={selectedTask.id}
          task={selectedTask}
          treeNode={selectedTreeNode}
          onClose={() => setSelectedTaskId(null)}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          allTasks={tasks}
          onToggle={handleToggle}
          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
          onCreated={async () => { await loadTasks(); const s = await api.getTaskStats(); setStats(s); refreshCounts(); }}
          onReminderCountChange={handleReminderCountChange}
          dependencies={dependencies}
          onCreateDependency={async (predId, succId) => { try { await api.createTaskDependency({ predecessorTaskId: predId, successorTaskId: succId }); await loadDependencies(); toast.success(t("tasks.toast.dependencyCreated")); } catch { toast.error(t("tasks.toast.dependencyCreateFailed")); } }}
          onDeleteDependency={async (id) => { try { await api.deleteTaskDependency(id); await loadDependencies(); toast.success(t("tasks.toast.dependencyDeleted")); } catch { toast.error(t("tasks.toast.dependencyDeleteFailed")); } }}
        />
      )}

      {/* Template Picker */}
      <AnimatePresence>
        {showTemplatePicker && (
          <TaskTemplatePicker
            projects={projects}
            onClose={() => setShowTemplatePicker(false)}
            onApplied={async () => { setShowTemplatePicker(false); await loadTasks(); const s = await api.getTaskStats(); setStats(s); refreshCounts(); toast.success(t("tasks.toast.templateApplied")); }}
          />
        )}
      </AnimatePresence>

      {/* Reminder Center */}
      <AnimatePresence>
        {showReminderCenter && (
          <ReminderCenter
            open={showReminderCenter}
            onClose={() => setShowReminderCenter(false)}
            onSelectTask={(taskId) => setSelectedTaskId(taskId)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
