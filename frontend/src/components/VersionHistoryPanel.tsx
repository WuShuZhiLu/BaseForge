import React, { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, History, RotateCcw, FileText, Loader2, Trash2, Save, Copy, Check, GitCompare,
  MoreVertical, ChevronDown, SlidersHorizontal, Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MenuSurface, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { api } from "@/lib/api";
import { Note, NoteVersion, VersionDiffRow, VersionRetentionConfig } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import TiptapEditor from "@/components/TiptapEditor";
import HtmlPreviewPane from "@/components/HtmlPreviewPane";
import { normalizeToMarkdown } from "@/lib/contentFormat";
import SaveVersionDialog from "@/components/SaveVersionDialog";
import { diffLines, diffStats, type DiffLine } from "@/lib/versionDiff";
import { getVersionHistorySettings, primeVersionHistorySettingsCache, getVersionAutoSaveIntervalMinutes, DEFAULT_VERSION_AUTO_SAVE_INTERVAL_MINUTES, VERSION_HISTORY_DEFAULTS } from "@/lib/versionSnapshot";

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

/** diff 对比目标：id 为 "current" 表示与笔记当前内容比较，否则为某个历史版本 id。 */
interface DiffTarget {
  id: string;
  label: string;
}

export type VersionFilterTab = "all" | "manual" | "auto" | "release";

export function versionContentFormatLabel(contentFormat?: string | null): string {
  switch (contentFormat) {
    case "markdown":
      return "Markdown";
    case "tiptap-json":
      return "Rich Text";
    case "html":
      return "HTML";
    case "plain":
      return "Plain Text";
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

/**
 * 将版本快照包装成只读渲染组件（TiptapEditor / HtmlPreviewPane）所需的 Note 形状。
 * id 带版本前缀避免与真实笔记冲突；isLocked=1 确保任何下游逻辑都不尝试写回。
 */
export function versionToNote(version: NoteVersion): Note {
  return {
    id: `version-preview-${version.id}`,
    userId: "version-preview",
    notebookId: "",
    workspaceId: null,
    title: version.label || version.title || "",
    content: version.content || "",
    contentText: version.contentText || "",
    contentFormat: version.contentFormat || "tiptap-json",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 1,
    isArchived: 0,
    isTrashed: 0,
    trashedAt: null,
    version: version.version || 0,
    sortOrder: 0,
    createdAt: version.createdAt,
    updatedAt: version.createdAt,
    tags: [],
  } as Note;
}

/** 按筛选 Tab 过滤版本列表。source 缺省（旧后端不下发）回落 kind，再缺省按 auto 归类；「版本」Tab 仅 source=release。 */
export function filterVersionsByTab(versions: NoteVersion[], tab: VersionFilterTab): NoteVersion[] {
  if (tab === "all") return versions;
  return versions.filter((v) => ((v.source ?? v.kind ?? "auto") as string) === tab);
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

/** 并排 diff 的单行：left=旧（选中版本），right=新（对比目标）；一侧为 null 表示该行无对应内容。 */
export interface DiffSideRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * 将线性 diff 行序列折叠为并排视图行对：连续的 del/add 块按序配对、短侧补 null，
 * same 行左右各占一格。用于「并排」对比模式渲染。
 */
export function pairDiffLines(lines: DiffLine[]): DiffSideRow[] {
  const rows: DiffSideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "same") {
      rows.push({ left: lines[i], right: lines[i] });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type !== "same") {
      (lines[i].type === "del" ? dels : adds).push(lines[i]);
      i += 1;
    }
    const len = Math.max(dels.length, adds.length);
    for (let k = 0; k < len; k += 1) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

/**
 * 服务端 diff 行（v134，type: equal|add|remove）转本地渲染行（same|add|del），
 * 与本地 LCS（lib/versionDiff.ts）共用同一套渲染路径。
 */
export function rowsToDiffLines(rows: VersionDiffRow[]): DiffLine[] {
  return rows.map((row) => ({
    type: row.type === "equal" ? "same" : row.type === "add" ? "add" : "del",
    text: row.text,
  }));
}

/** 版本来源（source）展示元数据；旧数据回落 kind，再回落 auto。 */
const kindMeta: Record<string, { labelKey: string; className: string }> = {
  auto: { labelKey: "versions.sourceAuto", className: "bg-app-hover text-tx-tertiary" },
  manual: { labelKey: "versions.sourceManual", className: "bg-accent-primary/10 text-accent-primary" },
  release: { labelKey: "versions.sourceRelease", className: "bg-violet-500/10 text-violet-500" },
};

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
  const [unreleasing, setUnreleasing] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  // 对比：source=选中版本快照，target=对比目标（含「当前内容」），view=并排/内联
  const [diffMode, setDiffMode] = useState(false);
  const [diffSource, setDiffSource] = useState<{ version: NoteVersion; text: string } | null>(null);
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [diffView, setDiffView] = useState<"side" | "inline">("inline");
  const [diffLinesState, setDiffLinesState] = useState<DiffLine[] | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  // 列表项 hover 操作菜单（fixed 定位渲染，避免被 ScrollArea 裁剪）
  const [hoverMenu, setHoverMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // 保留策略设置（v134：retention 管 auto 定时记录，manualRetention 管 Ctrl+S 记录；release 永不清理）
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [retentionDraft, setRetentionDraft] = useState<{ retention: VersionRetentionConfig; manualRetention: VersionRetentionConfig } | null>(null);
  const [retentionSaving, setRetentionSaving] = useState(false);
  // 保留策略数字输入的草稿文本（key 形如 "retention.count"）；失焦/回车时校验并提交
  const [retentionText, setRetentionText] = useState<Record<string, string>>({});
  // 定时保存间隔（分钟）：null=未加载，草稿文本非空表示编辑中；失焦/回车提交
  const [autoSaveInterval, setAutoSaveInterval] = useState<number | null>(null);
  const [autoSaveIntervalText, setAutoSaveIntervalText] = useState<string | undefined>(undefined);
  const [autoSaveIntervalSaving, setAutoSaveIntervalSaving] = useState(false);
  // P2：配额展示
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

  // 全部记录时间倒序（后端已 desc，这里做一次防御性排序；同刻按版本号新→旧）
  const sortedVersions = useMemo(
    () => [...versions].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || b.version - a.version),
    [versions]
  );

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

  // 预览版本内容（点击同一项保持预览不变，避免整页跳动）
  const handlePreview = async (version: NoteVersion) => {
    setDiffMode(false);
    setDiffLinesState(null);
    setDiffSource(null);
    setDiffTarget(null);
    if (selectedVersion?.id === version.id) return;
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

  // 进入对比模式：source=指定版本，target 默认「当前内容」
  const handleStartCompare = async (version: NoteVersion) => {
    if (loadingDiff) return;
    setLoadingDiff(true);
    setDiffMode(true);
    setDiffView("inline");
    const target: DiffTarget = { id: "current", label: t("versions.diffTargetCurrent") };
    setDiffTarget(target);
    try {
      const srcData = selectedVersion?.id === version.id && previewVersion
        ? previewVersion.version
        : await api.getNoteVersion(noteId, version.id);
      setDiffSource({ version: srcData, text: srcData.contentText || "" });
      // 保证「返回预览」时展示的正是被对比的版本
      if (selectedVersion?.id !== version.id) {
        setPreviewVersion({
          version: srcData,
          previewMarkdown: versionToPreviewMarkdown(srcData),
          contentFormatLabel: versionContentFormatLabel(srcData.contentFormat),
        });
      }
      setDiffLinesState(await computeDiffAgainst(version.id, srcData.contentText || "", target));
    } catch (e) {
      console.warn("[VersionHistoryPanel] diff failed:", e);
      toast.error(t("versions.diffFailed"));
      setDiffMode(false);
    } finally {
      setLoadingDiff(false);
    }
  };

  /**
   * 计算行级 diff：优先走服务端 GET .../versions/diff（需两个版本 id）；
   * 目标是「当前内容」（无版本 id）或接口失败时降级本地 LCS（lib/versionDiff.ts）。
   */
  const computeDiffAgainst = async (sourceId: string, sourceText: string, target: DiffTarget): Promise<DiffLine[] | null> => {
    if (target.id !== "current") {
      try {
        const res = await api.getNoteVersionDiff(noteId, sourceId, target.id);
        return rowsToDiffLines(res.rows);
      } catch (e) {
        console.warn("[VersionHistoryPanel] server diff failed, fallback to local diff:", e);
      }
    }
    const targetText = target.id === "current"
      ? (await api.getNote(noteId)).contentText || ""
      : (await api.getNoteVersion(noteId, target.id)).contentText || "";
    return diffLines(sourceText, targetText);
  };

  // 预览头部的「与当前对比 / 返回预览」开关
  const handleToggleDiff = async () => {
    if (!previewVersion) return;
    if (diffMode) {
      setDiffMode(false);
      return;
    }
    await handleStartCompare(previewVersion.version);
  };

  // 切换对比目标（当前内容 / 任意历史版本），source 保持不变
  const handleSwitchDiffTarget = async (id: string, label: string) => {
    if (!diffSource || loadingDiff) return;
    const target: DiffTarget = { id, label };
    setDiffTarget(target);
    setLoadingDiff(true);
    try {
      setDiffLinesState(await computeDiffAgainst(diffSource.version.id, diffSource.text, target));
    } catch (e) {
      console.warn("[VersionHistoryPanel] switch diff target failed:", e);
      toast.error(t("versions.diffFailed"));
    } finally {
      setLoadingDiff(false);
    }
  };

  // v134：取消发版（release 回落为 manual，参与 manual 保留策略）
  const handleUnrelease = async (version: NoteVersion) => {
    if (unreleasing) return;
    setUnreleasing(true);
    try {
      await api.unreleaseNoteVersion(noteId, version.id);
      toast.success(t("versions.unreleaseSuccess"));
      if (selectedVersion?.id === version.id) setPreviewVersion(null);
      await loadVersions();
    } catch (e: any) {
      console.error("取消发版失败:", e);
      toast.error(t("versions.unreleaseFailed") + (e?.message ? `: ${e.message}` : ""));
    } finally {
      setUnreleasing(false);
    }
  };

  // 保留策略：打开时读取当前偏好，修改即保存（服务端 KV，TTL 缓存同步刷新）
  const handleToggleRetention = () => {
    setRetentionOpen((open) => {
      if (!open && !retentionDraft) {
        getVersionHistorySettings()
          .then((s) => setRetentionDraft({
            retention: s.retention ?? VERSION_HISTORY_DEFAULTS.retention,
            manualRetention: s.manualRetention ?? VERSION_HISTORY_DEFAULTS.manualRetention,
          }))
          .catch(() => setRetentionDraft({ retention: VERSION_HISTORY_DEFAULTS.retention, manualRetention: VERSION_HISTORY_DEFAULTS.manualRetention }));
      }
      if (!open && autoSaveInterval === null) {
        // 内部已容错（失败回落默认 5），不会 reject
        void getVersionAutoSaveIntervalMinutes().then(setAutoSaveInterval);
      }
      return !open;
    });
  };

  const commitRetention = async (next: { retention: VersionRetentionConfig; manualRetention: VersionRetentionConfig }) => {
    setRetentionDraft(next);
    if (retentionSaving) return;
    setRetentionSaving(true);
    try {
      const res = await api.updateVersionHistorySettings({ retention: next.retention, manualRetention: next.manualRetention });
      primeVersionHistorySettingsCache(res.versionHistory);
      toast.success(t("versions.retentionSaved"));
    } catch (e) {
      console.error("保存保留策略失败:", e);
      toast.error(t("versions.retentionFailed"));
    } finally {
      setRetentionSaving(false);
    }
  };

  // 更新某一组保留策略；commit=true 时随整份草稿立即保存（PUT 按 key 局部合并）
  const applyRetention = (key: "retention" | "manualRetention", next: VersionRetentionConfig, commit: boolean) => {
    if (!retentionDraft) return;
    const draft = { ...retentionDraft, [key]: next };
    setRetentionDraft(draft);
    if (commit) void commitRetention(draft);
  };

  // 合并模式（2026-10-30 用户要求）：自动记录与手动保存共用同一份保留策略，一次修改同时写两个 key。
  // 注意：不能连续调两次 applyRetention——后者用闭包里的旧 retentionDraft 整体覆盖，会把第一次的更新冲掉。
  const applyRetentionUnified = (next: VersionRetentionConfig, commit: boolean) => {
    if (!retentionDraft) return;
    const draft = { retention: next, manualRetention: next };
    setRetentionDraft(draft);
    if (commit) void commitRetention(draft);
  };

  // 定时保存间隔：失焦/回车提交；校验 1–120 整数，非法回落当前值并提示
  const commitAutoSaveInterval = () => {
    const raw = autoSaveIntervalText;
    setAutoSaveIntervalText(undefined);
    if (raw === undefined) return;
    const prev = autoSaveInterval ?? DEFAULT_VERSION_AUTO_SAVE_INTERVAL_MINUTES;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n) || n < 1 || n > 120) {
      setAutoSaveInterval(prev);
      toast.error(t("versions.autoSaveIntervalInvalid"));
      return;
    }
    if (n === prev) return;
    setAutoSaveInterval(n);
    setAutoSaveIntervalSaving(true);
    api
      .updateUserPreferences({ versionAutoSaveIntervalMinutes: n } as any)
      .then(() => toast.success(t("versions.autoSaveIntervalSaved")))
      .catch((e) => {
        console.error("保存定时保存间隔失败:", e);
        setAutoSaveInterval(prev);
        toast.error(t("versions.autoSaveIntervalFailed"));
      })
      .finally(() => setAutoSaveIntervalSaving(false));
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

  const filteredVersions = filterVersionsByTab(sortedVersions, filter);
  // 两个 Tab：全部记录（auto/manual/release 全含） / 版本（仅 release）
  const filterTabs: Array<{ key: VersionFilterTab; labelKey: string }> = [
    { key: "all", labelKey: "versions.tabAll" },
    { key: "release", labelKey: "versions.tabRelease" },
  ];

  const hoverMenuVersion = hoverMenu ? versions.find((v) => v.id === hoverMenu.id) || null : null;

  const retentionFieldKey = (key: string, field: "count" | "days") => `${key}.${field}`;

  // 数字输入失焦/回车提交：校验正整数，非法则回退当前值并提示
  const commitRetentionField = (
    key: "retention" | "manualRetention",
    field: "count" | "days",
    config: VersionRetentionConfig
  ) => {
    const fieldKey = retentionFieldKey(key, field);
    const raw = retentionText[fieldKey];
    setRetentionText((prev) => {
      if (!(fieldKey in prev)) return prev;
      const next = { ...prev };
      delete next[fieldKey];
      return next;
    });
    if (raw === undefined) return;
    const n = Number(raw);
    if (raw.trim() !== "" && Number.isInteger(n) && n >= 1) {
      applyRetentionUnified({ ...config, [field]: n }, true);
    } else {
      toast.error(t("versions.retentionInvalid"));
    }
  };

  /** 保留策略单行（表单式两列感）：组名 | 模式分段选择 | 数字输入（自由输入，失焦/回车提交） */
  const renderRetentionRow = (key: "retention" | "manualRetention", groupName: string, config: VersionRetentionConfig) => {
    const modes: Array<{ value: VersionRetentionConfig["mode"]; labelKey: string }> = [
      { value: "forever", labelKey: "versions.retentionModeForever" },
      { value: "count", labelKey: "versions.retentionModeCount" },
      { value: "days", labelKey: "versions.retentionModeDays" },
    ];
    const field: "count" | "days" | null = config.mode === "count" ? "count" : config.mode === "days" ? "days" : null;
    const fieldKey = field ? retentionFieldKey(key, field) : null;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 border-t border-app-border/50 first:border-t-0" key={key}>
        <p className="min-w-[140px] flex-1 text-xs font-medium text-tx-primary">{groupName}</p>
        <div className="flex items-center rounded-lg border border-app-border overflow-hidden">
          {modes.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => applyRetentionUnified({ ...config, mode: m.value }, true)}
              className={cn(
                "px-2.5 py-1 text-[11px] transition-colors",
                config.mode === m.value
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover"
              )}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>
        {field && fieldKey ? (
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              inputMode="numeric"
              value={retentionText[fieldKey] ?? String(field === "count" ? config.count : config.days)}
              onChange={(e) => {
                const digits = e.target.value.replace(/[^\d]/g, "").slice(0, 6);
                setRetentionText((prev) => ({ ...prev, [fieldKey]: digits }));
              }}
              onBlur={() => commitRetentionField(key, field, config)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
              className="h-7 w-20 rounded-lg border border-app-border bg-app-bg px-2 text-xs text-tx-primary tabular-nums focus:border-accent-primary focus:outline-none"
            />
            <span className="text-[10.5px] text-tx-tertiary">
              {t(field === "count" ? "versions.retentionCountUnit" : "versions.retentionDaysUnit")}
            </span>
          </div>
        ) : (
          <span className="w-[104px] text-center text-[11px] text-tx-tertiary/60">—</span>
        )}
      </div>
    );
  };

  /** 对比/内联两种模式共用的行渲染 */
  const renderInlineDiff = (lines: DiffLine[]) => (
    <div className="p-2 font-mono text-[11px] leading-5">
      {lines.map((line, idx) => (
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
  );

  const renderSideBySideDiff = (lines: DiffLine[]) => (
    <div className="font-mono text-[11px] leading-5 min-w-0">
      {pairDiffLines(lines).map((row, idx) => (
        <div key={idx} className="grid grid-cols-2 divide-x divide-app-border border-b border-app-border/30">
          <div
            className={cn(
              "whitespace-pre-wrap break-words px-3 py-0.5",
              row.left?.type === "del" && "bg-red-500/10 text-red-600 dark:text-red-400",
              row.left?.type === "same" && "text-tx-secondary/70"
            )}
          >
            {row.left ? row.left.text : "\u00A0"}
          </div>
          <div
            className={cn(
              "whitespace-pre-wrap break-words px-3 py-0.5",
              row.right?.type === "add" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
              row.right?.type === "same" && "text-tx-secondary/70"
            )}
          >
            {row.right ? row.right.text : "\u00A0"}
          </div>
        </div>
      ))}
    </div>
  );

  const renderDiffBody = () => {
    if (loadingDiff) {
      return (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-tx-tertiary" />
        </div>
      );
    }
    if (diffLinesState === null) {
      return (
        <div className="flex min-h-[240px] items-center justify-center px-4 py-8 text-xs text-tx-tertiary">
          {t("versions.diffTooLarge")}
        </div>
      );
    }
    if (diffLinesState.every((line) => line.type === "same")) {
      return (
        <div className="flex min-h-[240px] items-center justify-center px-4 py-8 text-xs text-tx-tertiary">
          {t("versions.diffEmpty")}
        </div>
      );
    }
    return diffView === "side" ? renderSideBySideDiff(diffLinesState) : renderInlineDiff(diffLinesState);
  };

  const renderEmptyPreview = () => (
    <div className="flex min-h-[240px] items-center justify-center px-4 py-8 text-xs text-tx-tertiary">
      {t("versions.emptyContent")}
    </div>
  );

  /**
   * 预览区分格式渲染（按 contentFormat 分派）：
   *   markdown → MarkdownPreview；tiptap-json → 只读 TiptapEditor（presentationMode）；
   *   html → HtmlPreviewPane（只读）；plain / 未知格式 → 原始文本兜底。
   */
  const renderPreviewBody = () => {
    if (loadingPreview) {
      return (
        <div className="flex flex-1 items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-tx-tertiary" />
        </div>
      );
    }
    const pv = previewVersion;
    if (!pv) return renderEmptyPreview();
    const fmt = pv.version.contentFormat || "tiptap-json";
    if (fmt === "markdown") {
      return pv.previewMarkdown?.trim() ? (
        <ScrollArea className="flex-1 min-h-0">
          <div className="min-h-[240px]">
            <MarkdownPreview markdown={pv.previewMarkdown} compact className="min-h-[240px] break-words" />
          </div>
        </ScrollArea>
      ) : renderEmptyPreview();
    }
    if (fmt === "tiptap-json") {
      const content = pv.version.content || "";
      if (!content.trim() || content.trim() === "{}") return renderEmptyPreview();
      return (
        <div className="flex-1 min-h-0" key={pv.version.id}>
          <TiptapEditor
            note={versionToNote(pv.version)}
            editable={false}
            presentationMode
            isGuest
            onUpdate={() => undefined}
          />
        </div>
      );
    }
    if (fmt === "html") {
      if (!pv.version.content?.trim()) return renderEmptyPreview();
      return (
        <div className="flex-1 min-h-0" key={pv.version.id}>
          <HtmlPreviewPane note={versionToNote(pv.version)} onUpdate={() => undefined} />
        </div>
      );
    }
    // plain / 未知格式：原始文本兜底
    const raw = pv.version.contentText || pv.version.content || "";
    return raw.trim() ? (
      <ScrollArea className="flex-1 min-h-0">
        <pre className="min-h-[240px] whitespace-pre-wrap break-words px-4 py-4 font-mono text-[11.5px] leading-5 text-tx-secondary">
          {raw}
        </pre>
      </ScrollArea>
    ) : renderEmptyPreview();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="w-[min(960px,88vw)] bg-app-elevated rounded-xl shadow-2xl border border-app-border overflow-hidden h-[72vh] max-h-[80vh] flex flex-col"
      >
        {/* Header：标题 + 保留策略 + 保存为版本 + 关闭 */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border">
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
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* 次要操作：设置（保留策略）/ 清空历史 —— ghost 图标按钮 + tooltip */}
            <button
              onClick={handleToggleRetention}
              title={t("versions.retentionTitle")}
              aria-label={t("versions.retentionTitle")}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover transition-colors",
                retentionOpen && "bg-app-hover text-tx-secondary"
              )}
            >
              <SlidersHorizontal size={15} />
            </button>
            {total > 0 && (
              confirmClear ? (
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmClear(false)}
                    disabled={clearing}
                    className="h-8 text-xs"
                  >
                    {t("versions.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleClearAll}
                    disabled={clearing}
                    className="h-8 text-xs bg-red-500 hover:bg-red-600 text-white"
                  >
                    {clearing ? <Loader2 size={12} className="animate-spin mr-1" /> : <Trash2 size={12} className="mr-1" />}
                    {t("versions.clearConfirmTitle")}
                  </Button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmClear(true)}
                  title={t("versions.clear")}
                  aria-label={t("versions.clear")}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-tx-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 size={15} />
                </button>
              )
            )}
            {/* 主操作：保存为版本（全图标，与相邻 ghost 图标按钮一致；文字放 tooltip） */}
            <Button
              size="sm"
              onClick={() => setShowSaveDialog(true)}
              title={t("versions.saveAsVersion")}
              aria-label={t("versions.saveAsVersion")}
              className="h-8 w-8 p-0 bg-accent-primary hover:bg-accent-primary/90 text-white"
            >
              <Save size={14} />
            </Button>
            {/* 关闭：独立最右，与主操作用分隔线区隔 */}
            <div className="mx-0.5 h-5 w-px bg-app-border" aria-hidden="true" />
            <button
              onClick={onClose}
              title={t("versions.close")}
              aria-label={t("versions.close")}
              className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-app-hover text-tx-tertiary hover:text-tx-secondary transition-colors"
            >
              <X size={17} />
            </button>
          </div>
        </div>

        {/* 主体区（Tab + 列表/预览）：relative 容器，设置卡片以覆盖层浮在其上，不挤压内容 */}
        <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* 保留策略设置区块（点击滑杆图标切换显示；absolute 覆盖层，不参与文档流，盖在内容区顶部） */}
        {retentionOpen && (
          <div className="absolute inset-x-0 top-0 z-20 px-5 pt-3 pb-1">
            <div className="rounded-xl border border-app-border bg-app-elevated p-4 shadow-lg">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-tx-primary">
                    <SlidersHorizontal size={14} className="text-accent-primary" />
                    {t("versions.retentionTitle")}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-tx-tertiary">{t("versions.retentionDesc")}</p>
                </div>
                {retentionSaving && (
                  <div className="flex items-center gap-1.5 text-[11px] text-tx-tertiary shrink-0">
                    <Loader2 size={11} className="animate-spin" />
                    <span>…</span>
                  </div>
                )}
              </div>
              {retentionDraft ? (
                <div className="mt-3">
                  {/* 合并模式：自动记录与手动保存共用同一份保留策略 */}
                  {renderRetentionRow("retention", t("versions.retentionGroupAll"), retentionDraft.retention)}
                  {/* 定时保存间隔（分钟）：偏好项，1–120 整数，失焦/回车提交 */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 border-t border-app-border/50">
                    <p className="min-w-[140px] flex-1 text-xs font-medium text-tx-primary">{t("versions.autoSaveInterval")}</p>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={autoSaveIntervalText ?? String(autoSaveInterval ?? DEFAULT_VERSION_AUTO_SAVE_INTERVAL_MINUTES)}
                        onChange={(e) => {
                          const digits = e.target.value.replace(/[^\d]/g, "").slice(0, 3);
                          setAutoSaveIntervalText(digits);
                        }}
                        onBlur={commitAutoSaveInterval}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
                        disabled={autoSaveIntervalSaving}
                        aria-label={t("versions.autoSaveInterval")}
                        className="h-7 w-20 rounded-lg border border-app-border bg-app-bg px-2 text-xs text-tx-primary tabular-nums focus:border-accent-primary focus:outline-none disabled:opacity-50"
                      />
                      <span className="text-[11px] text-tx-tertiary">{t("versions.autoSaveIntervalUnit")}</span>
                      {autoSaveIntervalSaving && <Loader2 size={11} className="animate-spin text-tx-tertiary" />}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center py-4">
                  <Loader2 size={14} className="animate-spin text-tx-tertiary" />
                </div>
              )}
            </div>
          </div>
        )}

        {/* 筛选 Tab（全部记录 / 版本）+ 批量操作条 */}
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

        {/* Content：左列表（窄）+ 右预览（宽，语雀式） */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* 版本列表 */}
          <div className="w-72 shrink-0 border-r border-app-border flex flex-col">
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
                    const sourceKey = ((v.source ?? v.kind ?? "auto") as string);
                    const meta = kindMeta[sourceKey] || kindMeta.auto;
                    return (
                      <div
                        key={v.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handlePreview(v)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handlePreview(v); } }}
                        className={cn(
                          "group relative w-full text-left px-4 py-2.5 transition-colors border-b border-app-border/50 hover:bg-app-hover cursor-pointer",
                          selectedVersion?.id === v.id && "bg-accent-primary/5"
                        )}
                      >
                        <div className="flex items-center gap-1.5 pr-6">
                          {/* auto 可多选批量删；manual/release 不参与批量 */}
                          {sourceKey === "auto" ? (
                            <input
                              type="checkbox"
                              checked={selectedIds.has(v.id)}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => toggleSelected(v.id)}
                              className="h-3.5 w-3.5 flex-shrink-0 accent-violet-500 cursor-pointer"
                              aria-label={t("versions.batchDelete")}
                            />
                          ) : null}
                          {/* 来源标签 */}
                          <span className={cn("px-1.5 py-0.5 text-[9px] rounded font-medium flex-shrink-0", meta.className)}>
                            {t(meta.labelKey)}
                          </span>
                          <span className="text-[10px] text-tx-tertiary flex-shrink-0">v{v.version}</span>
                          <span className="text-[10px] text-tx-tertiary/60 ml-auto flex-shrink-0">{formatTime(v.createdAt)}</span>
                        </div>
                        <div className="mt-0.5 flex items-baseline gap-2 pr-6">
                          <p className="text-xs text-tx-secondary truncate flex-1 min-w-0">{v.label || v.title || t("versions.noTitle")}</p>
                          {/* 大小（后端下发 contentBytes 时展示） */}
                          {typeof v.contentBytes === "number" && v.contentBytes > 0 && (
                            <span className="text-[10px] text-tx-tertiary/70 flex-shrink-0 tabular-nums">{formatBytes(v.contentBytes)}</span>
                          )}
                        </div>
                        {/* 固定高度槽位：有无描述/摘要行高一致，Tab 切换不跳动 */}
                        <div className="mt-0.5 h-[14px] overflow-hidden">
                          {(v.description || v.changeSummary) && (
                            <p className="text-[10px] text-tx-tertiary truncate">{v.description || v.changeSummary}</p>
                          )}
                        </div>
                        {/* hover 操作触发点 */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setHoverMenu({ id: v.id, x: rect.left, y: rect.bottom + 2 });
                          }}
                          title={t("versions.compareWith")}
                          className={cn(
                            "absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-tx-tertiary/60 hover:text-tx-primary hover:bg-app-border/60 transition-colors",
                            hoverMenu?.id === v.id ? "flex" : "hidden group-hover:flex"
                          )}
                        >
                          <MoreVertical size={14} />
                        </button>
                        {/* 单删：inline 二次确认 */}
                        {confirmDeleteId === v.id && (
                          <div className="mt-1.5 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
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
                          </div>
                        )}
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

          {/* 预览 / 对比区域（占大部分宽度） */}
          <div className="flex-1 min-w-0 flex flex-col">
            {selectedVersion ? (
              <>
                <div className="px-4 py-2.5 border-b border-app-border bg-app-bg/50">
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
                    {!diffMode && (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {/* 与当前版本对比 */}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void handleToggleDiff()}
                          disabled={loadingDiff}
                          className="h-7 text-xs text-tx-secondary hover:bg-app-hover"
                        >
                          {loadingDiff ? <Loader2 size={12} className="mr-1 animate-spin" /> : <GitCompare size={12} className="mr-1" />}
                          {t("versions.compareCurrent")}
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
                    )}
                  </div>
                  {/* 还原确认补充说明（4.3） */}
                  {confirmRestore === selectedVersion.id && !diffMode && (
                    <p className="mt-1.5 text-[10px] text-tx-tertiary">{t("versions.restoreHint")}</p>
                  )}
                </div>
                {diffMode ? (
                  <>
                    {/* 对比工具条：目标选择 + 并排/内联 + 统计 */}
                    <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-app-border">
                      <span className="text-[10.5px] text-tx-tertiary shrink-0">{t("versions.diffTargetLabel")}</span>
                      <div className="relative shrink-0">
                        <button
                          onClick={() => setTargetMenuOpen((o) => !o)}
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-tx-primary bg-app-hover hover:bg-app-border/60 transition-colors"
                        >
                          <span className="max-w-[160px] truncate">{diffTarget?.label}</span>
                          <ChevronDown size={12} className="text-tx-tertiary" />
                        </button>
                        {targetMenuOpen && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setTargetMenuOpen(false); }} />
                            <MenuSurface className="absolute left-0 top-full mt-1 z-50 max-h-64 overflow-y-auto">
                              <MenuItem
                                label={t("versions.diffTargetCurrent")}
                                checked={diffTarget?.id === "current"}
                                onClick={() => { setTargetMenuOpen(false); void handleSwitchDiffTarget("current", t("versions.diffTargetCurrent")); }}
                              />
                              {versions.filter((v) => v.id !== diffSource?.version.id).length > 0 && <MenuSeparator />}
                              {versions
                                .filter((v) => v.id !== diffSource?.version.id)
                                .map((v) => (
                                  <MenuItem
                                    key={v.id}
                                    label={`v${v.version} · ${formatTime(v.createdAt)}`}
                                    checked={diffTarget?.id === v.id}
                                    onClick={() => { setTargetMenuOpen(false); void handleSwitchDiffTarget(v.id, `v${v.version} · ${formatTime(v.createdAt)}`); }}
                                  />
                                ))}
                            </MenuSurface>
                          </>
                        )}
                      </div>
                      <div className="flex items-center rounded-md border border-app-border overflow-hidden shrink-0">
                        {(["side", "inline"] as const).map((m) => (
                          <button
                            key={m}
                            onClick={() => setDiffView(m)}
                            className={cn(
                              "px-2 py-1 text-[11px] transition-colors",
                              diffView === m ? "bg-accent-primary/10 text-accent-primary" : "text-tx-tertiary hover:text-tx-secondary"
                            )}
                          >
                            {t(m === "side" ? "versions.diffSideBySide" : "versions.diffInline")}
                          </button>
                        ))}
                      </div>
                      {diffLinesState !== null && !loadingDiff && (() => {
                        const s = diffStats(diffLinesState);
                        return <span className="text-[10.5px] text-tx-tertiary shrink-0">{t("versions.diffStats", { added: s.added, removed: s.removed })}</span>;
                      })()}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDiffMode(false)}
                        className="ml-auto h-7 text-xs text-tx-secondary hover:bg-app-hover"
                      >
                        {t("versions.backToPreview")}
                      </Button>
                    </div>
                    <ScrollArea className="flex-1 min-h-0">
                      <div className="min-h-[240px]">{renderDiffBody()}</div>
                    </ScrollArea>
                  </>
                ) : (
                  renderPreviewBody()
                )}
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
        </div>

        {/* 列表项 hover 操作菜单（fixed 定位，避免被 ScrollArea 裁剪） */}
        {hoverMenu && hoverMenuVersion && (
          <>
            <div className="fixed inset-0 z-[60]" onClick={(e) => { e.stopPropagation(); setHoverMenu(null); }} />
            <MenuSurface
              className="fixed z-[70] w-48"
              style={{ top: hoverMenu.y, left: Math.max(8, hoverMenu.x - 176) }}
            >
              <MenuItem
                icon={GitCompare}
                label={t("versions.compareCurrent")}
                onClick={() => { const v = hoverMenuVersion; setHoverMenu(null); void handleStartCompare(v); }}
              />
              <MenuItem
                icon={Copy}
                label={t("versions.duplicate")}
                onClick={() => { const v = hoverMenuVersion; setHoverMenu(null); handleDuplicate(v); }}
              />
              <MenuItem
                icon={RotateCcw}
                label={t("versions.restore")}
                onClick={() => { const v = hoverMenuVersion; setHoverMenu(null); void handlePreview(v); setConfirmRestore(v.id); }}
              />
              {((hoverMenuVersion.source ?? hoverMenuVersion.kind) === "release") && (
                <MenuItem
                  icon={Undo2}
                  label={t("versions.unrelease")}
                  disabled={unreleasing}
                  onClick={() => { const v = hoverMenuVersion; setHoverMenu(null); void handleUnrelease(v); }}
                />
              )}
              <MenuSeparator />
              <MenuItem
                icon={Trash2}
                danger
                label={t("versions.delete")}
                onClick={() => { const id = hoverMenu.id; setHoverMenu(null); setConfirmDeleteId(id); }}
              />
            </MenuSurface>
          </>
        )}

        {/* 保存为版本弹窗（v134：POST /versions 恒产 source=release；弹窗内名称/描述为可选输入） */}
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
