import { useMemo, useState } from "react";
import { ArrowUp, ChevronRight, FolderInput, Loader2, Trash2, TreePine, X } from "lucide-react";

import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { knowledgeTreeIconFor } from "@/lib/knowledgeTreeIcons";
import {
  knowledgeTreeDescendantIds,
  topLevelSelectedKnowledgeNodes,
} from "@/lib/knowledgeTreeMultiSelect";
import { toast } from "@/lib/toast";

export function KnowledgeTreeBatchToolbar({
  count,
  canMove,
  canDelete,
  onMove,
  onDelete,
  onClear,
}: {
  count: number;
  canMove: boolean;
  canDelete: boolean;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="mx-2 mb-1 flex h-9 shrink-0 items-center gap-1 rounded-lg border border-accent-primary/20 bg-accent-primary/5 px-2 text-xs text-tx-secondary">
      <span className="min-w-0 flex-1 truncate font-medium">已选择 {count} 项</span>
      <button type="button" disabled={!canMove || count === 0} onClick={onMove} className="inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-40">
        <FolderInput size={13} />移动
      </button>
      <button type="button" disabled={!canDelete || count === 0} onClick={onDelete} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-red-500 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40">
        <Trash2 size={13} />删除
      </button>
      <button type="button" onClick={onClear} className="flex h-7 w-7 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary" aria-label="取消选择" title="取消选择">
        <X size={14} />
      </button>
    </div>
  );
}

