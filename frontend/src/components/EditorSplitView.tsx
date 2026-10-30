import EncryptedConversionEditorGuard from "./EncryptedConversionEditorGuard";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Eye, Loader2, PanelLeftClose, Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import FormatAwareEditorPane from "@/components/FormatAwareEditorPane";
import NoteTabsBar from "@/components/NoteTabsBar";
import NoteLoadingSkeleton from "@/components/NoteLoadingSkeleton";
import TiptapEditor from "@/components/TiptapEditor";
import MarkdownEditor from "@/components/MarkdownEditor";
import type { NoteEditorHandle, NoteEditorUpdatePayload } from "@/components/editors/types";
import { useApp, useAppActions, type EditorSplitState, type NoteLoadingState } from "@/store/AppContext";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { canWriteNote } from "@/lib/notePermissions";
import type { Note } from "@/types";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { useNoteLoader } from "@/hooks/useNoteLoader";
import { NoteLoadCoordinator, type NoteLoadSink } from "@/lib/noteLoadCoordinator";
import { canApplyRevalidatedNote, loadNoteCacheFirst } from "@/lib/noteLoadSource";
import { loadDraft } from "@/lib/draftStorage";
import {
  EDITOR_SPLIT_DEFAULT_RATIO,
  EDITOR_SPLIT_RATIO_STEP,
  clampEditorSplitRatio,
  flipEditorSplitReferenceSide,
  loadEditorSplitRatio,
  resolveEditorSplitReferenceSide,
  saveEditorSplitRatio,
  shouldActivateSplitPane,
} from "@/lib/editorWorkspaceLayout";
import {
  applyEditorUpdateToNote,
  readEditorSplitMirrorUpdate,
  requestEditorSplitMirror,
  UPDATE_EDITOR_SPLIT_MIRROR_EVENT,
} from "@/lib/editorSplitMirror";

/** 焦点归属：分屏里“谁在编辑”由全局 activeNote 决定，另一栏是参考栏。 */
const SPLIT_PANE_ACTIVATION_IGNORE_SELECTOR = [
  "[data-split-pane-controls]",
  "[data-editor-toolbar]",
  "[data-mobile-editor-toolbar]",
  "button",
  "a",
  "input",
  "textarea",
  "[role='button']",
].join(", ");

