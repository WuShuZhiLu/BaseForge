import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, RotateCcw, Search, Trash2, RefreshCw, X } from "lucide-react";
import { useApp, useAppActions } from "@/store/AppContext";
import { getCurrentWorkspace } from "@/lib/api";
import { emitKnowledgeTreeRefresh } from "@/lib/workspaceRefreshBridge";
import { parseServerTime } from "@/lib/dateTime";
import type { ToolPageHeaderMode } from "@/lib/toolPage";

/** 页签契约：页面自带标题行（回收站 header），宿主顶栏无需重复渲染。 */
export const TOOL_PAGE_HEADER_MODE: ToolPageHeaderMode = "own";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ui/confirm";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTrash } from "./useTrash";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { permanentSelection, type TrashItem } from "./trashTypes";
import {
  getRetentionDays,
  getTrashSortFilter,
  getTrashTimeFilter,
  getTrashTypeFilter,
  retentionColor,
  retentionDaysLeft,
  setRetentionDays,
  setTrashSortFilter,
  sortTrashItems,
  TRASH_SORT_META,
  trashTypeEmoji,
  trashTimeMatches,
  trashTypeKey,
  trashTypeLabel,
  type TrashTimeFilter,
  type TrashSortFilter,
  type TrashTypeFilterKey,
  type TrashTypeKey,
} from "./trashUi";

const buttonClass = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-app-border px-3 py-2 text-sm hover:bg-app-hover disabled:opacity-40 disabled:cursor-not-allowed";

export default function TrashPage() {
  const { state } = useApp();
  const workspaceId = getCurrentWorkspace();
  return <TrashCenter key={workspaceId} workspaceId={workspaceId} refreshToken={state.notesRefreshToken} />;
}

