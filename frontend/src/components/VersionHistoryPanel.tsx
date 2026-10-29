import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, History, RotateCcw, FileText, Loader2, Trash2, Save, Copy, Check, GitCompare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { NoteVersion } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { normalizeToMarkdown } from "@/lib/contentFormat";
import SaveVersionDialog from "@/components/SaveVersionDialog";
import { diffLines, diffStats, type DiffLine } from "@/lib/versionDiff";
import { getVersionHistorySettings } from "@/lib/versionSnapshot";

interface VersionHistoryPanelProps {
  noteId: string;
  noteTitle: string;
  onRestore: (note: any) => void;
  onClose: () => void;
  /** 创建手动版本前确保笔记已保存（编辑器有未保存修改时先落盘）。 */
  ensureSaved?: () => Promise<void>;
}

interface VersionPreviewState {
  version: NoteVersion;
  previewMarkdown: string;
  contentFormatLabel: string;
}

export type VersionFilterTab = "all" | "manual" | "auto";

export function versionContentFormatLabel(contentFormat?: string | null): string {
  switch (contentFormat) {
    case "markdown":
      return "Markdown";
    case "tiptap-json":
      return "Rich Text";
    case "html":
      return "HTML";
    default:
      return "Unknown";
  }
}

export function versionToPreviewMarkdown(version: NoteVersion): string {
  const content = version.content || "";
  const contentText = version.contentText || "";

  if ((version.contentFormat || "tiptap-json") === "markdown") {
    return content || contentText;
  }

  try {
    const markdown = normalizeToMarkdown(content, contentText);
    if (version.contentFormat === "tiptap-json" && markdown === content && contentText) {
      return contentText;
    }
    return markdown || contentText || content;
  } catch (e) {
    console.warn("[VersionHistoryPanel] preview conversion failed:", e);
    return contentText || content;
  }
}

/** 按筛选 Tab 过滤版本列表。kind 缺省（旧后端不下发）按 auto 归类。 */
export function filterVersionsByTab(versions: NoteVersion[], tab: VersionFilterTab): NoteVersion[] {
  if (tab === "all") return versions;
  return versions.filter((v) => (v.kind ?? "auto") === tab);
}