export default function EditorSplitView() {
  const { state } = useApp();
  const actions = useAppActions();
  const { prefs } = useUserPreferences();
  const { t } = useTranslation();
  const split = state.editorSplit;
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const pendingRatioRef = useRef(loadEditorSplitRatio(split?.direction || "right"));
  const [splitRatio, setSplitRatio] = useState(pendingRatioRef.current);
  const [referenceReadOnly, setReferenceReadOnly] = useState(false);
  const [referenceSyncing, setReferenceSyncing] = useState(false);
  /** 已完整加载过的文档快照：焦点在左右栏之间切换时用它首帧直出，避免空白/闪烁。 */
  const noteCacheRef = useRef<Map<string, Note>>(new Map());

  useEffect(() => {
    if (!split) return;
    const savedRatio = loadEditorSplitRatio(split.direction);
    pendingRatioRef.current = savedRatio;
    setSplitRatio(savedRatio);
  }, [split?.direction]);

  useEffect(() => {
    setReferenceReadOnly(false);
    setReferenceSyncing(false);
  }, [split?.noteId, split?.direction]);

  useEffect(() => {
    if (!state.activeNote) return;
    noteCacheRef.current.set(state.activeNote.id, state.activeNote);
  }, [state.activeNote]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
      }
    };
  }, []);

  const writeSplitRatio = useCallback((value: number) => {
    const normalized = clampEditorSplitRatio(value);
    pendingRatioRef.current = normalized;
    setSplitRatio(normalized);
    splitContainerRef.current?.style.setProperty("--split-primary", `${normalized * 100}%`);
    splitContainerRef.current?.style.setProperty("--split-secondary", `${(1 - normalized) * 100}%`);
  }, []);

  const commitSplitRatio = useCallback((value: number, direction = split?.direction) => {
    if (!direction) {
      writeSplitRatio(value);
      return;
    }
    writeSplitRatio(saveEditorSplitRatio(direction, value));
  }, [split?.direction, writeSplitRatio]);

  /** 拖拽中的高频写入：只走 rAF + CSS 变量，落盘在 mouseup。 */
  const previewSplitRatio = useCallback((ratio: number) => {
    pendingRatioRef.current = clampEditorSplitRatio(ratio);
    if (dragRafRef.current !== null) return;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = null;
      const primary = `${pendingRatioRef.current * 100}%`;
      const secondary = `${(1 - pendingRatioRef.current) * 100}%`;
      splitContainerRef.current?.style.setProperty("--split-primary", primary);
      splitContainerRef.current?.style.setProperty("--split-secondary", secondary);
    });
  }, []);

  const startResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!split || event.button !== 0) return;
    event.preventDefault();

    const applyRatio = (clientX: number, clientY: number) => {
      const rect = splitContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const raw = split.direction === "down"
        ? (clientY - rect.top) / rect.height
        : (clientX - rect.left) / rect.width;
      previewSplitRatio(raw);
    };

    applyRatio(event.clientX, event.clientY);
    const cursor = split.direction === "down" ? "row-resize" : "col-resize";
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEvent: MouseEvent) => {
      applyRatio(moveEvent.clientX, moveEvent.clientY);
    };
    const cleanup = () => {
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      commitSplitRatio(pendingRatioRef.current, split.direction);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", cleanup);
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", cleanup);
  }, [commitSplitRatio, previewSplitRatio, split]);

  const handleSeparatorDoubleClick = useCallback(() => {
    commitSplitRatio(EDITOR_SPLIT_DEFAULT_RATIO);
  }, [commitSplitRatio]);

  const handleSeparatorKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!split) return;
    const decreaseKey = split.direction === "down" ? "ArrowUp" : "ArrowLeft";
    const increaseKey = split.direction === "down" ? "ArrowDown" : "ArrowRight";
    if (event.key !== decreaseKey && event.key !== increaseKey) return;
    event.preventDefault();
    const delta = event.key === increaseKey ? EDITOR_SPLIT_RATIO_STEP : -EDITOR_SPLIT_RATIO_STEP;
    commitSplitRatio(pendingRatioRef.current + delta);
  }, [commitSplitRatio, split]);

  /**
   * 焦点跟随：把参考栏文档设为主编辑文档。
   * 参考栏位置随之翻转 —— 两栏文档留在原地，只交换“谁是主编辑栏”，
   * 否则会看起来像两份文档左右对调。
   */
  const promoteReferencePane = useCallback((paneNote: Note) => {
    if (!split || !state.activeNote) return;
    if (!shouldActivateSplitPane(paneNote.id, state.activeNote.id)) return;
    actions.splitEditor({
      noteId: state.activeNote.id,
      direction: split.direction,
      referenceSide: flipEditorSplitReferenceSide(split.referenceSide),
    });
    actions.setActiveNote(paneNote);
  }, [actions, split, state.activeNote]);

  /** 交换左右（ArrowLeftRight）：两栏文档互换位置，参考栏留在原侧。 */
  const swapSplitPanes = useCallback((paneNote: Note) => {
    if (!split || !state.activeNote) return;
    if (!shouldActivateSplitPane(paneNote.id, state.activeNote.id)) return;
    actions.splitEditor({
      noteId: state.activeNote.id,
      direction: split.direction,
      referenceSide: resolveEditorSplitReferenceSide(split.referenceSide),
    });
    actions.setActiveNote(paneNote);
  }, [actions, split, state.activeNote]);

  const handleReferencePaneClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!split || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(SPLIT_PANE_ACTIVATION_IGNORE_SELECTOR)) return;
    // 拖选文本/代码时不要抢焦点：选区非空视为“读参考”，保持 activeNote 不变。
    if ((window.getSelection()?.toString() ?? "").length > 0) return;
    const paneNote = noteCacheRef.current.get(split.noteId);
    if (!paneNote) return;
    promoteReferencePane(paneNote);
  }, [promoteReferencePane, split]);

  const handleReferenceNoteLoaded = useCallback((loaded: Note) => {
    noteCacheRef.current.set(loaded.id, loaded);
  }, []);

  const hideNoteList = useCallback(() => {
    if (!state.noteListCollapsed) actions.toggleNoteListCollapsed();
  }, [actions, state.noteListCollapsed]);

  if (!split || !state.activeNote) return <FormatAwareEditorPane />;

  const duplicateDocument = split.noteId === state.activeNote.id;
  const effectiveReadOnly = duplicateDocument || referenceReadOnly;
  const referenceFirst = resolveEditorSplitReferenceSide(split.referenceSide) === "start";
  const referenceTitle = state.openNoteTabs.find((tab) => tab.id === split.noteId)?.title
    || t("editorTabs.noTitle");

  const referenceControls = (
    <div className="flex shrink-0 items-center gap-0.5" data-split-pane-controls="">
      {duplicateDocument ? (
        <span
          className="hidden shrink-0 rounded border border-app-border bg-app-hover px-1.5 py-0.5 text-[10px] text-tx-tertiary sm:inline-flex"
          title={t("editorTabs.sameDocumentMirror", { defaultValue: "同文档只读镜像，避免两个编辑器重复保存" })}
        >
          {t("editorTabs.mirror", { defaultValue: "镜像" })}
        </span>
      ) : referenceReadOnly ? (
        <span
          className="hidden shrink-0 rounded border border-app-border bg-app-hover px-1.5 py-0.5 text-[10px] text-tx-tertiary sm:inline-flex"
          title={t("editorTabs.readOnlyReference", { defaultValue: "只读参考" })}
        >
          {t("editorTabs.readOnly", { defaultValue: "只读" })}
        </span>
      ) : null}
      {referenceSyncing && <Loader2 size={14} className="shrink-0 animate-spin text-tx-tertiary" />}
      {!state.noteListCollapsed && (
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
          onClick={hideNoteList}
          title={t("editorTabs.hideNoteListForSplit", { defaultValue: "隐藏中间笔记列表，扩大分屏空间" })}
          aria-label={t("editorTabs.hideNoteListForSplit", { defaultValue: "隐藏中间笔记列表，扩大分屏空间" })}
        >
          <PanelLeftClose size={14} />
        </button>
      )}
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => setReferenceReadOnly((value) => !value)}
        disabled={duplicateDocument}
        aria-pressed={referenceReadOnly}
        title={duplicateDocument
          ? t("editorTabs.sameDocumentMirror", { defaultValue: "同文档分屏固定为只读镜像" })
          : referenceReadOnly
            ? t("editorTabs.enableSplitEditing", { defaultValue: "允许副屏编辑" })
            : t("editorTabs.useAsReference", { defaultValue: "切换为只读参考" })}
      >
        {referenceReadOnly ? <Eye size={14} /> : <Pencil size={14} />}
      </button>
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => {
          const paneNote = noteCacheRef.current.get(split.noteId);
          if (paneNote) swapSplitPanes(paneNote);
        }}
        disabled={duplicateDocument}
        title={t("editorTabs.promoteSplit", { defaultValue: "设为主编辑文档并交换主副屏" })}
        aria-label={t("editorTabs.promoteSplit", { defaultValue: "设为主编辑文档并交换主副屏" })}
      >
        <ArrowLeftRight size={14} />
      </button>
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
        onClick={actions.closeEditorSplit}
        title={t("editorTabs.closeSplit")}
        aria-label={t("editorTabs.closeSplit")}
      >
        <X size={15} />
      </button>
    </div>
  );

  const separator = (
    <div
      role="separator"
      aria-orientation={split.direction === "down" ? "horizontal" : "vertical"}
      aria-label={t("editorTabs.splitSeparator", { defaultValue: "分屏分隔条" })}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(splitRatio * 100)}
      tabIndex={0}
      title={t("editorTabs.splitSeparatorHint", { defaultValue: "拖动调整分屏比例，双击恢复 50/50" })}
      onMouseDown={startResize}
      onDoubleClick={handleSeparatorDoubleClick}
      onKeyDown={handleSeparatorKeyDown}
      className={cn(
        "group relative shrink-0 bg-app-border hover:bg-accent-primary/30 active:bg-accent-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60",
        split.direction === "down" ? "h-2 w-full cursor-row-resize" : "h-full w-2 cursor-col-resize"
      )}
    >
      <div
        className={cn(
          "absolute rounded-full bg-transparent transition-colors group-hover:bg-accent-primary/70",
          split.direction === "down"
            ? "left-1/2 top-1/2 h-0.5 w-12 -translate-x-1/2 -translate-y-1/2"
            : "left-1/2 top-1/2 h-12 w-0.5 -translate-x-1/2 -translate-y-1/2"
        )}
      />
    </div>
  );

  // 主栏：全局 activeNote 的完整编辑器（含自己的页签栏与格式工具栏）。
  const mainColumn = (
    <SplitPaneColumn
      role="main"
      first={!referenceFirst}
      direction={split.direction}
      header={prefs.enableNoteTabs ? <NoteTabsBar /> : null}
    >
      <FormatAwareEditorPane />
    </SplitPaneColumn>
  );

  // 参考栏：本栏文档独立加载；抬头同样是自己的页签栏，右端挂本栏控件。
  const referenceColumn = (
    <SplitPaneColumn
      role="reference"
      first={referenceFirst}
      direction={split.direction}
      onClick={handleReferencePaneClick}
      header={prefs.enableNoteTabs ? (
        <NoteTabsBar
          currentNoteId={split.noteId}
          compact
          trailing={referenceControls}
          onSelectTab={(noteId) => actions.splitEditor({
            noteId,
            direction: split.direction,
            referenceSide: resolveEditorSplitReferenceSide(split.referenceSide),
          })}
        />
      ) : (
        <div
          className="flex h-9 shrink-0 items-center gap-1.5 border-b border-app-border bg-app-surface/60 px-2.5"
          data-split-pane-controls=""
        >
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-tx-primary" title={referenceTitle}>
            {referenceTitle}
          </div>
          {referenceControls}
        </div>
      )}
    >
      <SplitEditorPane
        key={`split-pane-${split.noteId}`}
        noteId={split.noteId}
        initialNote={noteCacheRef.current.get(split.noteId) ?? null}
        readOnly={effectiveReadOnly}
        duplicateDocument={duplicateDocument}
        onLoaded={handleReferenceNoteLoaded}
        onSyncingChange={setReferenceSyncing}
      />
    </SplitPaneColumn>
  );

  return (
    <div
      className="flex-1 flex flex-col min-w-0 overflow-hidden bg-app-bg"
      data-editor-split-view=""
      data-editor-split-direction={split.direction}
      data-editor-split-reference-side={resolveEditorSplitReferenceSide(split.referenceSide)}
    >
      <div
        ref={splitContainerRef}
        style={{
          "--split-primary": `${splitRatio * 100}%`,
          "--split-secondary": `${(1 - splitRatio) * 100}%`,
        } as React.CSSProperties}
        className={cn(
          "flex-1 min-h-0 min-w-0 overflow-hidden",
          split.direction === "down" ? "flex flex-col" : "flex"
        )}
      >
        {/*
          两栏按视觉位置挂载（不按 key 追踪身份）：参考栏换边时，
          同一个位置上的编辑器换成另一份文档，内容不会左右对调。
        */}
        {referenceFirst ? (
          <>
            {referenceColumn}
            {separator}
            {mainColumn}
          </>
        ) : (
          <>
            {mainColumn}
            {separator}
            {referenceColumn}
          </>
        )}
      </div>
    </div>
  );
}