function TrashCenter({ workspaceId, refreshToken }: { workspaceId: string; refreshToken: number }) {
  const { t, i18n } = useTranslation();
  const actions = useAppActions();
  const { state } = useApp();
  const trash = useTrash(workspaceId, refreshToken);
  const [typeFilter, setTypeFilter] = useState<TrashTypeFilterKey[]>(() => getTrashTypeFilter());
  const [timeFilter, setTimeFilter] = useState<TrashTimeFilter>(() => getTrashTimeFilter());
  const [sortFilter, setSortFilter] = useState<TrashSortFilter>(() => getTrashSortFilter());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [retentionDays, setRetention] = useState(() => getRetentionDays());
  const [expanded, setExpanded] = useState(false);
  // 「恢复到…」：目标目录选择器
  const [restoreToItem, setRestoreToItem] = useState<TrashItem | null>(null);

  // 侧栏的类型筛选与保留期设置跨组件同步
  useEffect(() => {
    const onFilter = () => { setTypeFilter(getTrashTypeFilter()); setTimeFilter(getTrashTimeFilter()); setSortFilter(getTrashSortFilter()); };
    const onSettings = () => setRetention(getRetentionDays());
    window.addEventListener("nowen:trash-filter", onFilter);
    window.addEventListener("nowen:trash-settings", onSettings);
    return () => {
      window.removeEventListener("nowen:trash-filter", onFilter);
      window.removeEventListener("nowen:trash-settings", onSettings);
    };
  }, []);

  const visible = useMemo(() => sortTrashItems(trash.items.filter((item) => {
    if (typeFilter[0] !== "all" && !typeFilter.includes(trashTypeKey(item.resourceType, item.contentFormat))) return false;
    if (!trashTimeMatches(item.deletedAt, timeFilter)) return false;
    return `${item.title} ${item.originalPath.join(" / ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }), sortFilter), [trash.items, typeFilter, timeFilter, query, sortFilter]);
  const selectedItems = trash.items.filter((item) => selected.includes(item.id));
  const active = visible.find((item) => item.id === activeId) ?? null;
  const disabled = trash.loading || trash.busy || trash.error !== null;

  const operate = async (action: "restore" | "permanent" | "empty", ids: string[], options?: { targetParentId?: string }) => {
    const targets = action === "empty" ? trash.items : action === "permanent" ? permanentSelection(trash.items, ids) : trash.items.filter((item) => ids.includes(item.id));
    if (action !== "restore") {
      if (!await confirm({ title: t(action === "empty" ? "trashCenter.empty" : "trashCenter.permanent"),
        description: t("trashCenter.deleteConfirm", { count: targets.length }), confirmText: t("trashCenter.permanent"), danger: true })) return;
    } else if (targets.some((item) => item.restoreIncludesAncestors || item.resourceType === "notebook")) {
      if (!await confirm({ title: t("trashCenter.restore"), description: t("trashCenter.restoreConfirm"), confirmText: t("trashCenter.restore") })) return;
    }
    try {
      const result = await trash.mutate(action, ids, options);
      if (getCurrentWorkspace() !== workspaceId) return;
      setSelected((current) => current.filter((id) => !result.succeededIds.includes(id)));
      if (result.succeededIds.includes(activeId ?? "")) setActiveId(null);
      if (options?.targetParentId && result.failures.length === 0) toast.success(t("trashCenter.restoredTo", { defaultValue: "已恢复到所选位置" }));
      else if (result.failures.length) toast.warning(t("trashCenter.partial", { count: result.succeededIds.length, failed: result.failures.length }));
      else toast.success(t("trashCenter.success", { count: result.succeededIds.length }));
      if (state.activeNote && result.noteIds.includes(state.activeNote.id)) actions.setActiveNote(null);
      actions.refreshNotes();
      actions.refreshNotebooks();
      emitKnowledgeTreeRefresh("trash-lifecycle");
      window.dispatchEvent(new CustomEvent("nowen:storage-changed", { detail: { reason: "trash-lifecycle" } }));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("trashCenter.operationFailed"));
      void trash.reload();
    }
  };

  return <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-app-bg text-tx-primary" aria-label={t("sidebar.trash")}>
    {/* 标题行 h-12：与侧栏工作区头（48px）同一节奏，横线对齐 */}
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-app-border px-4">
      <div className="flex items-center gap-2"><Trash2 size={18} className="text-tx-secondary" /><h1 className="text-[15px] font-semibold">{t("sidebar.trash")}</h1><span className="text-xs tabular-nums text-tx-tertiary">{trash.items.length}</span></div>
      <div className="flex gap-2">
        <button className={buttonClass} disabled={trash.busy || trash.loading} onClick={() => void trash.reload()} aria-label={t("trashCenter.refresh")}><RefreshCw size={16} /></button>
        <button className={`${buttonClass} text-accent-danger`} disabled={disabled || !trash.items.length} onClick={() => void operate("empty", [])}><Trash2 size={16} />{t("trashCenter.empty")}</button>
      </div>
    </header>
    {/* 工具行 h-10：只留搜索；批量在列表底部批量条 */}
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-app-border px-4">
      <label className="flex h-7 w-56 items-center gap-1.5 rounded-lg bg-app-hover px-2.5 text-tx-tertiary"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("trashCenter.search")} aria-label={t("trashCenter.search")} className="min-w-0 flex-1 border-none bg-transparent text-xs text-tx-primary outline-none no-focus-ring" /></label>
      <span className="flex-1" />
      <span className="text-xs text-tx-tertiary">排序：{TRASH_SORT_META.find((meta) => meta.key === sortFilter)?.label}</span>
    </div>
    <div className="flex min-h-0 flex-1">
      {/* 列表 */}
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-2">
        {trash.error !== null ? <div role="alert" className="py-8 text-center text-accent-danger"><p>{t("trashCenter.loadFailed")}</p><p className="text-sm">{trash.error}</p><button className={`${buttonClass} mt-3`} onClick={() => void trash.reload()}>{t("trashCenter.retry")}</button></div>
          : trash.loading ? <p role="status" className="py-8 text-center text-tx-tertiary">{t("common.loading")}</p>
          : !visible.length ? <div className="py-16 text-center text-tx-tertiary"><Trash2 size={36} className="mx-auto mb-3 opacity-50" /><p>{t(trash.items.length ? "trashCenter.noMatches" : "trashCenter.emptyState")}</p>
              {trash.items.length > 0 && <p className="mt-1 text-xs">{t("trashCenter.filterHint", { defaultValue: "当前筛选条件下没有匹配项，试试调整类型或删除时间" })}</p>}</div>
          : <ul className="space-y-0.5">{visible.map((item) => <TrashRow key={item.id} item={item} disabled={disabled} selected={selected.includes(item.id)} active={activeId === item.id}
              retentionDays={retentionDays}
              onSelect={() => setActiveId(activeId === item.id ? null : item.id)}
              onToggle={(checked) => setSelected(checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}
              onRestore={() => void operate("restore", [item.id])}
              onPurge={() => void operate("permanent", [item.id])} />)}</ul>}
        <p className="mt-3 text-xs text-tx-tertiary">{t("trashCenter.protectedHint")}</p>
      </div>
      {/* 批量条：有勾选时出现 */}
      <div className={`shrink-0 border-t border-[#d5e3ff] bg-[#eef4ff] px-4 py-2 text-xs text-tx-secondary ${selectedItems.length ? "flex" : "hidden"} items-center gap-2`}>
        <label className="flex items-center gap-1.5"><input type="checkbox" disabled={disabled || !visible.length} checked={!!visible.length && visible.every((item) => selected.includes(item.id))} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, ...visible.map((item) => item.id)])] : selected.filter((id) => !visible.some((item) => item.id === id)))} />{t("trashCenter.selectAll")}</label>
        <span>{t("trashCenter.selected", { count: selectedItems.length })}</span>
        <button className={`${buttonClass} h-7 px-2.5`} disabled={disabled || !selectedItems.every((item) => item.canRestore) || selectedItems.length > 500} onClick={() => void operate("restore", selectedItems.map((item) => item.id))}><RotateCcw size={13} />{t("trashCenter.restore")}</button>
        <button className={`${buttonClass} h-7 px-2.5 text-accent-danger`} disabled={disabled || !selectedItems.every((item) => item.canDeletePermanently) || selectedItems.length > 500} onClick={() => void operate("permanent", selectedItems.map((item) => item.id))}><Trash2 size={13} />{t("trashCenter.permanent")}</button>
        <span className="flex-1" />
        <button className="text-tx-tertiary hover:text-tx-primary" onClick={() => setSelected([])}>{t("trashCenter.clearSelection", { defaultValue: "取消选择" })}</button>
      </div>
      {/* 详情预览：仅在选中一条被删内容时出现，未选中时列表占满整宽（不留空占位） */}
      {active && (
        <aside className="flex w-[430px] shrink-0 flex-col border-l border-app-border bg-app-bg">
          <TrashPreview item={active} retentionDays={retentionDays} disabled={disabled} expanded={expanded} onExpand={setExpanded}
            onRestore={() => void operate("restore", [active.id])}
            onRestoreTo={() => setRestoreToItem(active)}
            onPurge={() => void operate("permanent", [active.id])}
            onClose={() => setActiveId(null)} />
        </aside>
      )}
    </div>
    {/* 恢复到…：目标目录选择器 */}
    {restoreToItem && (
      <TrashFolderPicker
        title={t("trashCenter.restoreToTitle", { defaultValue: "恢复「{{title}}」到…", title: restoreToItem.title })}
        disabled={trash.busy || trash.loading}
        onConfirm={(targetParentId) => {
          const target = restoreToItem;
          setRestoreToItem(null);
          void operate("restore", [target.id], { targetParentId });
        }}
        onClose={() => setRestoreToItem(null)}
      />
    )}
  </main>;
}

