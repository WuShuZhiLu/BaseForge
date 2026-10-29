/**
 * 项目管理插件 —— 主区全屏中心（官方内置插件 pm）。
 *
 * 布局：左列项目列表 / 右列工作项（看板 | 列表 双视图）+ 详情抽屉。
 * 工作项类型：需求 requirement / 任务 task / 缺陷 bug；状态机 todo→doing→review→done（canceled 终止）。
 * 与笔记联动：工作项可关联交付笔记（打开/跳转），笔记编辑器继续用知识库能力。
 * 与 git 联动：P1 为手工引用字段（仓库/分支/issue），P2 对接平台 API 自动同步。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bug,
  Circle,
  Play,
  CheckCircle2,
  Check,
  ClipboardList,
  ExternalLink,
  FileText,
  Layers,
  ListTodo,
  ListTree,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import PmActivityTimeline from "@/components/pm/PmActivityTimeline";
import PmItemDocsPanel from "@/components/pm/PmItemDocsPanel";
import PmOverviewPage from "@/components/pm/PmOverviewPage";
import PmSettingsPage from "@/components/pm/PmSettingsPage";
import { setPmActiveProject, setPmModule, usePmUi } from "@/lib/pmUiStore";
import { DEFAULT_PM_TYPE_CONFIG, type PmGitSource, type PmProject, type PmWorkItem, type PmWorkItemPriority, type PmWorkItemStatus, type PmWorkItemType } from "@/types";
import { confirm } from "@/components/ui/confirm";

type StatusKey = "todo" | "doing" | "review" | "done";

const STATUS_COLUMNS: Array<{ key: StatusKey; label: string; band: string; icon: React.ReactNode }> = [
  { key: "todo", label: "待处理", band: "#F59E0B", icon: <Circle size={11} /> },
  { key: "doing", label: "进行中", band: "#2563EB", icon: <Play size={11} /> },
  { key: "review", label: "待验证", band: "#8B5CF6", icon: <CheckCircle2 size={11} /> },
  { key: "done", label: "已完成", band: "#10B981", icon: <Check size={11} /> },
];

const DEFAULT_TYPE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  requirement: { label: "需求", icon: <Layers size={11} /> },
  task: { label: "任务", icon: <ListTodo size={11} /> },
  bug: { label: "缺陷", icon: <Bug size={11} /> },
};

/** 项目级动态类型元信息：typeConfig 优先，未知 key 回退默认 */
function typeMeta(project: PmProject | null, key: string): { label: string; icon: React.ReactNode; color: string } {
  const cfg = project?.typeConfig?.find((t) => t.key === key);
  if (cfg) {
    return { label: cfg.label, icon: DEFAULT_TYPE_META[key]?.icon ?? <Layers size={11} />, color: cfg.color || "#6b7280" };
  }
  const fallback = DEFAULT_TYPE_META[key];
  return { label: fallback?.label ?? key, icon: fallback?.icon ?? <Layers size={11} />, color: fallback ? { requirement: "#0ea5e9", task: "#10b981", bug: "#ef4444" }[key] ?? "#6b7280" : "#6b7280" };
}

