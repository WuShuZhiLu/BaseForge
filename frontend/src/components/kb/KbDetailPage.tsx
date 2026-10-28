/**
 * 知识库 Overview（主区虚拟页）：route.kind === "kb"（/kb/:space/:kbId）。
 *
 * v2 定稿（proto-kb-single-tree-v2 / DESIGN-KB-SINGLE-TREE §2.3）：
 * - 侧栏单击库根行 = 展开子树 + 进入本页；本页不是 notes 记录、不计入文档数
 * - 统计 = 子树内文档数 / 字数（contentText 长度）/ 最近更新时间
 * - 目录带时间戳：点文件夹 = 目录内展开 + 侧栏树 reveal（不离开 Overview）；
 *   点文档 = 打开编辑器（kbNoteAppPath / sheet 深链）
 * - 空库 = 空态引导新建第一篇文档
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FaBook, FaFolder } from "react-icons/fa";
import { FileCode, FileText, Plus, Table2 } from "lucide-react";

import { api, getCurrentWorkspace } from "@/lib/api";
import {
  knowledgeTreeApi,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import type { NoteListItem } from "@/types";
import { pushAppPathState } from "@/lib/appPathNavigation";
import { kbNoteAppPath } from "@/lib/appRoute";
import { pushSheetAppPath } from "@/lib/sheetDeepLink";
import { toast } from "@/lib/toast";

const fmtTs = (ts: string) => {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const isFolderNode = (node: KnowledgeTreeNode) => node.nodeType === "folder";

export default function KbDetailPage({ kbId }: { kbId: string }) {
  const [nodes, setNodes] = useState<KnowledgeTreeNode[] | null>(null);
  const [notebooks, setNotebooks] = useState<Map<string, string> | null>(null);
  const [notes, setNotes] = useState<Map<string, NoteListItem> | null>(null);
  const [tocOpen, setTocOpen] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    knowledgeTreeApi.list()
      .then((res) => { if (!cancelled) setNodes(res.nodes); })
      .catch(() => { if (!cancelled) setNodes([]); });
    api.getNotes()
      .then((items) => { if (!cancelled) setNotes(new Map(items.map((n) => [n.id, n]))); })
      .catch(() => { if (!cancelled) setNotes(new Map()); });
    api.getNotebooks()
      .then((items) => { if (!cancelled) setNotebooks(new Map(items.map((nb) => [nb.id, nb.description ?? ""]))); })
      .catch(() => { if (!cancelled) setNotebooks(new Map()); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => load(), [load]);

  // 树在侧栏被增删改后同步刷新（同一事件驱动）
  useEffect(() => {
    const onChange = () => load();
    window.addEventListener("nowen:knowledge-tree-changed", onChange);
    return () => window.removeEventListener("nowen:knowledge-tree-changed", onChange);
  }, [load]);

  const kbNode = useMemo(
    () => nodes?.find((n) => n.resourceId === kbId && n.resourceType === "notebook" && !n.isDeleted) ?? null,
    [nodes, kbId],
  );

  const childrenMap = useMemo(() => {
    const map = new Map<string | null, KnowledgeTreeNode[]>();
    for (const node of nodes ?? []) {
      if (node.isDeleted) continue;
      const arr = map.get(node.parentId) ?? [];
      arr.push(node);
      map.set(node.parentId, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return map;
  }, [nodes]);

  // 目录时间戳 = 子树内该节点及子孙的最大 updatedAt
  const subtreeUpdatedAt = useMemo(() => {
    const map = new Map<string, string>();
    if (!kbNode) return map;
    const walk = (id: string): string => {
      let latest = "";
      for (const child of childrenMap.get(id) ?? []) {
        const childLatest = isFolderNode(child)
          ? walk(child.id)
          : notes?.get(child.resourceId)?.updatedAt ?? child.updatedAt;
        if (childLatest > latest) latest = childLatest;
        map.set(child.id, childLatest);
      }
      return latest;
    };
    walk(kbNode.id);
    return map;
  }, [kbNode, childrenMap, notes]);

  // 统计口径：只算子树内非 folder 节点；本页不计入
  const stats = useMemo(() => {
    if (!kbNode) return null;
    let docCount = 0;
    let charCount = 0;
    let updatedAt = kbNode.updatedAt;
    const walk = (id: string) => {
      for (const child of childrenMap.get(id) ?? []) {
        if (isFolderNode(child)) {
          walk(child.id);
          continue;
        }
        docCount += 1;
        const note = notes?.get(child.resourceId);
        charCount += note ? note.contentText?.length ?? 0 : 0;
        const ts = note?.updatedAt ?? child.updatedAt;
        if (ts > updatedAt) updatedAt = ts;
      }
    };
    walk(kbNode.id);
    return { docCount, charCount, updatedAt };
  }, [kbNode, childrenMap, notes]);

  const openDoc = useCallback((node: KnowledgeTreeNode) => {
    const ws = getCurrentWorkspace();
    // 表格走深链；导图归一后是笔记文档（contentFormat="mindmap"），直接当笔记打开
    if (node.noteType === "sheet") {
      pushSheetAppPath(node.resourceId);
      return;
    }
    if (node.resourceType === "file") {
      toast.info("文件节点请在侧栏中打开");
      return;
    }
    pushAppPathState(kbNoteAppPath(ws, kbId, node.resourceId));
  }, [kbId]);

  const createDoc = useCallback(async () => {
    if (!kbNode || creating) return;
    setCreating(true);
    try {
      const created = await knowledgeTreeApi.create({
        parentId: kbNode.id,
        nodeType: "note",
        title: "新建文档",
      });
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
      const ws = getCurrentWorkspace();
      pushAppPathState(kbNoteAppPath(ws, kbId, created.resourceId));
    } catch (err) {
      console.error("[KbDetailPage] create doc failed:", err);
      toast.error("新建文档失败");
    } finally {
      setCreating(false);
    }
  }, [kbNode, creating, kbId]);

  // 目录点文件夹：目录内展开 + 侧栏树 reveal（不离开 Overview）
  const toggleToc = useCallback((id: string) => {
    setTocOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renderTocRows = (parentId: string, depth: number): React.ReactNode => {
    const children = childrenMap.get(parentId) ?? [];
    return children.map((node) => {
      const ts = fmtTs(subtreeUpdatedAt.get(node.id) ?? node.updatedAt);
      const indent = { paddingLeft: 12 + depth * 20 };
      if (isFolderNode(node)) {
        const hasKids = (childrenMap.get(node.id) ?? []).length > 0;
        const open = tocOpen.has(node.id);
        return (
          <React.Fragment key={node.id}>
            <button
              type="button"
              onClick={() => { toggleToc(node.id); if (!open) window.dispatchEvent(new CustomEvent("nowen:kb-reveal-node", { detail: { nodeId: node.id } })); }}
              className="flex w-full items-center gap-2 rounded-md py-2 pr-2 text-left text-[13.5px] text-tx-primary hover:bg-app-hover"
              style={indent}
            >
              <span className={`w-3 shrink-0 text-tx-tertiary transition-transform ${hasKids ? (open ? "rotate-90" : "") : "opacity-0"}`}>▸</span>
              <FaFolder size={13} className="shrink-0 text-amber-500" />
              <span className="min-w-0 flex-1 truncate font-medium">{node.title}</span>
              <span className="shrink-0 text-[11.5px] tabular-nums text-tx-tertiary">{ts}</span>
            </button>
            {open && hasKids && renderTocRows(node.id, depth + 1)}
          </React.Fragment>
        );
      }
      const icon = node.noteType === "sheet"
        ? <Table2 size={13} className="shrink-0 text-sky-500" />
        : node.contentFormat === "markdown"
          ? <FileCode size={13} className="shrink-0 text-emerald-500" />
          : <FileText size={13} className="shrink-0 text-accent-primary" />;
      return (
        <button
          key={node.id}
          type="button"
          onClick={() => openDoc(node)}
          className="flex w-full items-center gap-2 rounded-md py-2 pr-2 text-left text-[13.5px] text-tx-primary hover:bg-app-hover"
          style={indent}
        >
          <span className="w-3 shrink-0" />
          {icon}
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
          <span className="shrink-0 text-[11.5px] tabular-nums text-tx-tertiary">{ts}</span>
        </button>
      );
    });
  };

  if (nodes === null) {
    return <div className="flex flex-1 items-center justify-center text-[12px] text-tx-tertiary">加载中…</div>;
  }

  if (!kbNode) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-tx-tertiary">
        <FaBook size={28} className="opacity-40" />
        <p className="text-[13px]">知识库不存在或已被删除</p>
      </div>
    );
  }

  const description = notebooks?.get(kbId) ?? "";
  const isEmpty = stats?.docCount === 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-10 pb-24 pt-12">
        {/* 头部：图标 / 标题 / 统计 / 新建 */}
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-amber-100">
            <FaBook size={24} className="text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[22px] font-semibold text-tx-primary">{kbNode.title}</h1>
            {stats && (
              <p className="mt-1.5 text-[12.5px] text-tx-tertiary">
                <b className="text-tx-secondary">{stats.docCount}</b> 文档
                · <b className="text-tx-secondary">{stats.charCount}</b> 字
                · 更新于 {fmtTs(stats.updatedAt) || "—"}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void createDoc()}
            disabled={creating}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent-primary px-4 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            <Plus size={14} />
            新建文档
          </button>
        </div>

        {/* 库简介（notebooks.description） */}
        {description && (
          <p className="mt-6 rounded-xl border border-app-border bg-app-panel px-4 py-3 text-[13px] leading-relaxed text-tx-secondary">
            {description}
          </p>
        )}

        {isEmpty ? (
          <div className="mt-14 rounded-xl border-[1.5px] border-dashed border-app-border bg-app-panel px-6 py-12 text-center">
            <FaBook size={30} className="mx-auto opacity-30" />
            <h3 className="mt-3 text-[15px] font-medium text-tx-primary">这个知识库还没有内容</h3>
            <p className="mt-1 text-[12.5px] text-tx-tertiary">创建第一篇文档，开始沉淀你的知识</p>
            <button
              type="button"
              onClick={() => void createDoc()}
              disabled={creating}
              className="mt-5 flex items-center gap-1.5 rounded-full bg-accent-primary px-5 py-2.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              <Plus size={14} />
              新建第一篇文档
            </button>
          </div>
        ) : (
          <>
            <div className="mt-8 mb-2 flex items-baseline">
              <h3 className="text-[12px] font-medium uppercase tracking-[0.12em] text-tx-tertiary">目录</h3>
              <span className="ml-3 text-[11.5px] text-tx-tertiary">点击直达 · 右侧为最近更新时间</span>
            </div>
            <div className="pb-4">
              {renderTocRows(kbNode.id, 0)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