function TrashRow({ item, disabled, selected, active, retentionDays, onSelect, onToggle, onRestore, onPurge }: {
  item: TrashItem; disabled: boolean; selected: boolean; active: boolean; retentionDays: number;
  onSelect: () => void; onToggle: (checked: boolean) => void; onRestore: () => void; onPurge: () => void;
}) {
  const { t, i18n } = useTranslation();
  const typeKey = trashTypeKey(item.resourceType, item.contentFormat);
  const date = parseServerTime(item.deletedAt);
  const daysLeft = retentionDaysLeft(item.deletedAt, retentionDays);
  return <li
    aria-selected={active}
    onClick={onSelect}
    className={`group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ${active ? "bg-[#eef4ff]" : "hover:bg-app-hover"}`}
  >
    <input type="checkbox" disabled={disabled} aria-label={t("trashCenter.selectItem", { title: item.title })} checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onToggle(event.target.checked)} className="shrink-0 accent-[var(--color-accent-primary)]" />
    <span className="shrink-0 text-[14px] leading-none">{trashTypeEmoji(typeKey)}</span>
    <div className="min-w-0 flex-1">
      <p className="flex min-w-0 items-center gap-1.5 text-[13px]"><span className="truncate font-medium" title={item.title}>{item.title}</span>{item.isLocked && <Lock size={12} className="shrink-0 text-tx-tertiary" />}</p>
      <p className="truncate text-[11px] text-tx-tertiary">{trashTypeLabel(typeKey)} · {item.originalPathHidden ? t("trashCenter.hiddenPath") : item.originalPath.join(" / ") || t("trashCenter.root")}</p>
    </div>
    <span className="w-16 shrink-0 text-right">
      <span className="block text-[11px] tabular-nums" style={{ color: daysLeft <= 3 ? "var(--accent-danger)" : "var(--color-text-secondary)" }}>{t("trashCenter.daysLeft", { defaultValue: "剩 {{n}} 天", n: daysLeft })}</span>
      <span className="mt-1 block h-[3px] overflow-hidden rounded-full bg-app-hover"><span className="block h-full rounded-full" style={{ width: `${Math.round(daysLeft / retentionDays * 100)}%`, background: retentionColor(daysLeft) }} /></span>
    </span>
    <span className="hidden shrink-0 gap-0.5 group-hover:flex" onClick={(event) => event.stopPropagation()}>
      <button disabled={disabled || !item.canRestore} onClick={onRestore} title={t("trashCenter.restore")} className="flex h-6 w-6 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-border hover:text-accent-primary disabled:opacity-40"><RotateCcw size={12} /></button>
      <button disabled={disabled || !item.canDeletePermanently} onClick={onPurge} title={t("trashCenter.permanent")} className="flex h-6 w-6 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-border hover:text-accent-danger disabled:opacity-40"><Trash2 size={12} /></button>
    </span>
    <span className="sr-only">{date ? date.toLocaleString(i18n.language) : ""}</span>
  </li>;
}

