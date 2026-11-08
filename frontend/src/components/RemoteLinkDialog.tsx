/**
 * 链接到知识库 —— 远程文件投影的「目标位置选择器」。
 *
 * 语义：远程文件**不导入副本**，而是在选定的知识库里出现为一条普通笔记
 * （正文是远程内容的本地缓存，保存自动写回远程，见 lib/remoteNoteSync.ts）。
 * 所以这里选的是「笔记落在哪个知识库」，跟移动笔记是同一件事的入口。
 *
 * 两个动作：
 *   1. 在已有知识库列表里挑一个（支持搜索，默认选中上次用过的那个）；
 *   2. 就地新建一个知识库，建完自动选中，不用先跑去侧栏建库。
 *
 * 弹窗本身不碰远程文件，也不建笔记——只回吐目标知识库，由调用方批量落库。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronRight,
  Folder,
  Library,
  Loader2,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { notebookCoverIcon } from "@/lib/knowledgeTreeIcons";
import { cn } from "@/lib/utils";
import type { Notebook } from "@/types";

const LAST_TARGET_KEY = "baseforge:remote-link:last-notebook";

/** 知识树的重建事件（同 KnowledgeTreePanel 里的常量，这里用字面量避免循环依赖） */
const KNOWLEDGE_TREE_CHANGED_EVENT = "nowen:knowledge-tree-changed";

export function readLastRemoteLinkNotebook(): string | null {
  try {
    return window.localStorage.getItem(LAST_TARGET_KEY);
  } catch {
    return null;
  }
}

export function rememberRemoteLinkNotebook(notebookId: string): void {
  try {
    window.localStorage.setItem(LAST_TARGET_KEY, notebookId);
  } catch {
    /* 隐私模式写不进去就算了，不影响功能 */
  }
}

export interface RemoteLinkTarget {
  notebookId: string;
  notebookName: string;
}

interface RemoteLinkDialogProps {
  open: boolean;
  /** 待链接的文件数，只用于文案 */
  count: number;
  /** 提交中：禁用交互，避免重复点 */
  busy: boolean;
  onClose: () => void;
  onConfirm: (target: RemoteLinkTarget) => void;
}

/** 知识库全路径（父级 → 子级），列表里用来区分同名库 */
function notebookPath(notebook: Notebook, byId: Map<string, Notebook>): string {
  const names: string[] = [];
  let cursor: Notebook | undefined = notebook;
  let guard = 0;
  while (cursor?.parentId && guard < 20) {
    const parent = byId.get(cursor.parentId);
    if (!parent) break;
    names.unshift(parent.name);
    cursor = parent;
    guard += 1;
  }
  return names.join(" / ");
}

