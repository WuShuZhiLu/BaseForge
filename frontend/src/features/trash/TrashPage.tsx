import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, RotateCcw, Search, Trash2, RefreshCw } from "lucide-react";
import { useApp, useAppActions } from "@/store/AppContext";
import { getCurrentWorkspace } from "@/lib/api";
import { emitKnowledgeTreeRefresh } from "@/lib/workspaceRefreshBridge";
import { parseServerTime } from "@/lib/dateTime";
import type { ToolPageHeaderMode } from "@/lib/toolPage";

/** 页签契约：页面自带标题行（回收站 header），宿主顶栏无需重复渲染。 */
export const TOOL_PAGE_HEADER_MODE: ToolPageHeaderMode = "own";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ui/confirm";
import { useTrash } from "./useTrash";
import { permanentSelection, type TrashItem } from "./trashTypes";
import {
  getRetentionDays,
  getTrashTimeFilter,
  getTrashTypeFilter,
  retentionColor,
  retentionDaysLeft,
  setRetentionDays,
  trashTypeEmoji,
  trashTimeMatches,
  trashTypeKey,
  trashTypeLabel,
  type TrashTimeFilter,
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
  const [typeFilter, setTypeFilter] = useState<TrashTypeKey[]>(() => getTrashTypeFilter());
  const [timeFilter, setTimeFilter] = useState<TrashTimeFilter>(() => getTrashTimeFilter());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [retentionDays, setRetention] = useState(() => getRetentionDays());
  const [expanded, setExpanded] = useState(false);

  // 侧栏的类型筛选与保留期设置跨组件同步
  useEffect(() => {
    const onFilter = () => { setTypeFilter(getTrashTypeFilter()); setTimeFilter(getTrashTimeFilter()); };
    const onSettings = () => setRetention(getRetentionDays());
    window.addEventListener("nowen:trash-filter", onFilter);
    window.addEventListener("nowen:trash-settings", onSettings);
    return () => {
      window.removeEventListener("nowen:trash-filter", onFilter);
      window.removeEventListener("nowen:trash-settings", onSettings);
    };
  }, []);

  const visible = useMemo(() => trash.items.filter((item) => {
    if (typeFilter[0] !== "all" && !typeFilter.includes(trashTypeKey(item.resourceType, item.contentFormat))) return false;
    if (!trashTimeMatches(item.deletedAt, timeFilter)) return false;
    return `${item.title} ${item.originalPath.join(" / ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }), [trash.items, typeFilter, timeFilter, query]);
  const selectedItems = trash.items.filter((item) => selected.includes(item.id));
  const active = visible.find((item) => item.id === activeId) ?? null;
  const disabled = trash.loading || trash.busy || trash.error !== null;

  const operate = async (action: "restore" | "permanent" | "empty", ids: string[]) => {
    const targets = action === "empty" ? trash.items : action === "permanent" ? permanentSelection(trash.items, ids) : trash.items.filter((item) => ids.includes(item.id));
    if (action !== "restore") {
      if (!await confirm({ title: t(action === "empty" ? "trashCenter.empty" : "trashCenter.permanent"),
        description: t("trashCenter.deleteConfirm", { count: targets.length }), confirmText: t("trashCenter.permanent"), danger: true })) return;
    } else if (targets.some((item) => item.restoreIncludesAncestors || item.resourceType === "notebook")) {
      if (!await confirm({ title: t("trashCenter.restore"), description: t("trashCenter.restoreConfirm"), confirmText: t("trashCenter.restore") })) return;
    }
    try {
      const result = await trash.mutate(action, ids);
      if (getCurrentWorkspace() !== workspaceId) return;
      setSelected((current) => current.filter((id) => !result.succeededIds.includes(id)));
      if (result.succeededIds.includes(activeId ?? "")) setActiveId(null);
      if (result.failures.length) toast.warning(t("trashCenter.partial", { count: result.succeededIds.length, failed: result.failures.length }));
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
      <label className="flex h-7 w-56 items-center gap-1.5 rounded-lg border border-app-border px-2.5 text-tx-tertiary"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("trashCenter.search")} aria-label={t("trashCenter.search")} className="min-w-0 flex-1 bg-transparent text-xs text-tx-primary outline-none" /></label>
      <span className="flex-1" />
      <span className="text-xs text-tx-tertiary">{t("trashCenter.sortHint", { defaultValue: "排序：最近删除" })}</span>
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
      {/* 详情预览 */}
      <aside className="flex w-[430px] shrink-0 flex-col border-l border-app-border bg-app-bg">
        {active ? <TrashPreview item={active} retentionDays={retentionDays} disabled={disabled} expanded={expanded} onExpand={setExpanded}
          onRestore={() => void operate("restore", [active.id])} onPurge={() => void operate("permanent", [active.id])} />
          : <div className="flex flex-1 flex-col items-center justify-center gap-2 text-tx-tertiary"><span className="text-[26px]">👈</span><p className="text-[12.5px] text-center leading-relaxed">点一条内容<br/>先看内容预览，确认后恢复</p></div>}
      </aside>
    </div>
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

function TrashPreview({ item, retentionDays, disabled, expanded, onExpand, onRestore, onPurge }: {
  item: TrashItem; retentionDays: number; disabled: boolean; expanded: boolean; onExpand: (next: boolean) => void;
  onRestore: () => void; onPurge: () => void;
}) {
  const { t } = useTranslation();
  const typeKey = trashTypeKey(item.resourceType, item.contentFormat);
  const daysLeft = retentionDaysLeft(item.deletedAt, retentionDays);
  const date = parseServerTime(item.deletedAt);
  return <>
    <div className="flex h-12 shrink-0 items-center border-b border-app-border px-4 text-[12.5px] font-semibold">{t("trashCenter.previewTitle", { defaultValue: "详情预览" })}</div>
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
          {item.preview ? <p className="whitespace-pre-wrap">{item.preview}{item.preview.length >= 200 ? "…" : ""}</p>
            : <div className="flex h-full flex-col items-center justify-center gap-2 py-6 text-tx-tertiary"><span className="text-[28px]">{trashTypeEmoji(typeKey)}</span><p>{trashTypeLabel(typeKey)} · {t("trashCenter.previewUnavailable", { defaultValue: "该类型暂不支持内容预览" })}</p></div>}
        </div>
      </div>
      {daysLeft <= 3 && <div className="mt-3 shrink-0 rounded-lg bg-[#fdf6e7] px-2.5 py-2 text-[11px] leading-relaxed text-[#b7791f]">{t("trashCenter.expiringSoon", { defaultValue: "⚠ 即将到期自动清除，需要请尽快恢复" })}</div>}
    </div>
    <div className="shrink-0 border-t border-app-border p-3.5">
      <div className="flex gap-2">
        <button className={`${buttonClass} flex-1 border-accent-primary bg-accent-primary text-white hover:opacity-90`} disabled={disabled || !item.canRestore} onClick={onRestore}><RotateCcw size={14} />{t("trashCenter.restore")}</button>
        <button className={`${buttonClass} flex-1`} disabled={disabled} title={t("trashCenter.restoreTo", { defaultValue: "选择其它位置恢复（即将推出）" })} onClick={() => toast.info(t("trashCenter.restoreToComing", { defaultValue: "「恢复到指定位置」即将推出" }))}><span>{t("trashCenter.restoreTo", { defaultValue: "恢复到…" })}</span></button>
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
            {item.preview ? <p className="whitespace-pre-wrap">{item.preview}{item.preview.length >= 200 ? "…" : ""}</p>
              : <p className="text-center text-tx-tertiary">{t("trashCenter.previewUnavailable", { defaultValue: "该类型暂不支持内容预览" })}</p>}
          </div>
        </div>
      </div>
    )}
  </>;
}