export function KnowledgeTreeBatchMovePanel({
  selectedNodes,
  nodes,
  targetNodes,
  onMoved,
  onClose,
}: {
  selectedNodes: KnowledgeTreeNode[];
  nodes: KnowledgeTreeNode[];
  targetNodes: KnowledgeTreeNode[];
  onMoved: (movedNodeIds: string[]) => void;
  onClose: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const roots = useMemo(
    () => topLevelSelectedKnowledgeNodes(nodes, selectedNodes.map((node) => node.id)),
    [nodes, selectedNodes],
  );
  const blocked = useMemo(
    () => knowledgeTreeDescendantIds(roots.map((node) => node.id), nodes),
    [nodes, roots],
  );
  const candidates = useMemo(() => targetNodes.filter((candidate) => (
    !blocked.has(candidate.id)
    && candidate.access.capabilities.canCreate
    && roots.every((source) => (
      source.scopeKey === candidate.scopeKey
      && (source.sharedRootId
        ? source.sharedRootId === candidate.sharedRootId
        : !candidate.sharedRootId)
    ))
  )).sort((left, right) => left.title.localeCompare(right.title)), [blocked, roots, targetNodes]);
  // 复制出来的路径必须有文件夹宿主，不能落到根层。
  const allowRoot = roots.length > 0 && roots.every((node) => !node.sharedRootId && !node.isReference);

  const move = async (parentId: string | null) => {
    if (roots.length === 0 || moving) return;
    if (roots.every((node) => (node.parentId ?? null) === parentId)) {
      onClose();
      return;
    }
    setMoving(true);
    try {
      const result = await knowledgeTreeApi.batchMove(roots.map((node) => node.id), { parentId });
      toast.success(`已移动 ${selectedNodes.length} 项`);
      onMoved(result.nodeIds);
      onClose();
    } catch (error: any) {
      toast.error(error?.message || "批量移动失败");
    } finally {
      setMoving(false);
    }
  };

  // ===== 文件夹浏览器（VSCode 式）：点文件夹进入下一级，面包屑/上级返回，「移动到此处」落点 =====
  // 当前所在目录：null = 全空间根层。初始即根层。
  const [currentId, setCurrentId] = useState<string | null>(null);

  const candidateIds = useMemo(() => new Set(candidates.map((node) => node.id)), [candidates]);
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, KnowledgeTreeNode[]>();
    for (const node of targetNodes) {
      if (node.isDeleted) continue;
      map.set(node.parentId, [...(map.get(node.parentId) ?? []), node]);
    }
    return map;
  }, [targetNodes]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  // 当前层的可落点（保持候选过滤）；文件夹排前、可进入，其余不可点
  const currentEntries = useMemo(() => {
    const entries = (childrenOf.get(currentId) ?? []).filter((node) => candidateIds.has(node.id));
    return entries.sort((left, right) => {
      if ((left.nodeType === "folder") !== (right.nodeType === "folder")) return left.nodeType === "folder" ? -1 : 1;
      return left.title.localeCompare(right.title);
    });
  }, [childrenOf, currentId, candidateIds]);

  // 面包屑链：根目录 → … → 当前目录
  const crumbs = useMemo(() => {
    const chain: KnowledgeTreeNode[] = [];
    let current = currentId ? nodeById.get(currentId) : undefined;
    while (current) {
      chain.unshift(current);
      current = current.parentId ? nodeById.get(current.parentId) : undefined;
    }
    return chain;
  }, [currentId, nodeById]);

  // 落点合法性：当前目录本身是候选，或处于根层且根层被允许
  const currentIsCandidate = currentId === null ? allowRoot : candidateIds.has(currentId);
  const alreadyHere = roots.length > 0 && roots.every((node) => (node.parentId ?? null) === currentId);

  return (
    <div className="absolute inset-0 z-[220] flex flex-col bg-app-sidebar" onClick={(event) => event.stopPropagation()}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-app-border px-3">
        <FolderInput size={16} className="text-amber-500" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-tx-primary">移动 {selectedNodes.length} 项</div>
        {moving && <Loader2 size={14} className="animate-spin text-tx-tertiary" />}
        <button type="button" disabled={moving} onClick={onClose} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover disabled:opacity-40" aria-label="关闭移动面板"><X size={16} /></button>
      </header>
      {/* 面包屑 + 上一级：与 Linux 文件选择器同交互 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-app-border px-2">
        <button
          type="button"
          disabled={moving || currentId === null}
          onClick={() => setCurrentId(nodeById.get(currentId ?? "")?.parentId ?? null)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="上一级"
          title="上一级"
        >
          <ArrowUp size={14} />
        </button>
        <div className="min-w-0 flex-1 truncate text-xs text-tx-secondary">
          <button
            type="button"
            onClick={() => setCurrentId(null)}
            className={`rounded px-1 py-0.5 hover:bg-app-hover ${currentId === null ? "font-medium text-tx-primary" : "text-tx-tertiary hover:text-tx-primary"}`}
          >
            根目录
          </button>
          {crumbs.map((crumb) => (
            <span key={crumb.id}>
              <ChevronRight size={11} className="inline text-app-border" />
              <button
                type="button"
                onClick={() => setCurrentId(crumb.id)}
                className={`rounded px-1 py-0.5 hover:bg-app-hover ${crumb.id === currentId ? "font-medium text-tx-primary" : "text-tx-tertiary hover:text-tx-primary"}`}
              >
                {crumb.title}
              </button>
            </span>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {currentEntries.map((entry) => {
          const isFolder = entry.nodeType === "folder";
          const disabled = moving || !isFolder || roots.every((node) => node.parentId === entry.id);
          return (
            <button
              key={entry.id}
              type="button"
              disabled={disabled}
              onClick={() => isFolder && setCurrentId(entry.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40 ${isFolder ? "" : "opacity-60"}`}
            >
              <span className="shrink-0">{knowledgeTreeIconFor(entry, entry.parentId === null && entry.resourceType === "notebook")}</span>
              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
              {isFolder && <ChevronRight size={13} className="shrink-0 text-tx-tertiary" />}
            </button>
          );
        })}
        {currentEntries.length === 0 && (
          <p className="py-10 text-center text-xs text-tx-tertiary">
            {currentId === null && !allowRoot ? "根层不可作为目标，请进入一个文件夹" : "此目录下没有可进入的子文件夹"}
          </p>
        )}
      </div>
      {/* 落点：移动到当前所在目录 */}
      <div className="shrink-0 border-t border-app-border p-2">
        <button
          type="button"
          disabled={moving || !currentIsCandidate || alreadyHere}
          onClick={() => void move(currentId)}
          className="flex w-full items-center justify-center gap-1.5 rounded-full bg-accent-primary px-4 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {moving ? <Loader2 size={13} className="animate-spin" /> : <TreePine size={13} />}
          {currentId === null ? "移动到根目录" : alreadyHere ? "已在此目录" : `移动到「${crumbs[crumbs.length - 1]?.title ?? ""}」`}
        </button>
      </div>
    </div>
  );
}
