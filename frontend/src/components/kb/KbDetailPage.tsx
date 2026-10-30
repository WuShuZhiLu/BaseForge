/**
 * 知识库 Overview（主区虚拟页）：route.kind === "kb"（/kb/:space/:kbId）。
 *
 * v2 定稿（proto-kb-single-tree-v2 / DESIGN-KB-SINGLE-TREE §2.3）：
 * - 侧栏单击库根行 = 展开子树 + 进入本页；本页不是 notes 记录、不计入文档数
 * - 统计 = 子树内文档数 / 字数（contentText 长度）/ 最近更新时间
 * - 目录带时间戳与虚线引导线：点文件夹 = 目录内展开 + 侧栏树 reveal（不离开 Overview）；
 *   点文档 = 打开编辑器（kbNoteAppPath / sheet 深链）
 * - 头部动作区 = 收藏 / 分享 / 新建文档 / 更多（定位、导出）
 * - 空库 = 空态引导新建第一篇文档
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaBook, FaStar, FaRegStar } from "react-icons/fa";
import { Bold, ChevronRight, Code as CodeIcon, Italic, Link as LinkIcon, List, ListOrdered, MoreHorizontal, NotebookPen, Pencil, Plus, Strikethrough, Trash2 } from "lucide-react";

import { getCurrentWorkspace } from "@/lib/api";
import {
  knowledgeTreeApi,
  type KnowledgeNodeStats,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import { api } from "@/lib/api";
import { pushAppPathState, resolveCurrentAppPathname } from "@/lib/appPathNavigation";
import { kbNoteAppPath } from "@/lib/appRoute";
import { pushSheetAppPath } from "@/lib/sheetDeepLink";
import { toast } from "@/lib/toast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import NotebookShareDialog from "@/components/NotebookShareDialog";
import type { Notebook } from "@/types";

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
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null);
  // 统计走服务端聚合（文档数/字数/最近更新/贡献者）：不再全量拉 notes 本地累加。
  const [stats, setStats] = useState<KnowledgeNodeStats | null>(null);
  const [tocOpen, setTocOpen] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  // 重命名（标题行内 input）与总览编辑（简介弹窗）
  const [renaming, setRenaming] = useState<string | null>(null);
  const [descEditing, setDescEditing] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const descTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [descOverflow, setDescOverflow] = useState(false);
  const descDisplayRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    knowledgeTreeApi.list()
      .then((res) => { if (!cancelled) setNodes(res.nodes); })
      .catch(() => { if (!cancelled) setNodes([]); });
    api.getNotebooks()
      .then((items) => { if (!cancelled) setNotebooks(items); })
      .catch(() => { if (!cancelled) setNotebooks([]); });
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

  const notebook = notebooks?.find((nb) => nb.id === kbId) ?? null;
  const description = notebook?.description ?? "";

  // 简介是否超 2 行（折叠态下 clientHeight 被裁剪，用 scrollHeight 比较）。
  // 必须放在早退 return 之前：hooks 数量在所有分支下要一致。
  useEffect(() => {
    const element = descDisplayRef.current;
    if (!element || descriptionExpanded) { setDescOverflow(false); return; }
    setDescOverflow(element.scrollHeight > element.clientHeight + 1);
  }, [description, descriptionExpanded]);

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

  // 目录时间戳 = 子树内该节点及子孙的最大 updatedAt（节点自身的 updatedAt 由触发器随笔记更新）
  const subtreeUpdatedAt = useMemo(() => {
    const map = new Map<string, string>();
    if (!kbNode) return map;
    const walk = (id: string): string => {
      let latest = "";
      for (const child of childrenMap.get(id) ?? []) {
        const childLatest = isFolderNode(child) ? walk(child.id) : child.updatedAt;
        if (childLatest > latest) latest = childLatest;
        map.set(child.id, childLatest);
      }
      return latest;
    };
    walk(kbNode.id);
    return map;
  }, [kbNode, childrenMap]);

  // 统计：优先服务端聚合（含字数/贡献者）；接口不可用时回落到树数据本地计数
  const localStats = useMemo(() => {
    if (!kbNode) return null;
    let docCount = 0;
    let updatedAt = kbNode.updatedAt;
    const walk = (id: string) => {
      for (const child of childrenMap.get(id) ?? []) {
        if (child.updatedAt > updatedAt) updatedAt = child.updatedAt;
        if (isFolderNode(child)) { walk(child.id); continue; }
        docCount += 1;
      }
    };
    walk(kbNode.id);
    return { docCount, updatedAt };
  }, [kbNode, childrenMap]);

  const kbNodeId = kbNode?.id ?? null;
  useEffect(() => {
    if (!kbNodeId) { setStats(null); return; }
    let cancelled = false;
    knowledgeTreeApi.stats(kbNodeId)
      .then((res) => { if (!cancelled) setStats(res); })
      .catch(() => { if (!cancelled) setStats(null); });
    return () => { cancelled = true; };
  }, [kbNodeId]);

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

  // 收藏/取消收藏知识库（树节点的 isFavorite，与侧栏收藏区共用一份数据）
  const toggleFavorite = useCallback(async () => {
    if (!kbNode) return;
    const next = kbNode.isFavorite === 1 ? 0 : 1;
    try {
      await knowledgeTreeApi.update(kbNode.id, { isFavorite: next });
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
    } catch (err) {
      console.error("[KbDetailPage] toggle favorite failed:", err);
      toast.error(next === 1 ? "收藏失败" : "取消收藏失败");
    }
  }, [kbNode]);

  // 目录点文件夹：目录内展开 + 侧栏树 reveal（不离开 Overview）
  const toggleToc = useCallback((id: string) => {
    setTocOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 行内重命名：提交后由树变更事件刷新侧栏与本页标题
  const commitRename = useCallback(async () => {
    if (!kbNode || renaming === null) return;
    const title = renaming.trim();
    setRenaming(null);
    if (!title || title === kbNode.title) return;
    try {
      await knowledgeTreeApi.update(kbNode.id, { title });
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
    } catch (err) {
      console.error("[KbDetailPage] rename kb failed:", err);
      toast.error("重命名失败");
    }
  }, [kbNode, renaming]);

  // 删除知识库：删除后退出 Overview（去掉 ?tree= 进入态，与侧栏 exitKb 同语义）
  const deleteKb = useCallback(async () => {
    if (!kbNode) return;
    try {
      await knowledgeTreeApi.remove(kbNode.id, "subtree");
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed"));
      const params = new URLSearchParams(window.location.search);
      params.delete("tree");
      const qs = params.toString();
      pushAppPathState(`${resolveCurrentAppPathname()}${qs ? `?${qs}` : ""}`);
    } catch (err) {
      console.error("[KbDetailPage] delete kb failed:", err);
      toast.error("删除知识库失败");
    }
  }, [kbNode]);

  // 编辑总览：保存知识库描述（notebooks.description）
  const commitDescription = useCallback(async () => {
    const trimmed = descDraft.trim();
    setDescEditing(false);
    setDescriptionExpanded(false);
    try {
      await api.updateNotebook(kbId, { description: trimmed });
      setNotebooks((current) => (current ?? []).map((nb) => (nb.id === kbId ? { ...nb, description: trimmed } : nb)));
    } catch (err) {
      console.error("[KbDetailPage] update description failed:", err);
      toast.error("保存简介失败");
    }
  }, [descDraft, kbId]);

  // 简介编辑工具条：把选中文本包上 Markdown 标记（加粗/斜体/删除线/链接/代码）
  const wrapDescSelection = useCallback((before: string, after = before, placeholder = "") => {
    const textarea = descTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = descDraft;
    const selected = value.slice(start, end) || placeholder;
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    setDescDraft(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }, [descDraft]);

  // 列表：给选中的每一行加前缀（"- " / "1. "），再按一次去掉
  const toggleDescListPrefix = useCallback((ordered: boolean) => {
    const textarea = descTextareaRef.current;
    if (!textarea) return;
    const value = descDraft;
    const start = value.lastIndexOf("\n", textarea.selectionStart - 1) + 1;
    const end = value.indexOf("\n", textarea.selectionEnd);
    const stop = end === -1 ? value.length : end;
    const block = value.slice(start, stop);
    const prefix = ordered ? "1. " : "- ";
    const lines = block.split("\n");
    const allListed = lines.every((line) => line.startsWith(prefix));
    const nextBlock = lines
      .map((line, index) => (allListed ? line.slice(prefix.length) : `${ordered ? `${index + 1}. ` : prefix}${line}`))
      .join("\n");
    setDescDraft(`${value.slice(0, start)}${nextBlock}${value.slice(stop)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start, start + nextBlock.length);
    });
  }, [descDraft]);

  // 点击“更多”菜单外任意位置关闭
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreOpen]);

  const revealNode = useCallback((nodeId: string) => {
    window.dispatchEvent(new CustomEvent("nowen:kb-reveal-node", { detail: { nodeId } }));
  }, []);

  const renderTocRows = (parentId: string, depth: number): React.ReactNode => {
    const children = childrenMap.get(parentId) ?? [];
    return children.map((node) => {
      const ts = fmtTs(subtreeUpdatedAt.get(node.id) ?? node.updatedAt);
      const indent = { paddingLeft: depth * 24 };
      if (isFolderNode(node)) {
        const hasKids = (childrenMap.get(node.id) ?? []).length > 0;
        const open = tocOpen.has(node.id);
        return (
          <React.Fragment key={node.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => { toggleToc(node.id); if (!open) revealNode(node.id); }}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { toggleToc(node.id); if (!open) revealNode(node.id); } }}
              className="group flex h-9 w-full cursor-pointer select-none items-center gap-2 rounded-md pr-2 text-left text-[13.5px] text-tx-primary hover:bg-app-hover"
              style={indent}
            >
              <span className={`flex w-4 shrink-0 items-center justify-center text-tx-tertiary ${hasKids ? "" : "opacity-0"}`}>
                <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
              </span>
              <span className="shrink-0 text-[13px] leading-none">📁</span>
              <span className="max-w-[70%] shrink-0 truncate whitespace-nowrap font-medium">{node.title}</span>
              {/* 虚线引导线：标题与时间之间的视线通道 */}
              <span className="mx-2 h-0 min-w-4 flex-1 border-t border-dashed border-app-border" />
              <span className="shrink-0 text-[11.5px] tabular-nums text-tx-tertiary">{ts}</span>
            </div>
            {open && hasKids && renderTocRows(node.id, depth + 1)}
          </React.Fragment>
        );
      }
      const icon = <span className="shrink-0 text-[13px] leading-none">{node.noteType === "sheet" ? "📊" : "📄"}</span>;
      return (
        <div
          key={node.id}
          role="button"
          tabIndex={0}
          onClick={() => openDoc(node)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openDoc(node); }}
          className="group flex h-9 w-full cursor-pointer select-none items-center gap-2 rounded-md pr-2 text-left text-[13.5px] text-tx-primary hover:bg-app-hover"
          style={indent}
        >
          <span className="w-4 shrink-0" />
          {icon}
          <span className="max-w-[70%] shrink-0 truncate whitespace-nowrap">
            {node.title}
            {node.isReference && <span className="ml-1 text-[10px] text-tx-tertiary" title="同一份内容的另一条路径">🔗</span>}
          </span>
          <span className="mx-2 h-0 min-w-4 flex-1 border-t border-dashed border-app-border" />
          <span className="shrink-0 text-[11.5px] tabular-nums text-tx-tertiary">{ts}</span>
        </div>
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

  // 统计展示：服务端优先，本地树数据兜底（接口不可用时字数显示为 —）
  const docCount = stats?.docCount ?? localStats?.docCount ?? 0;
  const charCount = stats?.charCount ?? null;
  const updatedAt = stats?.updatedAt || localStats?.updatedAt || "";
  const contributors = stats?.contributors ?? [];
  const isEmpty = docCount === 0;
  const avatarColors = ["#2563eb", "#0891b2", "#7c3aed"];
  const isFavorite = kbNode.isFavorite === 1;

  return (
    <div className="flex-1 overflow-y-auto bg-app-bg dark:bg-app-surface">
      <div className="mx-auto max-w-3xl px-10 pb-24 pt-12">
        {/* 头部：图标 / 标题 / 统计 / 动作区（收藏 / 分享 / 新建 / 更多） */}
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-amber-100">
            <FaBook size={24} className="text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            {renaming !== null ? (
              <input
                autoFocus
                value={renaming}
                onChange={(event) => setRenaming(event.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void commitRename();
                  if (event.key === "Escape") setRenaming(null);
                }}
                className="w-full rounded-md border border-app-border bg-app-bg px-2 py-0.5 text-[20px] font-semibold text-tx-primary outline-none no-focus-ring focus:border-accent-primary"
              />
            ) : (
              <h1 className="truncate text-[22px] font-semibold text-tx-primary">{kbNode.title}</h1>
            )}
            <p className="mt-1.5 text-[12.5px] text-tx-tertiary">
              <b className="text-tx-secondary">{docCount}</b> 文档
              {charCount !== null && <> <span className="mx-1 text-app-border">·</span> <b className="text-tx-secondary">{charCount}</b> 字</>}
              <span className="mx-1 text-app-border">·</span> 更新于 {fmtTs(updatedAt) || "—"}
            </p>
            {contributors.length > 0 && (
              <div className="mt-3 flex items-center gap-2 text-[12px] text-tx-tertiary">
                <div className="flex items-center">
                  {contributors.map((contributor, index) => (
                    <span
                      key={contributor.userId}
                      title={`${contributor.displayName || contributor.username} · ${contributor.docCount} 篇`}
                      className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-app-bg text-[10px] font-medium text-white"
                      style={{
                        marginLeft: index === 0 ? 0 : -7,
                        background: avatarColors[index % avatarColors.length],
                      }}
                    >
                      {(contributor.displayName || contributor.username).slice(0, 1).toUpperCase()}
                    </span>
                  ))}
                </div>
                <span>{contributors.length > 1 ? `等 ${contributors.length} 人` : ""} 参与编写</span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void toggleFavorite()}
              className={`flex items-center gap-1.5 rounded-full border border-app-border bg-app-elevated px-3.5 py-1.5 text-[12.5px] hover:bg-app-hover ${isFavorite ? "text-amber-500" : "text-tx-secondary"}`}
            >
              {isFavorite ? <FaStar size={12} /> : <FaRegStar size={12} />}
              {isFavorite ? "已收藏" : "收藏"}
            </button>
            <button
              type="button"
              onClick={() => setSharing(true)}
              className="rounded-full border border-app-border bg-app-elevated px-3.5 py-1.5 text-[12.5px] text-tx-secondary hover:bg-app-hover"
            >
              分享
            </button>
            <button
              type="button"
              onClick={() => void createDoc()}
              disabled={creating}
              className="flex items-center gap-1.5 rounded-full bg-accent-primary px-4 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              <Plus size={14} />
              新建文档
            </button>
            <div className="relative" ref={moreRef}>
              <button
                type="button"
                onClick={() => setMoreOpen((open) => !open)}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-app-border bg-app-elevated text-tx-secondary hover:bg-app-hover"
                aria-label="更多操作"
              >
                <MoreHorizontal size={14} />
              </button>
              {moreOpen && (
                <div className="absolute right-0 top-9 z-10 w-44 rounded-xl border border-app-border bg-app-bg p-1 shadow-lg">
                  <button
                    type="button"
                    onClick={() => { setMoreOpen(false); setRenaming(kbNode.title); }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-tx-primary hover:bg-app-hover"
                  >
                    <Pencil size={13} className="text-tx-tertiary" />
                    重命名
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMoreOpen(false); setDescDraft(notebook?.description ?? ""); setDescEditing(true); }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-tx-primary hover:bg-app-hover"
                  >
                    <NotebookPen size={13} className="text-tx-tertiary" />
                    编辑总览
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMoreOpen(false); void deleteKb(); }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-red-600 hover:bg-red-500/10 dark:text-red-400"
                  >
                    <Trash2 size={13} />
                    删除知识库
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 库简介（notebooks.description，Markdown）：点击或经"更多 → 编辑总览"在原位编辑 */}
        {descEditing ? (
          <div className="mt-5">
            {/* 语雀式总览编辑卡：工具条在卡内顶部，编辑区无边框，底部为动作区 */}
            <div className="rounded-xl border border-app-border bg-app-elevated transition-colors focus-within:border-accent-primary/60">
              <div className="flex items-center gap-0.5 px-2.5 pt-2">
                <button type="button" title="加粗" onMouseDown={(event) => event.preventDefault()} onClick={() => wrapDescSelection("**", "**", "加粗文字")}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-tx-secondary hover:bg-app-hover"><Bold size={14} /></button>
                <button type="button" title="斜体" onMouseDown={(event) => event.preventDefault()} onClick={() => wrapDescSelection("*", "*", "斜体文字")}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-tx-secondary hover:bg-app-hover"><Italic size={14} /></button>
                <button type="button" title="删除线" onMouseDown={(event) => event.preventDefault()} onClick={() => wrapDescSelection("~~", "~~", "删除文字")}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-tx-secondary hover:bg-app-hover"><Strikethrough size={14} /></button>
                <span className="mx-1 h-4 w-px bg-app-border" />
                <button type="button" title="有序列表" onMouseDown={(event) => event.preventDefault()} onClick={() => toggleDescListPrefix(true)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-tx-secondary hover:bg-app-hover"><ListOrdered size={14} /></button>
                <button type="button" title="无序列表" onMouseDown={(event) => event.preventDefault()} onClick={() => toggleDescListPrefix(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-tx-secondary hover:bg-app-hover"><List size={14} /></button>
                <span className="mx-1 h-4 w-px bg-app-border" />
                <button type="button" title="链接" onMouseDown={(event) => event.preventDefault()} onClick={() => wrapDescSelection("[", "](https://)", "链接文字")}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-tx-secondary hover:bg-app-hover"><LinkIcon size={14} /></button>
                <button type="button" title="代码" onMouseDown={(event) => event.preventDefault()} onClick={() => wrapDescSelection("`", "`", "代码")}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-tx-secondary hover:bg-app-hover"><CodeIcon size={14} /></button>
              </div>
              <textarea
                ref={descTextareaRef}
                autoFocus
                value={descDraft}
                onChange={(event) => setDescDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void commitDescription();
                  if (event.key === "Escape") setDescEditing(false);
                }}
                rows={4}
                placeholder="写点什么介绍这个知识库…"
                className="w-full resize-none border-0 bg-transparent px-4 pb-2 pt-1.5 text-[13.5px] leading-relaxed text-tx-primary outline-none no-focus-ring focus:ring-0"
              />
              <div className="flex items-center justify-end gap-3 border-t border-app-border/60 px-3 py-2">
                <span className="mr-auto text-[11px] text-tx-tertiary">Ctrl + Enter 保存</span>
                <button
                  type="button"
                  onClick={() => setDescEditing(false)}
                  className="text-[12px] text-tx-tertiary hover:text-tx-secondary"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void commitDescription()}
                  className="rounded-full bg-accent-primary px-3.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        ) : description ? (
          <div className="mt-5">
            {/* 纯展示；编辑入口在“更多 → 编辑总览”。超 2 行折叠，按钮仅在真正溢出时出现 */}
            <div
              ref={descDisplayRef}
              className={`text-[13px] leading-relaxed text-tx-secondary [&_a]:text-accent-primary [&_a]:underline [&_code]:rounded [&_code]:bg-app-hover [&_code]:px-1 [&_code]:text-[12px] ${descriptionExpanded ? "" : "line-clamp-2"}`}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {/* 单个换行预处理为 Markdown 硬换行（行尾两空格），保留编辑时的手动分行 */}
                {description.replace(/(?<!\n)\n(?!\n)/gu, "  \n")}
              </ReactMarkdown>
            </div>
            {(descOverflow || descriptionExpanded) && (
              <button
                type="button"
                onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                className="mt-0.5 text-[12px] text-accent-primary hover:opacity-80"
              >
                {descriptionExpanded ? "收起" : "展开"}
              </button>
            )}
          </div>
        ) : null}

        {isEmpty ? (
          <div className="mt-14 rounded-xl border-[1.5px] border-dashed border-app-border bg-app-elevated px-6 py-12 text-center">
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
            <div className="mb-2 mt-9 flex items-baseline gap-2.5">
              <h3 className="text-[12px] font-semibold text-tx-secondary">目录</h3>
              <span className="rounded-full bg-app-panel px-2 py-0.5 text-[11px] text-tx-tertiary">{docCount} 篇</span>
              <span className="text-[11.5px] text-tx-tertiary">点击直达 · 右侧为最近更新时间</span>
            </div>
            <div className="pb-4">
              {renderTocRows(kbNode.id, 0)}
            </div>
          </>
        )}
      </div>

      {sharing && notebook && (
        <NotebookShareDialog notebook={notebook} onClose={() => setSharing(false)} />
      )}
    </div>
  );
}