function SplitPaneColumn({
  role,
  first,
  direction,
  header,
  onClick,
  children,
}: {
  role: "main" | "reference";
  first: boolean;
  direction: EditorSplitState["direction"];
  header?: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  children: React.ReactNode;
}) {
  return (
    <div
      data-editor-split-pane={role}
      data-editor-split-pane-first={first ? "true" : "false"}
      className={cn(
        "flex min-h-0 min-w-0 flex-none flex-col overflow-hidden",
        direction === "down" ? "w-full" : "h-full",
      )}
      style={{ flexBasis: first ? "var(--split-primary)" : "var(--split-secondary)" }}
      onClick={onClick}
    >
      {header}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}

function createSplitLoadingState(): NoteLoadingState {
  return {
    requestId: 0,
    pendingNoteId: null,
    pendingSummary: null,
    startedAt: null,
    visible: false,
    slow: false,
    error: null,
  };
}

interface SplitEditorPaneProps {
  noteId: string;
  /** 已加载过的同文档快照：焦点切换后首帧直出，避免空白。 */
  initialNote: Note | null;
  readOnly: boolean;
  duplicateDocument: boolean;
  onLoaded: (note: Note) => void;
  onSyncingChange: (syncing: boolean) => void;
}

function SplitEditorPane(props: SplitEditorPaneProps) {
  return <EncryptedConversionEditorGuard noteId={props.noteId}><SplitEditorPaneRuntime {...props} /></EncryptedConversionEditorGuard>;
}

function SplitEditorPaneRuntime({
  noteId,
  initialNote,
  readOnly,
  duplicateDocument,
  onLoaded,
  onSyncingChange,
}: SplitEditorPaneProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const { loadNote: loadPrimaryNote } = useNoteLoader();
  const { t } = useTranslation();
  const [note, setNote] = useState<Note | null>(() => {
    if (initialNote?.id === noteId) return initialNote;
    return state.activeNote?.id === noteId ? state.activeNote : null;
  });
  const [loadingState, setLoadingState] = useState<NoteLoadingState>(createSplitLoadingState);
  const coordinatorRef = useRef<NoteLoadCoordinator | null>(null);
  if (!coordinatorRef.current) coordinatorRef.current = new NoteLoadCoordinator();
  const editorHandleRef = useRef<NoteEditorHandle | null>(null);
  const noteRef = useRef<Note | null>(note);
  noteRef.current = note;

  const tabMeta = useMemo(
    () => state.openNoteTabs.find((tab) => tab.id === noteId) || null,
    [noteId, state.openNoteTabs]
  );

  const splitSink = useMemo<NoteLoadSink>(() => ({
    begin: (payload) => setLoadingState({
      requestId: payload.requestId,
      pendingNoteId: payload.noteId,
      pendingSummary: payload.summary,
      startedAt: payload.startedAt,
      visible: false,
      slow: false,
      error: null,
    }),
    show: (requestId) => setLoadingState((current) => current.requestId === requestId
      ? { ...current, visible: true }
      : current),
    markSlow: (requestId) => setLoadingState((current) => current.requestId === requestId
      ? { ...current, slow: true }
      : current),
    finish: (requestId) => setLoadingState((current) => current.requestId === requestId
      ? createSplitLoadingState()
      : current),
    fail: (requestId, error) => setLoadingState((current) => current.requestId === requestId
      ? { ...current, visible: true, slow: false, error }
      : current),
  }), []);

  useEffect(() => {
    const coordinator = coordinatorRef.current!;
    if (duplicateDocument && state.activeNote?.id === noteId) {
      // 同文档镜像：直接复用主编辑器文档，避免第二次读取与重复保存。
      setNote(state.activeNote);
      onLoaded(state.activeNote);
      return () => coordinator.cancel();
    }
    void coordinator.run({
      noteId,
      summary: {
        title: tabMeta?.title || t("editorTabs.noTitle"),
        notebookId: tabMeta?.notebookId || "",
        contentFormat: tabMeta?.contentFormat,
      },
      sink: splitSink,
      request: () => loadNoteCacheFirst({
        noteId,
        fetchRemote: () => api.getNote(noteId),
        onRevalidated: (remote, cached) => {
          if (!canApplyRevalidatedNote({
            current: noteRef.current,
            cached,
            remote,
            hasDraft: !!loadDraft(noteId),
            pendingNoteId: null,
          })) return;
          setNote(remote);
          onLoaded(remote);
          actions.updateNoteInList({
            id: remote.id,
            title: remote.title,
            contentText: remote.contentText,
            version: remote.version,
            updatedAt: remote.updatedAt,
          });
          actions.updateNoteTab({
            id: remote.id,
            title: remote.title,
            contentFormat: remote.contentFormat,
            isLocked: remote.isLocked,
            isTrashed: remote.isTrashed,
            updatedAt: remote.updatedAt,
          });
        },
      }),
      onSuccess: (loaded) => {
        setNote(loaded);
        onLoaded(loaded);
        actions.openNoteTab({
          id: loaded.id,
          title: loaded.title,
          notebookId: loaded.notebookId,
          workspaceId: loaded.workspaceId,
          contentFormat: loaded.contentFormat,
          isLocked: loaded.isLocked,
          isTrashed: loaded.isTrashed,
          updatedAt: loaded.updatedAt,
          pinned: tabMeta?.pinned,
        });
      },
    });
    return () => coordinator.cancel();
  }, [actions, duplicateDocument, noteId, onLoaded, splitSink, t]);

  useEffect(() => {
    return () => {
      try { editorHandleRef.current?.flushSave?.(); } catch { /* ignore */ }
    };
  }, [noteId]);

  useEffect(() => {
    if (!duplicateDocument || state.activeNote?.id !== noteId) return;
    setNote(state.activeNote);
    onLoaded(state.activeNote);
  }, [duplicateDocument, noteId, onLoaded, state.activeNote]);

  useEffect(() => {
    if (!duplicateDocument) return;
    const updateMirror = (event: Event) => {
      const detail = readEditorSplitMirrorUpdate(event);
      if (!detail || detail.noteId !== noteId) return;
      setNote((current) => current ? applyEditorUpdateToNote(current, detail.update) : current);
    };
    window.addEventListener(UPDATE_EDITOR_SPLIT_MIRROR_EVENT, updateMirror);
    requestEditorSplitMirror(noteId);
    return () => window.removeEventListener(UPDATE_EDITOR_SPLIT_MIRROR_EVENT, updateMirror);
  }, [duplicateDocument, noteId]);

  const handleUpdate = useCallback(async (data: NoteEditorUpdatePayload) => {
    const current = noteRef.current;
    if (
      readOnly ||
      !current ||
      state.activeNote?.id === current.id ||
      !canWriteNote(current) ||
      (data._noteId && data._noteId !== current.id)
    ) return;
    onSyncingChange(true);
    try {
      const updated = await api.updateNote(current.id, {
        title: data.title,
        content: data.content ?? current.content,
        contentText: data.contentText ?? current.contentText,
        contentFormat: current.contentFormat,
        version: current.version,
      } as any);
      setNote(updated);
      onLoaded(updated);
      actions.updateNoteInList({
        id: updated.id,
        title: updated.title,
        contentText: updated.contentText,
        updatedAt: updated.updatedAt,
      });
      actions.updateNoteTab({
        id: updated.id,
        title: updated.title,
        updatedAt: updated.updatedAt,
        contentFormat: updated.contentFormat,
        isLocked: updated.isLocked,
        isTrashed: updated.isTrashed,
      });
      if (state.activeNote?.id === updated.id) {
        actions.setActiveNote(updated);
      }
    } catch (err: any) {
      toast.error(err?.message || t("editor.saveFailed"));
    } finally {
      onSyncingChange(false);
    }
  }, [actions, onLoaded, onSyncingChange, readOnly, state.activeNote?.id, t]);

  const handleOpenNote = useCallback(async (targetNoteId: string) => {
    await loadPrimaryNote({
      noteId: targetNoteId,
      summary: { title: t("editor.noteLoading"), notebookId: "" },
      request: () => api.getNote(targetNoteId),
      onSuccess: (target) => {
        actions.setActiveNote(target);
        actions.openNoteTab({
          id: target.id,
          title: target.title,
          notebookId: target.notebookId,
          workspaceId: target.workspaceId,
          contentFormat: target.contentFormat,
          isLocked: target.isLocked,
          isTrashed: target.isTrashed,
          updatedAt: target.updatedAt,
        });
      },
    });
  }, [actions, loadPrimaryNote, t]);

  // 换栏/换文档时绝不渲染上一份文档：note 与 noteId 不一致时按空态处理，
  // 避免“内容对调但编辑器挂旧 doc”。
  const displayNote = note && note.id === noteId ? note : null;
  const editable = !!note && canWriteNote(note) && note.id === noteId && !readOnly && state.activeNote?.id !== noteId && !note.isLocked && !note.isTrashed && !loadingState.pendingNoteId;

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-app-bg"
      data-split-editor-pane={noteId}
    >
      <div
        className="note-theme-surface relative min-h-0 flex-1 overflow-hidden"
        data-note-id={displayNote?.id ?? noteId}
      >
        {loadingState.visible && (
          <NoteLoadingSkeleton
            mode="overlay"
            showHeader={false}
            state={loadingState}
            onRetry={() => { void coordinatorRef.current?.retry(); }}
            loadingLabel={t("editor.noteLoading")}
            errorTitle={t("noteList.loadErrorTitle")}
            errorDescription={t("noteList.loadErrorDesc")}
            retryLabel={t("noteList.retryLoad")}
          />
        )}
        {displayNote ? (
          displayNote.contentFormat === "markdown" ? (
            <MarkdownEditor
              key={`split-md-${displayNote.id}`}
              ref={editorHandleRef}
              note={displayNote}
              onUpdate={handleUpdate}
              editable={editable}
              onOpenNote={handleOpenNote}
            />
          ) : (
            <TiptapEditor
              key={`split-rte-${displayNote.id}`}
              ref={editorHandleRef}
              note={displayNote}
              onUpdate={handleUpdate}
              editable={editable}
              onOpenNote={handleOpenNote}
              searchQuery={state.searchQuery}
            />
          )
        ) : (
          <div className="h-full" aria-hidden="true" />
        )}
      </div>
    </section>
  );
}