function tagChipCls(tag: string): string {
  const palette = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#ef4444"];
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

const PRIORITY_META: Record<PmWorkItemPriority, { label: string; cls: string }> = {
  urgent: { label: "紧急", cls: "text-red-500" },
  high: { label: "高", cls: "text-amber-500" },
  medium: { label: "中", cls: "text-zinc-500" },
  low: { label: "低", cls: "text-zinc-400" },
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function Overlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

/** 工作项表单（新建/编辑共用） */
function ItemForm(props: {
  initial?: PmWorkItem;
  project: PmProject | null;
  onSave: (data: { type: string; title: string; description: string; priority: PmWorkItemPriority; dueDate: string | null; tags: string[] }) => Promise<void>;
  onClose: () => void;
}) {
  const { initial, onSave, onClose, project } = props;
  const typeOptions = project?.typeConfig?.length ? project.typeConfig : DEFAULT_PM_TYPE_CONFIG;
  const [type, setType] = useState<string>(initial?.type ?? typeOptions[0]?.key ?? "task");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [priority, setPriority] = useState<PmWorkItemPriority>(initial?.priority ?? "medium");
  const [dueDate, setDueDate] = useState<string | null>(initial?.dueDate ?? null);
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const addTag = () => {
    const t = tagInput.trim().slice(0, 24);
    if (t && !tags.includes(t) && tags.length < 10) setTags([...tags, t]);
    setTagInput("");
  };

  return (
    <div className="w-[440px] rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
      <p className="text-xs font-semibold text-tx-primary">{initial ? "编辑工作项" : "新建工作项"}</p>
      <div className="mt-2 space-y-2">
        <div className="flex gap-2">
          <select
            className="h-7 rounded border border-zinc-200 bg-transparent px-1.5 text-xs dark:border-zinc-700"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {typeOptions.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
          <select
            className="h-7 rounded border border-zinc-200 bg-transparent px-1.5 text-xs dark:border-zinc-700"
            value={priority}
            onChange={(e) => setPriority(e.target.value as PmWorkItemPriority)}
          >
            <option value="urgent">紧急</option>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
          <input
            type="date"
            className="h-7 rounded border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700"
            value={dueDate ?? ""}
            onChange={(e) => setDueDate(e.target.value || null)}
          />
        </div>
        <input
          autoFocus
          className="h-8 w-full rounded border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700"
          placeholder="标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="min-h-24 w-full resize-y rounded border border-zinc-200 bg-transparent p-2 text-xs leading-5 outline-none dark:border-zinc-700"
          placeholder="描述（支持 markdown，可转为关联文档）"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-zinc-400">标签</span>
            <input
              className="h-6 w-28 rounded border border-zinc-200 bg-transparent px-1.5 text-[11px] dark:border-zinc-700"
              placeholder="回车添加"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
            />
            {tags.map((t) => (
              <span
                key={t}
                className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-white"
                style={{ backgroundColor: tagChipCls(t) }}
              >
                {t}
                <button type="button" onClick={() => setTags(tags.filter((x) => x !== t))}>
                  <X size={9} />
                </button>
              </span>
            ))}
          </div>
        </div>
        {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="rounded-md border border-zinc-200 px-3 py-1 text-xs text-tx-secondary dark:border-zinc-700" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          disabled={busy || !title.trim()}
          className="rounded-md bg-accent-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onSave({ type, title: title.trim(), description, priority, dueDate: dueDate || null, tags });
            } catch (err: any) {
              setError(err?.message || "保存失败");
              setBusy(false);
              return;
            }
            setBusy(false);
          }}
        >
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}

/** 工作项详情抽屉 */
function ItemDrawer(props: {
  item: PmWorkItem;
  project: PmProject | null;
  allItems: PmWorkItem[];
  onClose: () => void;
  onChanged: (item: PmWorkItem) => void;
  onDelete: (item: PmWorkItem) => void;
  onPull: (item: PmWorkItem) => Promise<void>;
  onPush: (item: PmWorkItem) => Promise<void>;
  onLinkPlatform: (item: PmWorkItem) => void;
  onAddChild: (parentId: string) => void;
}) {
  const { item, project, allItems, onClose, onChanged, onDelete, onPull, onPush, onLinkPlatform, onAddChild } = props;
  const [editing, setEditing] = useState(false);
  const [descRender, setDescRender] = useState(true);
  const children = allItems.filter((i) => i.parentId === item.id);

  const setStatus = useCallback(
    async (status: PmWorkItemStatus) => {
      const res = await api.updatePmWorkItem(item.id, { status });
      onChanged(res.item);
    },
    [item, onChanged],
  );

  const meta = typeMeta(null, item.type);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-[440px] flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
          <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ color: meta.color, backgroundColor: meta.color + "1a" }}>
            {meta.icon} {meta.label}
          </span>
          <span className={`text-[10px] ${PRIORITY_META[item.priority].cls}`}>{PRIORITY_META[item.priority].label}</span>
          <span className="flex-1" />
          <button
            type="button"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-500 dark:hover:bg-zinc-800"
            title="删除"
            onClick={() => onDelete(item)}
          >
            <Trash2 size={14} />
          </button>
          <button type="button" className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {editing ? null : <h3 className="text-sm font-semibold text-tx-primary">{item.title}</h3>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {STATUS_COLUMNS.map((col) => (
              <button
                key={col.key}
                type="button"
                className={`rounded px-2 py-0.5 text-[10px] ${item.status === col.key ? "bg-accent-primary/15 text-accent-primary" : "text-zinc-400 hover:bg-app-hover"}`}
                onClick={() => void setStatus(col.key)}
              >
                {col.label}
              </button>
            ))}
            {item.status === "canceled" ? <span className="text-[10px] text-zinc-400">（已取消）</span> : null}
          </div>

          {item.tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded px-1.5 py-0.5 text-[10px] text-white"
                  style={{ backgroundColor: tagChipCls(tag) }}
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          <div className="mt-3 space-y-1 text-[11px] text-zinc-500">
            <p>截止：{formatDate(item.dueDate)}</p>
            {item.gitIssue ? (
              <p className="flex items-center gap-1">
                平台工单：#{item.gitIssue}
                {item.gitIssueState ? <span className="rounded bg-zinc-100 px-1 text-[9px] dark:bg-zinc-800">{item.gitIssueState}</span> : null}
                {item.gitIssueUrl ? (
                  <a href={item.gitIssueUrl} target="_blank" rel="noreferrer" className="flex items-center gap-0.5 text-accent-primary">
                    <ExternalLink size={10} /> 在平台打开
                  </a>
                ) : null}
              </p>
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.gitIssue ? (
              <>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 px-2 py-1 text-[11px] text-tx-secondary hover:bg-app-hover dark:border-zinc-700"
                  onClick={() => void onPull(item)}
                >
                  从平台拉取
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 px-2 py-1 text-[11px] text-tx-secondary hover:bg-app-hover dark:border-zinc-700"
                  onClick={() => void onPush(item)}
                >
                  推送到平台
                </button>
              </>
            ) : (
              <button
                type="button"
                className="rounded-md border border-dashed border-zinc-300 px-2 py-1 text-[11px] text-zinc-500 hover:border-accent-primary hover:text-accent-primary dark:border-zinc-600"
                onClick={() => onLinkPlatform(item)}
              >
                关联平台工单（GitHub / GitLab / Gitea）
              </button>
            )}
          </div>

          <div className="mt-3 rounded-lg border border-zinc-200 p-2 text-xs leading-5 text-tx-secondary dark:border-zinc-700">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-medium text-zinc-400">描述</span>
              {item.description ? (
                <button type="button" className="text-[10px] text-accent-primary" onClick={() => setDescRender((v) => !v)}>
                  {descRender ? "源码" : "渲染"}
                </button>
              ) : null}
            </div>
            {!item.description ? (
              <p className="text-zinc-400">（无描述）</p>
            ) : descRender ? (
              <MarkdownPreview markdown={item.description} />
            ) : (
              <p className="whitespace-pre-wrap">{item.description}</p>
            )}
          </div>

          <PmItemDocsPanel item={item} onRefresh={() => onChanged(item)} />

          {children.length > 0 ? (
            <div className="mt-3 rounded-lg border border-zinc-200 p-2 dark:border-zinc-700">
              <p className="flex items-center gap-1 text-[11px] font-medium text-tx-secondary">
                <ListTree size={11} /> 子工作项
              </p>
              <div className="mt-1.5 space-y-0.5">
                {children.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-500 hover:bg-app-hover"
                    onClick={() => onChanged(child)}
                  >
                    {child.status === "done" ? (
                      <Check size={10} className="shrink-0 text-emerald-500" />
                    ) : (
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-zinc-300 dark:border-zinc-600" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                    <span className="shrink-0 text-[9px] text-zinc-400">{STATUS_COLUMNS.find((c) => c.key === child.status)?.label ?? child.status}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="mt-1.5 flex items-center gap-1 rounded border border-dashed border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-500 hover:border-accent-primary hover:text-accent-primary dark:border-zinc-600"
                onClick={() => onAddChild(item.id)}
              >
                <Plus size={10} /> 添加子工作项
              </button>
            </div>
          ) : null}

          <PmActivityTimeline itemId={item.id} />

          <button
            type="button"
            className="mt-3 flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-[11px] text-tx-secondary hover:bg-app-hover dark:border-zinc-700"
            onClick={() => setEditing(true)}
          >
            <Pencil size={11} /> 编辑字段
          </button>
        </div>
      </div>

      {editing ? (
        <Overlay onClose={() => setEditing(false)}>
          <ItemForm
            initial={item}
            project={project}
            onClose={() => setEditing(false)}
            onSave={async (data) => {
              const res = await api.updatePmWorkItem(item.id, data);
              onChanged(res.item);
              setEditing(false);
            }}
          />
        </Overlay>
      ) : null}
    </div>
  );
}

/** 主区中心 */
export default function PmWorkspace() {
  const [projects, setProjects] = useState<PmProject[]>([]);
  const ui = usePmUi();
  const activeId = ui.activeProjectId;
  const [items, setItems] = useState<PmWorkItem[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [view, setView] = useState<"board" | "list">("board");
  const [typeFilter, setTypeFilter] = useState<"all" | PmWorkItemType>("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [newItemParentId, setNewItemParentId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState("");
  const [error, setError] = useState("");
  const [platformDlg, setPlatformDlg] = useState<null | { mode: "sources" | "import" | "link"; item?: PmWorkItem }>(null);

  const activeProject = projects.find((p) => p.id === activeId) || null;
  const detailItem = items.find((i) => i.id === detailId) || null;

  const reloadProjects = useCallback(async () => {
    try {
      const res = await api.listPmProjects();
      setProjects(res.projects);
      const current = ui.activeProjectId;
      setPmActiveProject(current && res.projects.some((p) => p.id === current) ? current : res.projects[0]?.id ?? "");
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, [ui.activeProjectId]);

  const loadItems = useCallback(async (projectId: string) => {
    if (!projectId) { setItems([]); setStats({}); return; }
    try {
      const res = await api.listPmWorkItems(projectId);
      setItems(res.items);
      setStats(res.stats as unknown as Record<string, number>);
      setError("");
    } catch (err: any) {
      setError(err?.message || "加载工作项失败");
    }
  }, []);

  useEffect(() => { void reloadProjects(); }, [reloadProjects]);
  useEffect(() => { void loadItems(activeId); }, [activeId, loadItems]);

  // 侧栏项目面板「新建工作项/新建项目」事件 → 打开对应表单（PM 在 Rail 上只有徽章，功能走侧栏）
  useEffect(() => {
    const onNewItem = () => { setNewItemOpen(true); setNewItemParentId(null); };
    const onNewProject = () => setNewProjectOpen(true);
    window.addEventListener("nowen:pm-new-item", onNewItem);
    window.addEventListener("nowen:pm-new-project", onNewProject);
    return () => {
      window.removeEventListener("nowen:pm-new-item", onNewItem);
      window.removeEventListener("nowen:pm-new-project", onNewProject);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(
      (i) =>
        (typeFilter === "all" || i.type === typeFilter) &&
        (tagFilter === "all" || i.tags.includes(tagFilter)) &&
        (!q ||
          i.title.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          (i.itemNo !== null && String(i.itemNo).includes(q))),
    );
  }, [items, typeFilter, tagFilter, search]);

  // 父子完成度聚合：y = 非 canceled 子项数，x = done 数
  const childStats = useMemo(() => {
    const map = new Map<string, { total: number; done: number }>();
    for (const item of items) {
      if (!item.parentId) continue;
      const entry = map.get(item.parentId) ?? { total: 0, done: 0 };
      if (item.status !== "canceled") entry.total += 1;
      if (item.status === "done") entry.done += 1;
      map.set(item.parentId, entry);
    }
    return map;
  }, [items]);

  const usedTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.type] = (counts[item.type] ?? 0) + 1;
    return counts;
  }, [items]);

  const projectTags = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => i.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [items]);

  const refreshCurrent = useCallback(() => {
    void loadItems(activeId);
    void reloadProjects();
  }, [activeId, loadItems, reloadProjects]);

  const createProject = useCallback(async (name: string, description: string, color: string) => {
    const res = await api.createPmProject({ name, description, color });
    await reloadProjects();
    setPmActiveProject(res.project.id);
    return res.project;
  }, [reloadProjects]);

  const deleteProject = useCallback(async (project: PmProject) => {
    const ok = await confirm({
      title: `删除项目「${project.name}」？`,
      description: "及其全部工作项，此操作不可撤销。",
      confirmText: "删除项目",
      danger: true,
    });
    if (!ok) return;
    await api.deletePmProject(project.id);
    await reloadProjects();
  }, [reloadProjects]);

  const deleteItem = useCallback(async (item: PmWorkItem) => {
    const ok = await confirm({
      title: `删除工作项「${item.title}」？`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    await api.deletePmWorkItem(item.id);
    setDetailId("");
    refreshCurrent();
  }, [refreshCurrent]);

  const pullItem = useCallback(async (item: PmWorkItem) => {
    await api.pullPmItem(item.id);
    refreshCurrent();
  }, [refreshCurrent]);

  const pushItem = useCallback(async (item: PmWorkItem) => {
    await api.pushPmItem(item.id);
    refreshCurrent();
  }, [refreshCurrent]);

  const createProjectCard = (
    <div className="flex items-center gap-2">
      <ClipboardList size={15} className="text-accent-primary" />
      <span className="text-sm font-semibold">项目管理</span>
      <span className="sbx-mini-tag">官方插件</span>
      <span className="flex-1" />
      <button
        type="button"
        className="flex items-center gap-1 rounded-md border border-app-border px-2 py-1 text-xs text-tx-secondary hover:bg-app-hover"
        onClick={() => setNewProjectOpen(true)}
      >
        <Plus size={12} /> 新建项目
      </button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具条 1：项目身份 + 语义统计 + 视图 + 主行动作（视觉重设计） */}
      <div className="flex items-center gap-2.5 border-b border-app-border bg-app-surface/60 px-4 py-2.5" style={{ minWidth: 0 }}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-[12px] font-bold text-white"
            style={{ background: `linear-gradient(135deg, ${activeProject?.color || "#6b7280"}, ${activeProject?.color || "#6b7280"}cc)` }}
          >
            {(activeProject?.name || "P").slice(0, 1)}
          </span>
          <select
            className="min-w-0 max-w-52 cursor-pointer truncate rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-tx-primary outline-none hover:border-app-border"
            value={activeId}
            onChange={(e) => setPmActiveProject(e.target.value)}
            title="切换项目"
          >
            {projects.length === 0 ? <option value="">（无项目）</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button type="button" title="项目设置" className="shrink-0 rounded p-1 text-zinc-400 hover:bg-app-hover hover:text-tx-primary" onClick={() => setPmModule("settings")}>
            <Pencil size={12} />
          </button>
        </div>

        {activeProject ? (
          <>
            <span className="h-[18px] w-px shrink-0 bg-app-border" />
            <div className="flex flex-wrap items-center gap-3">
              {STATUS_COLUMNS.map((col) => (
                <span key={col.key} className="flex items-center gap-1.5 text-[11.5px] text-tx-secondary">
                  <span className="h-[7px] w-[7px] rounded-full" style={{ backgroundColor: col.band }} />
                  {col.label} <b className="font-semibold tabular-nums text-tx-primary">{stats[col.key] ?? 0}</b>
                </span>
              ))}
            </div>
            <span className="flex-1" />
            {ui.module !== "overview" ? (
            <>
            <div className="flex items-center rounded-lg border border-app-border bg-app-bg p-0.5">
              <button
                type="button"
                className={`rounded-md px-2.5 py-1 text-[11.5px] ${view === "board" ? "bg-app-elevated font-medium text-tx-primary shadow-sm" : "text-tx-secondary"}`}
                onClick={() => setView("board")}
              >
                看板
              </button>
              <button
                type="button"
                className={`rounded-md px-2.5 py-1 text-[11.5px] ${view === "list" ? "bg-app-elevated font-medium text-tx-primary shadow-sm" : "text-tx-secondary"}`}
                onClick={() => setView("list")}
              >
                列表
              </button>
            </div>
            <button type="button" className="flex items-center gap-1 rounded-lg bg-accent-primary px-2.5 py-1.5 text-[11.5px] font-medium text-white hover:opacity-90" onClick={() => setNewItemOpen(true)}>
              <Plus size={12} /> 新建工作项
            </button>
            <button type="button" title="平台" className="flex h-7 w-7 items-center justify-center rounded-lg border border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover" onClick={() => setPlatformDlg({ mode: "sources" })}>
              <ExternalLink size={12} />
            </button>
            <button type="button" title="刷新" className="flex h-7 w-7 items-center justify-center rounded-lg border border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover" onClick={refreshCurrent}>
              <RefreshCw size={12} />
            </button>
            </>
          ) : null}
          </>
        ) : (
          <span className="flex-1" />
        )}
      </div>

      {/* 工具条 2：筛选（搜索/类型/标签）+ 计数说明（仅看板/列表模块） */}
      {activeProject && ui.module !== "overview" ? (
        <div className="flex items-center gap-2 border-b border-app-border bg-app-surface/60 px-4 py-1.5" style={{ minWidth: 0 }}>
          <div className="flex h-7 w-56 items-center gap-1.5 rounded-lg bg-app-hover/60 px-2">
            <Search size={12} className="shrink-0 text-zinc-400" />
            <input
              className="min-w-0 flex-1 bg-transparent text-[11.5px] text-tx-primary outline-none placeholder:text-zinc-400"
              placeholder="搜索标题 / 描述 / 编号…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="shrink-0 rounded border border-app-border px-1 text-[9px] text-zinc-400">/</span>
          </div>
          <select
            className="h-7 rounded-lg border border-app-border bg-transparent px-1.5 text-xs"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
          >
            <option value="all">全部类型</option>
            {(activeProject.typeConfig ?? []).map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
          <select
            className="h-7 rounded-lg border border-app-border bg-transparent px-1.5 text-xs"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
          >
            <option value="all">全部标签</option>
            {projectTags.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <span className="flex-1" />
          <span className="text-[10.5px] text-zinc-400">{filtered.length} / {items.length} 个工作项</span>
        </div>
      ) : null}

      {error ? <p className="px-3 py-1 text-[11px] text-red-500">{error}</p> : null}

      {/* 内容区：远程/看板/列表（远程 Tab 由视图切换控制） */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!activeProject && !loading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-zinc-400">
            <ClipboardList size={32} className="opacity-40" />
            <p>选择上方项目，或新建一个项目开始</p>
            <button type="button" className="flex items-center gap-1 rounded-md bg-accent-primary px-3 py-1.5 text-xs font-medium text-white" onClick={() => setNewProjectOpen(true)}>
              <Plus size={12} /> 新建项目
            </button>
          </div>
        ) : null}

      {/* 模块内容：概览 / 看板 / 列表（设置见下方独立模块） */}
      {ui.module === "overview" && activeProject ? <PmOverviewPage onOpenProject={() => setPmModule("board")} /> : null}
      {activeProject && ui.module !== "overview" && ui.module !== "settings" ? (
        <>
              {/* 看板（视觉重设计：列头色带 / 类型色条 / 编号 / 标签 / 空态） */}
              {view === "board" ? (
                <div className="min-h-0 flex-1 overflow-x-auto p-3 pt-2.5">
                  <div className="flex h-full min-w-max gap-3">
                    {STATUS_COLUMNS.map((col) => {
                      const colItems = filtered.filter((i) => i.status === col.key);
                      const todayIso = new Date().toISOString().slice(0, 10);
                      return (
                        <div key={col.key} className="flex w-72 flex-col overflow-hidden rounded-xl border border-app-border bg-app-elevated/50">
                          <div className="h-[3px] shrink-0" style={{ backgroundColor: col.band }} />
                          <div className="flex shrink-0 items-center gap-2 px-3 py-2">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: col.band + "1a", color: col.band }}>
                              {col.icon}
                            </span>
                            <span className="flex-1 text-[12px] font-medium text-tx-primary">{col.label}</span>
                            <span className="rounded-full bg-app-hover px-1.5 text-[10px] tabular-nums text-tx-tertiary">{colItems.length}</span>
                            <button type="button" title="新建工作项" className="rounded p-0.5 text-zinc-400 hover:bg-app-hover hover:text-tx-primary" onClick={() => setNewItemOpen(true)}>
                              <Plus size={11} />
                            </button>
                          </div>
                          <div className="flex min-h-[56px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2.5">
                            {colItems.length === 0 ? (
                              <div className="mt-1 flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-app-border py-6 text-zinc-400">
                                <ListTree size={16} className="opacity-50" />
                                <p className="text-[10px]">拖拽工单到这里</p>
                              </div>
                            ) : (
                              colItems.map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  className="relative w-full rounded-xl border border-app-border bg-app-bg p-2 pl-3 text-left transition-all hover:-translate-y-px hover:border-accent-primary/40 hover:shadow-md"
                                  onClick={() => setDetailId(item.id)}
                                >
                                  <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-full" style={{ backgroundColor: typeMeta(activeProject, item.type).color }} />
                                  <div className="flex items-center gap-1.5">
                                    <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9.5px] font-medium" style={{ color: typeMeta(activeProject, item.type).color, backgroundColor: typeMeta(activeProject, item.type).color + "1a" }}>
                                      {typeMeta(activeProject, item.type).icon} {typeMeta(activeProject, item.type).label}
                                    </span>
                                    <span className="font-mono text-[10px] text-zinc-400">#{item.itemNo ?? "—"}</span>
                                    <span className={`ml-auto text-[9.5px] font-semibold ${PRIORITY_META[item.priority].cls}`}>{PRIORITY_META[item.priority].label}</span>
                                  </div>
                                  <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-tx-primary">{item.title}</p>
                                  {item.tags.length > 0 || childStats.has(item.id) || item.noteId ? (
                                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                      {item.tags.map((tag) => (
                                        <span key={tag} className="rounded bg-app-hover px-1.5 py-0.5 text-[9.5px] text-tx-secondary">{tag}</span>
                                      ))}
                                      {childStats.has(item.id) ? (() => {
                                        const cs = childStats.get(item.id)!;
                                        return (
                                          <span className="flex items-center gap-0.5 rounded bg-app-hover px-1.5 py-0.5 text-[9.5px] tabular-nums text-tx-secondary">
                                            <ListTree size={9} /> {cs.done}/{cs.total}
                                          </span>
                                        );
                                      })() : null}
                                      {item.noteId ? <FileText size={10} className="ml-auto text-sky-400" /> : null}
                                    </div>
                                  ) : null}
                                  {item.dueDate ? (
                                    <p className={`mt-1 text-[10px] ${item.dueDate < todayIso && item.status !== "done" && item.status !== "canceled" ? "font-medium text-red-500" : "text-zinc-400"}`}>
                                      截止 {formatDate(item.dueDate)}
                                    </p>
                                  ) : null}
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                  {filtered.length === 0 ? (
                    <p className="py-8 text-center text-xs text-zinc-400">暂无工作项</p>
                  ) : (
                    filtered.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="group mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-app-hover"
                        style={item.parentId ? { paddingLeft: 26 } : undefined}
                        onClick={() => setDetailId(item.id)}
                      >
                        {item.parentId ? <ListTree size={9} className="shrink-0 text-zinc-400" /> : null}
                        <span className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px]" style={{ color: typeMeta(activeProject, item.type).color, backgroundColor: typeMeta(activeProject, item.type).color + "1a" }}>
                          {typeMeta(activeProject, item.type).icon} {typeMeta(activeProject, item.type).label}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-tx-primary">{item.title}</span>
                        <span className={`shrink-0 text-[10px] ${PRIORITY_META[item.priority].cls}`}>{PRIORITY_META[item.priority].label}</span>
                        <span className="shrink-0 text-[10px] text-zinc-400">{STATUS_COLUMNS.find((c) => c.key === item.status)?.label ?? item.status}</span>
                        <span className="w-20 shrink-0 text-right text-[10px] text-zinc-400">{formatDate(item.dueDate)}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </>
      ) : null}
    </div>

      {/* 新建项目 */}
      {newProjectOpen ? (
        <Overlay onClose={() => setNewProjectOpen(false)}>
          <ProjectForm
            title="新建项目"
            onClose={() => setNewProjectOpen(false)}
            onSubmit={async (name, description, color) => {
              await createProject(name, description, color);
              setNewProjectOpen(false);
            }}
          />
        </Overlay>
      ) : null}

      {/* 设置模块（侧栏「设置」导航对应） */}
      {ui.module === "settings" && activeProject ? (
        <PmSettingsPage
          project={activeProject}
          usedTypeCounts={usedTypeCounts}
          onSaved={() => refreshCurrent()}
          onDeleteRequest={(project) => void deleteProject(project)}
        />
      ) : null}

      {/* 新建工作项（onAddChild 预置父项） */}
      {newItemOpen && activeProject ? (
        <Overlay onClose={() => { setNewItemOpen(false); setNewItemParentId(null); }}>
          <ItemForm
            project={activeProject}
            onClose={() => { setNewItemOpen(false); setNewItemParentId(null); }}
            onSave={async (data) => {
              await api.createPmWorkItem(activeProject.id, { ...data, parentId: newItemParentId });
              setNewItemOpen(false);
              setNewItemParentId(null);
              refreshCurrent();
            }}
          />
        </Overlay>
      ) : null}

      {/* 平台源管理 / 批量导入 / 关联平台工单 */}
      {platformDlg ? (
        <PlatformDialog
          mode={platformDlg.mode}
          project={activeProject}
          item={platformDlg.item ?? null}
          onClose={() => setPlatformDlg(null)}
          onDone={() => { refreshCurrent(); setPlatformDlg(null); }}
        />
      ) : null}

      {/* 详情抽屉 */}
      {detailItem ? (
        <ItemDrawer
          item={detailItem}
          project={activeProject}
          allItems={items}
          onClose={() => setDetailId("")}
          onChanged={() => refreshCurrent()}
          onDelete={(item) => void deleteItem(item)}
          onPull={(item) => pullItem(item)}
          onPush={(item) => pushItem(item)}
          onLinkPlatform={(item) => setPlatformDlg({ mode: "link", item })}
          onAddChild={(parentId) => { setNewItemParentId(parentId); setNewItemOpen(true); }}
        />
      ) : null}
    </div>
  );
}

/** 项目表单（新建/编辑共用） */
function ProjectForm(props: {
  title: string;
  initial?: { name: string; description: string; color: string };
  onClose: () => void;
  onSubmit: (name: string, description: string, color: string) => Promise<void>;
}) {
  const { title, initial, onClose, onSubmit } = props;
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState(initial?.color ?? "#3b82f6");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <div className="mt-2 space-y-2">
      {title ? <p className="text-xs font-semibold">{title}</p> : null}
      <input
        autoFocus
        className="h-8 w-full rounded border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700"
        placeholder="项目名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <textarea
        className="min-h-16 w-full resize-y rounded border border-zinc-200 bg-transparent p-2 text-xs dark:border-zinc-700"
        placeholder="项目描述（可选）"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-zinc-400">颜色</span>
        {["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"].map((c) => (
          <button
            key={c}
            type="button"
            className={`h-4 w-4 rounded-full ${color === c ? "ring-2 ring-offset-1 ring-accent-primary" : ""}`}
            style={{ backgroundColor: c }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border border-zinc-200 px-3 py-1 text-xs text-tx-secondary dark:border-zinc-700" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          className="rounded-md bg-accent-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onSubmit(name.trim(), description, color);
            } catch (err: any) {
              setError(err?.message || "保存失败");
              setBusy(false);
              return;
            }
            setBusy(false);
          }}
        >
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}

/** 平台对话框：源管理（sources）/ 批量导入（import）/ 关联平台工单（link） */
function PlatformDialog(props: {
  mode: "sources" | "import" | "link";
  project: PmProject | null;
  item: PmWorkItem | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { mode, project, item, onClose, onDone } = props;
  const [sources, setSources] = useState<PmGitSource[]>([]);
  const [types, setTypes] = useState<string[]>(["github", "gitlab", "gitea"]);
  const [activeSourceId, setActiveSourceId] = useState("");
  const [repos, setRepos] = useState<Array<{ fullName: string }>>([]);
  const [repo, setRepo] = useState("");
  const [form, setForm] = useState<{ id?: string; type: string; name: string; apiBase: string; token: string }>({ type: "github", name: "", apiBase: "", token: "" });
  const [state, setState] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const reloadSources = useCallback(() => {
    api.listPmGitSources()
      .then((r) => {
        setSources(r.sources);
        setTypes(r.types);
        setActiveSourceId((prev) => (prev && r.sources.some((s) => s.id === prev) ? prev : r.sources[0]?.id || ""));
      })
      .catch(() => setSources([]));
  }, []);

  useEffect(() => { reloadSources(); }, [reloadSources]);

  const loadRepos = useCallback(async (sourceId: string) => {
    setState((prev) => ({ ...prev, repos: "拉取仓库中…" }));
    try {
      const res = await api.listPmGitRepos(sourceId);
      setRepos(res.repos);
      setState((prev) => ({ ...prev, repos: "" }));
    } catch (err: any) {
      setState((prev) => ({ ...prev, repos: err?.message || "拉取仓库失败" }));
      setRepos([]);
    }
  }, []);

  const saveSource = useCallback(async () => {
    setBusy(true);
    try {
      await api.savePmGitSource(form);
      setForm({ type: "github", name: "", apiBase: "", token: "" });
      reloadSources();
    } catch (err: any) {
      setState((prev) => ({ ...prev, save: err?.message || "保存失败" }));
    } finally {
      setBusy(false);
    }
  }, [form, reloadSources]);

  const deleteSource = useCallback(async (id: string) => {
    await api.deletePmGitSource(id);
    reloadSources();
  }, [reloadSources]);

  const importIssues = useCallback(async () => {
    if (!project) return;
    setBusy(true);
    try {
      const res = await api.importPmIssues(activeSourceId, { projectId: project.id, repo, state: "all" });
      setState((prev) => ({ ...prev, import: `新增 ${res.imported} · 更新 ${res.updated}（共 ${res.total}）` }));
      onDone();
    } catch (err: any) {
      setState((prev) => ({ ...prev, import: err?.message || "导入失败" }));
    } finally {
      setBusy(false);
    }
  }, [activeSourceId, project, repo, onDone]);

  const linkPlatform = useCallback(async () => {
    if (!item || !activeSourceId || !repo) return;
    setBusy(true);
    try {
      await api.createPmIssueOnPlatform(item.id, { sourceId: activeSourceId, repo });
      onDone();
    } catch (err: any) {
      setState((prev) => ({ ...prev, link: err?.message || "关联失败" }));
      setBusy(false);
    }
  }, [item, activeSourceId, repo, onDone]);

  const titleMap = { sources: "平台源（GitHub / GitLab / Gitea）", import: "从平台导入工单", link: "在平台创建工单并关联" };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[520px] rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold">{titleMap[mode]}</p>
          <button type="button" className="rounded p-1 text-zinc-400 hover:text-zinc-600" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* 源列表 */}
        <div className="mt-2 space-y-1">
          {sources.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-700">
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800">{s.type}</span>
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-400">{s.apiBase}</span>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[10px] text-accent-primary hover:bg-app-hover"
                onClick={() => { setActiveSourceId(s.id); void loadRepos(s.id); }}
              >
                选仓库
              </button>
              <button type="button" className="text-[10px] text-red-400 hover:text-red-500" onClick={() => void deleteSource(s.id)}>
                删除
              </button>
            </div>
          ))}
          {sources.length === 0 ? <p className="py-2 text-center text-[11px] text-zinc-400">尚未配置平台源，在下方添加。</p> : null}
        </div>

        {/* 添加源表单 */}
        <details className="mt-2 rounded border border-zinc-200 px-2 py-1 text-[11px] dark:border-zinc-700" open={sources.length === 0}>
          <summary className="cursor-pointer select-none text-zinc-500">添加平台源</summary>
          <div className="mt-1.5 space-y-1.5">
            <div className="flex gap-2">
              <select
                className="h-7 rounded border border-zinc-200 bg-transparent px-1.5 text-xs dark:border-zinc-700"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value, apiBase: e.target.value === "github" ? "https://api.github.com" : e.target.value === "gitlab" ? "https://gitlab.com/api/v4" : "" })}
              >
                {(types.length ? types : ["github", "gitlab", "gitea"]).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <input
                className="h-7 min-w-0 flex-1 rounded border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700"
                placeholder="源名称（如 公司 GitLab）"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <input
              className="h-7 w-full rounded border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700"
              placeholder={form.type === "github" ? "API 地址（默认 https://api.github.com，可留空）" : form.type === "gitlab" ? "API 地址（默认 https://gitlab.com/api/v4，自建填实例地址）" : "API 地址（必填，如 https://git.example.com/api/v1）"}
              value={form.apiBase}
              onChange={(e) => setForm({ ...form, apiBase: e.target.value })}
            />
            <input
              type="password"
              className="h-7 w-full rounded border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700"
              placeholder="访问令牌 PAT（加密存储，不下发明文）"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
            {state.save ? <p className="text-[11px] text-red-500">{state.save}</p> : null}
            <button
              type="button"
              disabled={busy || !form.name.trim()}
              className="rounded-md bg-accent-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
              onClick={() => void saveSource()}
            >
              保存源
            </button>
          </div>
        </details>

        {/* 仓库选择 + 导入 / 关联 */}
        {(mode === "import" || mode === "link") && (
          <div className="mt-3 rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-700">
            <div className="flex items-center gap-2">
              <select
                className="h-7 min-w-0 flex-1 rounded border border-zinc-200 bg-transparent px-1.5 text-xs dark:border-zinc-700"
                value={activeSourceId}
                onChange={(e) => { setActiveSourceId(e.target.value); setRepos([]); }}
              >
                <option value="">选择平台源</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}（{s.type}）</option>
                ))}
              </select>
              <button
                type="button"
                className="shrink-0 rounded border border-zinc-200 px-2 py-1 text-[11px] text-tx-secondary dark:border-zinc-700"
                disabled={!activeSourceId}
                onClick={() => void loadRepos(activeSourceId)}
              >
                拉取仓库
              </button>
            </div>
            {repos.length > 0 ? (
              <select
                className="mt-1.5 h-7 w-full rounded border border-zinc-200 bg-transparent px-1.5 text-xs dark:border-zinc-700"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              >
                <option value="">选择仓库</option>
                {repos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>{r.fullName}</option>
                ))}
              </select>
            ) : null}
            {mode === "import" ? (
              <>
                {state.import ? <p className="mt-1 text-[11px] text-emerald-500">{state.import}</p> : null}
                <button
                  type="button"
                  disabled={busy || !activeSourceId || !repo}
                  className="mt-2 w-full rounded-md bg-accent-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                  onClick={() => void importIssues()}
                >
                  {busy ? "导入中…" : "导入该仓库全部工单（open+closed）"}
                </button>
                <p className="mt-1 text-[10px] leading-4 text-zinc-400">按平台编号匹配：已存在则更新标题/描述/标签/状态，不存在则新建「任务」类型工作项。</p>
              </>
            ) : (
              <>
                {state.link ? <p className="mt-1 text-[11px] text-red-500">{state.link}</p> : null}
                <button
                  type="button"
                  disabled={busy || !activeSourceId || !repo}
                  className="mt-2 w-full rounded-md bg-accent-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                  onClick={() => void linkPlatform()}
                >
                  {busy ? "创建中…" : "在平台创建工单并关联"}
                </button>
              </>
            )}
          </div>
        )}

        {state.repos ? <p className="mt-2 text-[11px] text-zinc-400">{state.repos}</p> : null}
      </div>
    </div>
  );
}