/** 字节转人类可读，与 DataManager 的 fmtBytes 行为一致（该处为模块内函数未导出，此处独立实现）。 */
export function formatBytes(n: number | undefined | null): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function VersionHistoryPanel({ noteId, noteTitle, onRestore, onClose, ensureSaved }: VersionHistoryPanelProps) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [total, setTotal] = useState(0);
  const [bytesTotal, setBytesTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewVersion, setPreviewVersion] = useState<VersionPreviewState | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  // v2：筛选 / 删除 / 批量删除 / 手动保存
  const [filter, setFilter] = useState<VersionFilterTab>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  // v2 P2：与当前版本对比 + 配额展示
  const [diffMode, setDiffMode] = useState(false);
  const [diffLinesState, setDiffLinesState] = useState<DiffLine[] | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [quotaBytes, setQuotaBytes] = useState<number | null>(null);
  const selectedVersion = previewVersion?.version || null;

  // P2：配额展示（一次拉取，失败静默——仅影响统计展示）
  useEffect(() => {
    let cancelled = false;
    getVersionHistorySettings()
      .then((s) => { if (!cancelled && s.storageQuotaMb > 0) setQuotaBytes(s.storageQuotaMb * 1024 * 1024); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  // P2：与当前版本对比（行级 diff，比较 contentText）
  const handleToggleDiff = async () => {
    if (!previewVersion) return;
    if (diffMode) {
      setDiffMode(false);
      return;
    }
    setLoadingDiff(true);
    try {
      const note = await api.getNote(noteId);
      const lines = diffLines(note.contentText || "", previewVersion.version.contentText || "");
      setDiffLinesState(lines);
      setDiffMode(true);
    } catch (e) {
      console.warn("[VersionHistoryPanel] diff failed:", e);
      toast.error(t("versions.diffFailed"));
    } finally {
      setLoadingDiff(false);
    }
  };

  const handleClearAll = async () => {
    if (clearing) return;
    if (total === 0) {
      toast.info(t("versions.clearEmpty"));
      return;
    }
    setClearing(true);
    try {
      // v2 语义：清空仅删 auto 版本，manual 版本保留（skippedManual 为保留条数）。
      const res = await api.clearNoteVersions(noteId);
      setConfirmClear(false);
      const skippedManual = res.skippedManual ?? 0;
      toast.success(
        t("versions.clearSuccess", { count: res.count })
        + (skippedManual > 0 ? " · " + t("versions.clearSkippedManual", { count: skippedManual }) : "")
      );
      await loadVersions();
    } catch (e: any) {
      console.error("清空版本历史失败:", e);
      toast.error(t("versions.clearFailed") + (e?.message ? `: ${e.message}` : ""));
    } finally {
      setClearing(false);
    }
  };

  const loadVersions = useCallback(async () => {
    try {
      // 一次拉全量（不带 kind），筛选在客户端做：占用统计需要全局 total/bytes。
      const data = await api.getNoteVersions(noteId, 200, 0);
      setVersions(data.versions);
      setTotal(data.total);
      setBytesTotal(data.contentBytesTotal ?? null);
      // 重载后剔除已不存在的选中项，避免批量删除命中幽灵 id。
      setSelectedIds((prev) => {
        const ids = new Set(data.versions.map((v) => v.id));
        const next = new Set([...prev].filter((id) => ids.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (e) {
      console.error("加载版本历史失败:", e);
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  // 预览版本内容
  const handlePreview = async (version: NoteVersion) => {
    setDiffMode(false);
    setDiffLinesState(null);
    if (selectedVersion?.id === version.id) {
      setPreviewVersion(null);
      return;
    }
    setPreviewVersion({
      version,
      previewMarkdown: "",
      contentFormatLabel: versionContentFormatLabel(version.contentFormat),
    });
    setLoadingPreview(true);
    try {
      const data = await api.getNoteVersion(noteId, version.id);
      setPreviewVersion({
        version: data,
        previewMarkdown: versionToPreviewMarkdown(data),
        contentFormatLabel: versionContentFormatLabel(data.contentFormat),
      });
    } catch (e) {
      console.error("加载版本内容失败:", e);
      setPreviewVersion({
        version: {
          ...version,
          content: t("versions.loadFailed"),
          contentText: t("versions.loadFailed"),
          contentFormat: "markdown",
        },
        previewMarkdown: t("versions.loadFailed"),
        contentFormatLabel: versionContentFormatLabel(version.contentFormat),
      });
    } finally {
      setLoadingPreview(false);
    }
  };

  // 恢复版本
  const handleRestore = async (versionId: string) => {
    if (restoring) return;
    setRestoring(true);
    try {
      const updated = await api.restoreNoteVersion(noteId, versionId);
      onRestore(updated);
      setConfirmRestore(null);
      onClose();
    } catch (e: any) {
      console.error("恢复版本失败:", e);
    } finally {
      setRestoring(false);
    }
  };

  // v2：删除单个版本（所有者/管理员；协作者 403 由 toast 展示）
  const handleDeleteOne = async (version: NoteVersion) => {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.deleteNoteVersion(noteId, version.id);
      toast.success(t("versions.deleteSuccess"));
      setConfirmDeleteId(null);
      if (selectedVersion?.id === version.id) setPreviewVersion(null);
      await loadVersions();
    } catch (e: any) {
      console.error("删除版本失败:", e);
      toast.error(t("versions.deleteFailed") + (e?.message ? `: ${e.message}` : ""));
    } finally {
      setDeleting(false);
    }
  };

  // v2：批量删除所选（契约约定仅删 auto，manual id 会被服务端跳过；UI 层只允许勾选 auto）
  const handleBatchDelete = async () => {
    if (batchDeleting || selectedIds.size === 0) return;
    setBatchDeleting(true);
    try {
      const res = await api.batchDeleteNoteVersions(noteId, [...selectedIds]);
      toast.success(
        t("versions.batchDeleteSuccess", { deleted: res.deleted })
        + (res.skipped > 0 ? " · " + t("versions.batchSkippedManual", { count: res.skipped }) : "")
      );
      setBatchConfirm(false);
      setSelectedIds(new Set());
      await loadVersions();
    } catch (e: any) {
      console.error("批量删除版本失败:", e);
      toast.error(t("versions.batchDeleteFailed") + (e?.message ? `: ${e.message}` : ""));
    } finally {
      setBatchDeleting(false);
    }
  };

  // v2：从版本创建副本（P1：成功后 toast 展示副本标题，不做跳转）
  const handleDuplicate = async (version: NoteVersion) => {
    if (duplicating) return;
    setDuplicating(true);
    try {
      const note = await api.duplicateNoteFromVersion(noteId, version.id);
      toast.success(t("versions.duplicateSuccess", { title: note.title }));
    } catch (e: any) {
      console.error("从版本创建副本失败:", e);
      toast.error(t("versions.duplicateFailed") + (e?.message ? `: ${e.message}` : ""));
    } finally {
      setDuplicating(false);
    }
  };

  const toggleSelected = (versionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(versionId)) next.delete(versionId);
      else next.add(versionId);
      return next;
    });
  };

  const formatTime = (date: string) => {
    // 后端 SQLite datetime('now') 存的是 UTC 字符串但不带 Z 后缀（形如 "2025-04-21 07:30:12"）。
    // 若直接 new Date(date)，浏览器会按本地时区解析，东八区下会多算 8 小时。
    // 统一补 "Z" 让 JS 按 UTC 解析。
    const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(date) ? date : date.replace(" ", "T") + "Z";
    const d = new Date(normalized);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return t("versions.justNow");
    if (diffMin < 60) return t("versions.minutesAgo", { n: diffMin });
    if (diffHour < 24) return t("versions.hoursAgo", { n: diffHour });
    if (diffDay < 7) return t("versions.daysAgo", { n: diffDay });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const changeTypeLabels: Record<string, { labelKey: string; color: string }> = {
    edit: { labelKey: "versions.typeEdit", color: "bg-blue-500/10 text-blue-500" },
    restore: { labelKey: "versions.typeRestore", color: "bg-amber-500/10 text-amber-500" },
    comment: { labelKey: "versions.typeComment", color: "bg-green-500/10 text-green-500" },
    guest_edit: { labelKey: "versions.typeGuestEdit", color: "bg-violet-500/10 text-violet-500" },
  };

  const filteredVersions = filterVersionsByTab(versions, filter);
  const filterTabs: Array<{ key: VersionFilterTab; labelKey: string }> = [
    { key: "all", labelKey: "versions.tabAll" },
    { key: "manual", labelKey: "versions.tabManual" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="w-full max-w-2xl mx-4 bg-app-elevated rounded-xl shadow-2xl border border-app-border overflow-hidden max-h-[85vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
          <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-3">
            <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center flex-shrink-0">
              <History size={16} className="text-violet-500" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-tx-primary">{t("versions.title")}</h2>
              <p className="text-[11px] text-tx-tertiary truncate">
                {noteTitle} · {t("versions.countLabel", { count: total })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <Button
              size="sm"
              onClick={() => setShowSaveDialog(true)}
              className="h-7 text-xs bg-accent-primary hover:bg-accent-primary/90 text-white"
            >
              <Save size={12} className="mr-1" />
              {t("versions.saveVersion")}
            </Button>
            {total > 0 && (
              confirmClear ? (
                <div className="flex items-center gap-1.5 mr-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmClear(false)}
                    disabled={clearing}
                    className="h-7 text-xs"
                  >
                    {t("versions.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleClearAll}
                    disabled={clearing}
                    className="h-7 text-xs bg-red-500 hover:bg-red-600 text-white"
                  >
                    {clearing ? <Loader2 size={12} className="animate-spin mr-1" /> : <Trash2 size={12} className="mr-1" />}
                    {t("versions.clearConfirmTitle")}
                  </Button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmClear(true)}
                  title={t("versions.clear")}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-tx-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 size={13} />
                  <span>{t("versions.clear")}</span>
                </button>
              )
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-app-hover text-tx-tertiary hover:text-tx-secondary transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* 筛选 Tab（全部 / 手动 / 自动） */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-app-border">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => { setFilter(tab.key); setConfirmDeleteId(null); }}
              className={cn(
                "px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors",
                filter === tab.key
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover"
              )}
            >
              {t(tab.labelKey)}
            </button>
          ))}
          {selectedIds.size > 0 && (
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-[11px] text-tx-tertiary">{t("versions.batchSelected", { count: selectedIds.size })}</span>
              {batchConfirm ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setBatchConfirm(false)} disabled={batchDeleting} className="h-6 text-[11px]">
                    {t("versions.cancel")}
                  </Button>
                  <Button size="sm" onClick={handleBatchDelete} disabled={batchDeleting} className="h-6 text-[11px] bg-red-500 hover:bg-red-600 text-white">
                    {batchDeleting ? <Loader2 size={11} className="animate-spin mr-1" /> : <Trash2 size={11} className="mr-1" />}
                    {t("versions.batchDeleteConfirm")}
                  </Button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setBatchConfirm(true)}
                    className="px-2 py-1 rounded-md text-[11px] text-red-500 hover:bg-red-500/10 transition-colors"
                  >
                    {t("versions.batchDelete")}
                  </button>
                  <button
                    onClick={() => { setSelectedIds(new Set()); setBatchConfirm(false); }}
                    className="px-2 py-1 rounded-md text-[11px] text-tx-tertiary hover:text-tx-secondary transition-colors"
                  >
                    {t("versions.selectNone")}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Content（固定高度：手动/自动 Tab 切换不跳动） */}
        <div className="flex h-[62vh] overflow-hidden min-h-0">
          {/* 版本列表 */}
          <div className="w-1/2 border-r border-app-border flex flex-col">
            <ScrollArea className="flex-1">
              <div className="py-2">
                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 size={20} className="animate-spin text-tx-tertiary" />
                  </div>
                ) : filteredVersions.length === 0 ? (
                  <div className="text-center py-12">
                    <History size={28} className="mx-auto mb-2 text-tx-tertiary/30" />
                    <p className="text-xs text-tx-tertiary">{filter === "all" ? t("versions.empty") : t("versions.tabEmpty")}</p>
                    {filter === "all" && (
                      <p className="text-[10px] text-tx-tertiary/60 mt-0.5">{t("versions.emptyHint")}</p>
                    )}
                  </div>
                ) : (
                  filteredVersions.map((v) => {
                    const ct = changeTypeLabels[v.changeType] || changeTypeLabels.edit;
                    const kind = v.kind ?? "auto";
                    return (
                      <div
                        key={v.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handlePreview(v)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handlePreview(v); } }}
                        className={cn(
                          "w-full text-left px-4 py-3 transition-colors border-b border-app-border/50 hover:bg-app-hover cursor-pointer",
                          selectedVersion?.id === v.id && "bg-accent-primary/5"
                        )}
                      >
                        <div className="flex items-center gap-2 mb-0.5">
                          {/* auto 可多选批量删；manual 不参与批量 */}
                          {kind === "auto" ? (
                            <input
                              type="checkbox"
                              checked={selectedIds.has(v.id)}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => toggleSelected(v.id)}
                              className="h-3.5 w-3.5 flex-shrink-0 accent-violet-500 cursor-pointer"
                              aria-label={t("versions.batchDelete")}
                            />
                          ) : null}
                          {/* 类型徽标：手动=accent 色、自动=灰 */}
                          <span
                            className={cn(
                              "px-1.5 py-0.5 text-[9px] rounded font-medium flex-shrink-0",
                              kind === "manual"
                                ? "bg-accent-primary/10 text-accent-primary"
                                : "bg-app-hover text-tx-tertiary"
                            )}
                          >
                            {kind === "manual" ? t("versions.kindManual") : t("versions.kindAuto")}
                          </span>
                          <span className={cn("px-1.5 py-0.5 text-[9px] rounded font-medium flex-shrink-0", ct.color)}>
                            {t(ct.labelKey)}
                          </span>
                          <span className="text-[10px] text-tx-tertiary flex-shrink-0">v{v.version}</span>
                          <span className="text-[10px] text-tx-tertiary/60 ml-auto flex-shrink-0">{formatTime(v.createdAt)}</span>
                          {/* 单删：inline 二次确认 */}
                          {confirmDeleteId === v.id ? (
                            <span className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => handleDeleteOne(v)}
                                disabled={deleting}
                                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-white bg-red-500 hover:bg-red-600 disabled:opacity-50 transition-colors"
                              >
                                {deleting ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
                                {t("versions.deleteConfirm")}
                              </button>
                              <button
                                onClick={() => setConfirmDeleteId(null)}
                                disabled={deleting}
                                className="px-1.5 py-0.5 rounded text-[10px] text-tx-tertiary hover:text-tx-secondary transition-colors"
                              >
                                {t("versions.cancel")}
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(v.id); }}
                              title={t("versions.delete")}
                              className="p-1 rounded text-tx-tertiary/50 hover:text-red-500 hover:bg-red-500/10 transition-colors flex-shrink-0"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                        <p className="text-xs text-tx-secondary truncate">{v.label || v.title || t("versions.noTitle")}</p>
                        {/* 固定高度槽位：有无描述/摘要行高一致，Tab 切换不跳动 */}
                        <div className="mt-0.5 h-[14px] overflow-hidden">
                          {(v.description || v.changeSummary) && (
                            <p className="text-[10px] text-tx-tertiary truncate">{v.description || v.changeSummary}</p>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </ScrollArea>
            {/* 底部占用统计 */}
            <div className="px-4 py-2 border-t border-app-border">
              <span className="text-[10px] text-tx-tertiary">
                {quotaBytes !== null
                  ? t("versions.statsWithQuota", { count: total, size: formatBytes(bytesTotal), quota: formatBytes(quotaBytes) })
                  : t("versions.statsTotal", { count: total, size: formatBytes(bytesTotal) })}
              </span>
            </div>
          </div>

          {/* 预览区域 */}
          <div className="w-1/2 flex flex-col">
            {selectedVersion ? (
              <>
                <div className="px-4 py-3 border-b border-app-border bg-app-bg/50">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-tx-primary truncate">{selectedVersion.label || selectedVersion.title}</p>
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-tx-tertiary">
                        <span>
                          {t("versions.versionLabel", { version: selectedVersion.version })} · {formatTime(selectedVersion.createdAt)}
                        </span>
                        <span className="rounded bg-app-hover px-1.5 py-0.5 text-[9px] font-medium text-tx-secondary">
                          {previewVersion?.contentFormatLabel || versionContentFormatLabel(selectedVersion.contentFormat)}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {/* P2：与当前版本对比 */}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleToggleDiff()}
                        disabled={loadingDiff}
                        className={cn("h-7 text-xs", diffMode ? "text-accent-primary" : "text-tx-secondary hover:bg-app-hover")}
                      >
                        {loadingDiff ? <Loader2 size={12} className="mr-1 animate-spin" /> : <GitCompare size={12} className="mr-1" />}
                        {diffMode ? t("versions.backToPreview") : t("versions.compareCurrent")}
                      </Button>
                      {/* 从版本创建副本（4.4） */}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDuplicate(selectedVersion)}
                        disabled={duplicating}
                        className="h-7 text-xs text-tx-secondary hover:bg-app-hover"
                      >
                        {duplicating ? <Loader2 size={12} className="animate-spin mr-1" /> : <Copy size={12} className="mr-1" />}
                        {t("versions.duplicate")}
                      </Button>
                      {confirmRestore === selectedVersion.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmRestore(null)}
                            className="h-7 text-xs"
                          >
                            {t("versions.cancel")}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleRestore(selectedVersion.id)}
                            disabled={restoring}
                            className="h-7 text-xs bg-amber-500 hover:bg-amber-600 text-white"
                          >
                            {restoring ? <Loader2 size={12} className="animate-spin mr-1" /> : <RotateCcw size={12} className="mr-1" />}
                            {t("versions.restoreConfirm")}
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmRestore(selectedVersion.id)}
                          className="h-7 text-xs text-amber-500 hover:bg-amber-500/10"
                        >
                          <RotateCcw size={12} className="mr-1" />
                          {t("versions.restore")}
                        </Button>
                      )}
                    </div>
                  </div>
                  {/* 还原确认补充说明（4.3） */}
                  {confirmRestore === selectedVersion.id && (
                    <p className="mt-1.5 text-[10px] text-tx-tertiary">{t("versions.restoreHint")}</p>
                  )}
                </div>
                <ScrollArea className="flex-1">
                  <div className="min-h-[240px]">
                    {loadingPreview || loadingDiff ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 size={16} className="animate-spin text-tx-tertiary" />
                      </div>
                    ) : diffMode ? (
                      diffLinesState === null ? (
                        <div className="flex min-h-[240px] items-center justify-center px-4 py-8 text-xs text-tx-tertiary">
                          {t("versions.diffTooLarge")}
                        </div>
                      ) : diffLinesState.every((line) => line.type === "same") ? (
                        <div className="flex min-h-[240px] items-center justify-center px-4 py-8 text-xs text-tx-tertiary">
                          {t("versions.diffEmpty")}
                        </div>
                      ) : (
                        (() => {
                          const stats = diffStats(diffLinesState);
                          return (
                            <div>
                              <div className="px-4 py-2 text-[10px] text-tx-tertiary border-b border-app-border/50">
                                {t("versions.diffStats", { added: stats.added, removed: stats.removed })}
                              </div>
                              <div className="p-2 font-mono text-[11px] leading-5">
                                {diffLinesState.map((line, idx) => (
                                  <div
                                    key={idx}
                                    className={cn(
                                      "whitespace-pre-wrap break-words px-2",
                                      line.type === "add" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                                      line.type === "del" && "bg-red-500/10 text-red-600 dark:text-red-400",
                                      line.type === "same" && "text-tx-secondary/70"
                                    )}
                                  >
                                    {line.type === "add" ? `+ ${line.text || " "}` : line.type === "del" ? `- ${line.text || " "}` : `  ${line.text}`}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()
                      )
                    ) : previewVersion?.previewMarkdown?.trim() ? (
                      <MarkdownPreview
                        markdown={previewVersion.previewMarkdown}
                        compact
                        className="min-h-[240px] break-words"
                      />
                    ) : (
                      <div className="flex min-h-[240px] items-center justify-center px-4 py-8 text-xs text-tx-tertiary">
                        {t("versions.emptyContent")}
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <FileText size={28} className="mx-auto mb-2 text-tx-tertiary/30" />
                  <p className="text-xs text-tx-tertiary">{t("versions.selectHint")}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 手动保存版本弹窗 */}
        <SaveVersionDialog
          open={showSaveDialog}
          noteId={noteId}
          ensureSaved={ensureSaved}
          onClose={() => setShowSaveDialog(false)}
          onCreated={() => { void loadVersions(); }}
        />
      </motion.div>
    </div>
  );
}