/** 预览正文：按后端 preview.kind 分发渲染（markdown 渲染 / 导图大纲 / 迷你表格 / 画板统计 / 纯文本）。 */
function TrashPreviewBody({ item, large = false }: { item: TrashItem; large?: boolean }) {
  const { t } = useTranslation();
  const typeKey = trashTypeKey(item.resourceType, item.contentFormat);
  const preview = item.preview;
  if (!preview) {
    return <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 py-6 text-tx-tertiary">
      <span className={large ? "text-[40px]" : "text-[28px]"}>{trashTypeEmoji(typeKey)}</span>
      <p>{trashTypeLabel(typeKey)} · {t("trashCenter.previewUnavailable", { defaultValue: "该类型暂不支持内容预览" })}</p>
    </div>;
  }
  if (preview.kind === "markdown") {
    return <div className={large ? "[&_h1]:text-xl [&_h2]:text-lg [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:rounded [&_code]:bg-app-hover [&_code]:px-1" : "[&_h1]:text-sm [&_h2]:text-[13px] [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_code]:rounded [&_code]:bg-app-hover [&_code]:px-1"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.text || ""}</ReactMarkdown>
    </div>;
  }
  if (preview.kind === "outline") {
    return <ul className="space-y-1">
      {preview.outline?.map((node, index) => (
        <li key={index} style={{ paddingLeft: `${node.level * (large ? 22 : 14)}px` }}
          className={`truncate ${node.level === 0 ? "font-medium text-tx-primary" : ""} ${large ? "text-[13.5px]" : "text-xs"}`}>
          {node.level > 0 && <span className="mr-1.5 text-tx-tertiary">└</span>}{node.label}
        </li>
      ))}
    </ul>;
  }
  if (preview.kind === "table") {
    return <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead><tr>{preview.table?.columns.map((column, index) => <th key={index} className="border border-app-border bg-app-panel px-2 py-1 text-left font-medium">{column}</th>)}</tr></thead>
        <tbody>{preview.table?.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border border-app-border px-2 py-1">{cell || "—"}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>;
  }
  if (preview.kind === "board") {
    return <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 py-6 text-tx-tertiary">
      <span className={large ? "text-[40px]" : "text-[28px]"}>🎨</span>
      <p>{t("trashCenter.boardInfo", { defaultValue: "{{shapes}} 个图形 · {{texts}} 个文字标注", shapes: preview.board?.shapes ?? 0, texts: preview.board?.texts ?? 0 })}</p>
    </div>;
  }
  return <p className="whitespace-pre-wrap">{preview.text}</p>;
}

function TrashPreview({ item, retentionDays, disabled, expanded, onExpand, onRestore, onRestoreTo, onPurge, onClose }: {
  item: TrashItem; retentionDays: number; disabled: boolean; expanded: boolean; onExpand: (next: boolean) => void;
  onRestore: () => void; onRestoreTo: () => void; onPurge: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const typeKey = trashTypeKey(item.resourceType, item.contentFormat);
  const daysLeft = retentionDaysLeft(item.deletedAt, retentionDays);
  const date = parseServerTime(item.deletedAt);
  return <>
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-app-border px-4 text-[12.5px] font-semibold">
      <span className="min-w-0 truncate">{t("trashCenter.previewTitle", { defaultValue: "详情预览" })}</span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={onClose}
        title={t("trashCenter.closePreview", { defaultValue: "关闭预览" })}
        aria-label={t("trashCenter.closePreview", { defaultValue: "关闭预览" })}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
      >
        <X size={14} />
      </button>
    </div>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3.5">
      <div className="flex shrink-0 items-center gap-2 text-[15px] font-semibold"><span>{trashTypeEmoji(typeKey)}</span><span className="min-w-0 truncate">{item.title}</span>{item.isLocked && <Lock size={13} className="text-tx-tertiary" />}</div>
      <dl className="mt-3 grid shrink-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-tx-tertiary">{t("trashCenter.typeLabel", { defaultValue: "类型" })}</dt><dd className="text-tx-secondary">{trashTypeLabel(typeKey)}</dd>
        <dt className="text-tx-tertiary">{t("trashCenter.originalPath")}</dt><dd className="min-w-0 truncate text-tx-secondary" title={item.originalPath.join(" / ")}>{item.originalPathHidden ? t("trashCenter.hiddenPath") : item.originalPath.join(" / ") || t("trashCenter.root")}</dd>
        <dt className="text-tx-tertiary">{t("trashCenter.deletedAt", { date: "" }).split("：")[0] || t("trashCenter.originalPath")}</dt><dd className="text-tx-secondary">{date ? date.toLocaleString() : t("trashCenter.unknownDate")}</dd>
      </dl>
      <div className="mt-3 shrink-0 rounded-xl border border-app-border px-3 py-2.5">
        <div className="flex justify-between text-xs text-tx-secondary"><span>{t("trashCenter.retentionTitle", { defaultValue: "{{n}} 天保留期", n: retentionDays })}</span><span style={{ color: retentionColor(daysLeft) }}>{t("trashCenter.daysLeft", { n: daysLeft })}</span></div>
        <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-app-hover"><span className="block h-full rounded-full" style={{ width: `${Math.round(daysLeft / retentionDays * 100)}%`, background: retentionColor(daysLeft) }} /></div>
      </div>
      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-app-border">
        <div className="flex shrink-0 items-center justify-between bg-app-panel px-3 py-1.5 text-[10.5px] text-tx-tertiary">
          <span>{t("trashCenter.contentPreview", { defaultValue: "内容预览" })}</span>
          <span className="flex items-center gap-2.5"><span>{trashTypeLabel(typeKey)}</span><button onClick={() => onExpand(!expanded)} className="text-accent-primary">{t("trashCenter.expand", { defaultValue: "⤢ 放大" })}</button></span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3 text-xs leading-relaxed text-tx-secondary">
          <TrashPreviewBody item={item} />
        </div>
      </div>
      {daysLeft <= 3 && <div className="mt-3 shrink-0 rounded-lg bg-[#fdf6e7] px-2.5 py-2 text-[11px] leading-relaxed text-[#b7791f]">{t("trashCenter.expiringSoon", { defaultValue: "⚠ 即将到期自动清除，需要请尽快恢复" })}</div>}
    </div>
    <div className="shrink-0 border-t border-app-border p-3.5">
      <div className="flex gap-2">
        <button className={`${buttonClass} flex-1 border-accent-primary bg-accent-primary text-white hover:opacity-90`} disabled={disabled || !item.canRestore} onClick={onRestore}><RotateCcw size={14} />{t("trashCenter.restore")}</button>
        <button className={`${buttonClass} flex-1`} disabled={disabled || !item.canRestore} onClick={onRestoreTo}><span>{t("trashCenter.restoreTo", { defaultValue: "恢复到…" })}</span></button>
        <button className={`${buttonClass} w-10 text-accent-danger`} disabled={disabled || !item.canDeletePermanently} onClick={onPurge} title={t("trashCenter.permanent")}><Trash2 size={14} /></button>
      </div>
    </div>
    {expanded && (
      <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/45 p-12" onClick={(event) => { if (event.target === event.currentTarget) onExpand(false); }}>
        <div className="flex h-[86vh] w-[min(860px,92vw)] flex-col overflow-hidden rounded-xl bg-app-bg shadow-2xl">
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-app-border px-4">
            <span className="text-sm font-semibold">{trashTypeEmoji(typeKey)} {item.title}</span>
            <span className="text-xs text-tx-tertiary">{trashTypeLabel(typeKey)} · {t("trashCenter.originalPath")} {item.originalPathHidden ? t("trashCenter.hiddenPath") : item.originalPath.join(" / ")}</span>
            <span className="flex-1" />
            <button onClick={() => onExpand(false)} className="text-tx-tertiary hover:text-tx-primary">✕</button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-8 py-6 text-[13.5px] leading-relaxed text-tx-secondary">
            <TrashPreviewBody item={item} large />
          </div>
        </div>
      </div>
    )}
  </>;
}

/** 「恢复到…」目标目录选择器：面包屑 + 逐级进入（与移动面板同交互），确定后恢复到所选目录。 */
function TrashFolderPicker({ title, disabled, onConfirm, onClose }: {
  title: string; disabled: boolean; onConfirm: (targetParentId: string) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [nodes, setNodes] = useState<KnowledgeTreeNode[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    knowledgeTreeApi.list()
      .then((res) => { if (!cancelled) setNodes(res.nodes); })
      .catch(() => { if (!cancelled) setNodes([]); });
    return () => { cancelled = true; };
  }, []);

  const childrenMap = useMemo(() => {
    const map = new Map<string | null, KnowledgeTreeNode[]>();
    for (const node of nodes ?? []) {
      if (node.isDeleted) continue;
      if (node.nodeType !== "folder") continue;
      if (!node.access.capabilities.canCreate) continue;
      map.set(node.parentId, [...(map.get(node.parentId) ?? []), node]);
    }
    for (const list of map.values()) list.sort((a, b) => a.title.localeCompare(b.title));
    return map;
  }, [nodes]);
  const nodeById = useMemo(() => new Map((nodes ?? []).map((node) => [node.id, node])), [nodes]);
  const crumbs = useMemo(() => {
    const chain: KnowledgeTreeNode[] = [];
    let current = currentId ? nodeById.get(currentId) : undefined;
    while (current) {
      chain.unshift(current);
      current = current.parentId ? nodeById.get(current.parentId) : undefined;
    }
    return chain;
  }, [currentId, nodeById]);
  const currentChildren = childrenMap.get(currentId) ?? [];

  const confirm = async () => {
    if (currentId === null || confirming) return;
    setConfirming(true);
    onConfirm(currentId);
  };

  return <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/45" onClick={onClose}>
    <div className="flex h-[480px] w-[440px] flex-col overflow-hidden rounded-xl border border-app-border bg-app-bg shadow-2xl" onClick={(event) => event.stopPropagation()}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-app-border px-3.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-tx-primary">{title}</span>
        <button onClick={onClose} className="text-tx-tertiary hover:text-tx-primary">✕</button>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-app-border px-2.5 text-xs">
        <button
          type="button"
          disabled={currentId === null}
          onClick={() => setCurrentId(nodeById.get(currentId ?? "")?.parentId ?? null)}
          className="flex h-6 w-6 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:opacity-40"
          title="上一级"
        >↑</button>
        <button
          type="button"
          onClick={() => setCurrentId(null)}
          className={`rounded px-1.5 py-0.5 hover:bg-app-hover ${currentId === null ? "font-medium text-tx-primary" : "text-tx-tertiary hover:text-tx-primary"}`}
        >根目录</button>
        {crumbs.map((crumb) => (
          <span key={crumb.id} className="flex items-center">
            <span className="text-app-border">›</span>
            <button
              type="button"
              onClick={() => setCurrentId(crumb.id)}
              className={`rounded px-1.5 py-0.5 hover:bg-app-hover ${crumb.id === currentId ? "font-medium text-tx-primary" : "text-tx-tertiary hover:text-tx-primary"}`}
            >{crumb.title}</button>
          </span>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {nodes === null ? <p className="py-10 text-center text-xs text-tx-tertiary">{t("common.loading")}</p>
          : currentChildren.length === 0 ? <p className="py-10 text-center text-xs text-tx-tertiary">{t("trashCenter.noSubfolders", { defaultValue: "此目录下没有子文件夹" })}</p>
          : currentChildren.map((folder) => (
            <button
              key={folder.id}
              type="button"
              onClick={() => setCurrentId(folder.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
            >
              <span className="shrink-0 text-[13px] leading-none">📁</span>
              <span className="min-w-0 flex-1 truncate">{folder.title}</span>
              <span className="shrink-0 text-tx-tertiary">›</span>
            </button>
          ))}
      </div>
      <div className="shrink-0 border-t border-app-border p-2.5">
        <button
          type="button"
          disabled={disabled || confirming || currentId === null}
          onClick={() => void confirm()}
          className="w-full rounded-full bg-accent-primary px-4 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {currentId === null ? "请先进入一个文件夹" : confirming ? "恢复中…" : `恢复到这里（${crumbs.map((crumb) => crumb.title).join(" / ") || "根目录"}）`}
        </button>
      </div>
    </div>
  </div>;
}