export default function RemoteLinkDialog({
  open,
  count,
  busy,
  onClose,
  onConfirm,
}: RemoteLinkDialogProps) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  /** 树形展开状态；undefined = 全部展开（默认） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.getNotebooks();
      setNotebooks(list);
      setSelectedId((current) => {
        if (current && list.some((item) => item.id === current)) return current;
        const last = readLastRemoteLinkNotebook();
        if (last && list.some((item) => item.id === last)) return last;
        return list[0]?.id || "";
      });
    } catch (requestError: any) {
      setError(requestError?.message || "知识库列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCreatingOpen(false);
    setNewName("");
    void load();
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy || creating) return;
      // 新建输入框开着时，Esc 先收起输入而不是关弹窗
      if (creatingOpen) {
        setCreatingOpen(false);
        setNewName("");
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [busy, creating, creatingOpen, onClose, open]);

  const byId = useMemo(() => new Map(notebooks.map((item) => [item.id, item])), [notebooks]);

  /** parentId → 子库列表（按 sortOrder / 名称排序），重建树用 */
  const childrenMap = useMemo(() => {
    const map = new Map<string | null, Notebook[]>();
    for (const item of notebooks) {
      const key = item.parentId && byId.has(item.parentId) ? item.parentId : null;
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
    }
    return map;
  }, [byId, notebooks]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return notebooks;
    return notebooks.filter((item) => {
      if (item.name.toLowerCase().includes(keyword)) return true;
      return notebookPath(item, byId).toLowerCase().includes(keyword);
    });
  }, [byId, notebooks, query]);

  const selected = selectedId ? byId.get(selectedId) : undefined;
  const locked = busy || creating;

  if (!open || typeof document === "undefined") return null;

  const createNotebook = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const notebook = await api.createNotebook({ name });
      setNotebooks((current) => [...current, notebook]);
      setSelectedId(notebook.id);
      setNewName("");
      setCreatingOpen(false);
      // 侧栏知识树同步刷新，否则新建的库要等下次进去才出现
      window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_CHANGED_EVENT, {
        detail: { reason: "remote-link-create-notebook" },
      }));
    } catch (requestError: any) {
      setError(requestError?.message || "新建知识库失败");
    } finally {
      setCreating(false);
    }
  };

  const submit = () => {
    if (!selected || locked) return;
    onConfirm({ notebookId: selected.id, notebookName: selected.name });
  };

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 知识树形渲染：父 → 子缩进展示，与知识库侧边栏的层级一致 */
  const renderTree = (parentId: string | null, depth: number): React.ReactNode[] => {
    const list = childrenMap.get(parentId) || [];
    return list.flatMap((notebook) => {
      const children = childrenMap.get(notebook.id) || [];
      const isCollapsed = collapsed.has(notebook.id);
      const active = notebook.id === selectedId;
      const rows: React.ReactNode[] = [
        <TreeRow
          key={notebook.id}
          notebook={notebook}
          depth={depth}
          active={active}
          locked={locked}
          hasChildren={children.length > 0}
          collapsed={isCollapsed}
          onToggle={() => toggleCollapse(notebook.id)}
          onSelect={() => setSelectedId(notebook.id)}
          onDoubleClick={() => submit()}
        />,
      ];
      if (children.length > 0 && !isCollapsed) {
        rows.push(...renderTree(notebook.id, depth + 1));
      }
      return rows;
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 px-3 py-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-link-dialog-title"
        className="flex max-h-[min(82vh,40rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-2xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-app-border px-4 py-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
            <NotebookPen size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="remote-link-dialog-title" className="font-semibold text-tx-primary">链接到知识库</h2>
            <p className="mt-0.5 text-xs text-tx-tertiary">
              {count > 1
                ? `${count} 个文件会在所选知识库里出现为普通笔记，改完自动写回远程`
                : "文件会在所选知识库里出现为普通笔记，改完自动写回远程"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={locked}
            className="rounded-md p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary disabled:opacity-40"
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        </header>

        {error && (
          <div className="mx-4 mt-3 flex shrink-0 items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-500">
            <span className="min-w-0 break-words">{error}</span>
            <button
              type="button"
              onClick={() => void load()}
              className="shrink-0 rounded p-1 hover:bg-red-500/10"
              aria-label="重新加载知识库"
            >
              <RefreshCw size={14} />
            </button>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
          <div className="relative min-w-0 flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索知识库"
              className="h-8 pl-8 text-xs"
              disabled={locked}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 px-2 text-[11.5px]"
            disabled={locked}
            onClick={() => {
              setCreatingOpen((value) => !value);
              setNewName("");
            }}
          >
            <Plus size={12} className="mr-1" /> 新建
          </Button>
        </div>

        {creatingOpen && (
          <div className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-accent-primary/25 bg-accent-primary/5 px-2 py-2">
            <Input
              autoFocus
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createNotebook();
                }
              }}
              placeholder="新知识库名称"
              className="h-8 flex-1 text-xs"
              disabled={creating}
            />
            <Button
              size="sm"
              className="h-8 shrink-0 px-2 text-[11.5px]"
              disabled={creating || newName.trim() === ""}
              onClick={() => void createNotebook()}
            >
              {creating ? <Loader2 size={12} className="mr-1 animate-spin" /> : null} 创建
            </Button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 overscroll-contain">
          {loading ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-tx-tertiary">
              <Loader2 size={17} className="animate-spin" />正在加载知识库…
            </div>
          ) : notebooks.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center px-6 text-center">
              <Library size={26} className="mb-3 text-tx-tertiary" />
              <p className="text-sm font-medium text-tx-secondary">这个空间还没有知识库</p>
              <p className="mt-1.5 text-xs leading-5 text-tx-tertiary">点上方「新建」建一个，文档会直接放进去</p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-xs text-tx-tertiary">没有匹配的知识库</p>
          ) : (
            <div className="space-y-0.5">
              {query.trim()
                // 搜索模式：平铺 + 父链路径，命中才能被看到
                ? filtered.map((notebook) => {
                  const active = notebook.id === selectedId;
                  const path = notebookPath(notebook, byId);
                  return (
                    <TreeRow
                      key={notebook.id}
                      notebook={notebook}
                      depth={0}
                      active={active}
                      locked={locked}
                      hasChildren={false}
                      onSelect={() => setSelectedId(notebook.id)}
                      onDoubleClick={() => submit()}
                      path={path}
                    />
                  );
                })
                : renderTree(null, 0)}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-app-border px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-tx-tertiary">
            {selected ? `目标：${selected.name}` : "先选一个知识库"}
          </span>
          <Button size="sm" variant="outline" className="h-8 px-3 text-xs" disabled={locked} onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={!selected || locked}
            onClick={submit}
          >
            {busy ? <Loader2 size={12} className="mr-1 animate-spin" /> : null}
            {count > 1 ? `链接 ${count} 项` : "链接"}
          </Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

/** 树形/搜索两种模式下共用的知识库行 */
function TreeRow({
  notebook,
  depth,
  active,
  locked,
  hasChildren,
  collapsed,
  onToggle,
  onSelect,
  onDoubleClick,
  path,
}: {
  notebook: Notebook;
  depth: number;
  active: boolean;
  locked: boolean;
  hasChildren: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  onSelect: () => void;
  onDoubleClick?: () => void;
  path?: string;
}) {
  const isRootNotebook = !notebook.parentId;
  return (
    <div
      role="radio"
      aria-checked={active}
      tabIndex={locked ? -1 : 0}
      onClick={() => { if (!locked) onSelect(); }}
      onDoubleClick={() => { if (!locked) onDoubleClick?.(); }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (!locked) onSelect();
        }
      }}
      style={{ paddingLeft: 8 + depth * 14 }}
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md pr-2 text-left text-[13px] transition-colors",
        active
          ? "bg-[#e8efff] font-medium text-accent-primary dark:bg-accent-primary/15"
          : "text-tx-secondary hover:bg-app-hover",
        locked && "pointer-events-none opacity-60",
      )}
    >
      {hasChildren ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={collapsed ? "展开" : "折叠"}
          onClick={(event) => { event.stopPropagation(); onToggle?.(); }}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-tx-tertiary hover:text-tx-primary"
        >
          <ChevronRight size={12} className={cn("transition-transform", !collapsed && "rotate-90")} />
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}
      {/* 与知识库侧栏一致：根层知识库用彩色书本封面，子层用文件夹 */}
      {isRootNotebook
        ? notebookCoverIcon(notebook.icon, 15)
        : <Folder size={14} strokeWidth={2} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />}
      <span className={cn("min-w-0 flex-1 truncate", active ? "text-accent-primary" : "text-tx-primary")}>
        {notebook.name}
      </span>
      {path ? (
        <span className="hidden max-w-[42%] shrink-0 truncate text-[11px] text-tx-tertiary sm:block">{path}</span>
      ) : null}
      {active ? <Check size={14} strokeWidth={2.5} className="shrink-0 text-accent-primary" /> : null}
    </div>
  );
}
