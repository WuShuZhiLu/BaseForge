import EncryptedConversionEditorGuard from "./EncryptedConversionEditorGuard";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftRight,
  Columns2,
  Eye,
  FileText,
  Loader2,
  PanelLeftClose,
  Pencil,
  RotateCcw,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import FormatAwareEditorPane from "@/components/FormatAwareEditorPane";
import {
  EditorToolbarExpandSlot,
  EditorToolbarHost,
} from "@/components/CollapsibleEditorToolbar";
import { MenuItem, MenuSeparator, MenuSurface } from "@/components/ui/menu";
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
  publishEditorSplitMirrorUpdate,
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

/**
 * 分隔条按下后位移超过该阈值才算拖拽（改比例）；否则松开时按“点击”处理，弹出操作菜单。
 * 3px 是鼠标抖动与真实拖动的经验分界。
 */
const SPLIT_SEPARATOR_DRAG_THRESHOLD = 3;
/** 点击后延时弹菜单：给双击（复位 50/50）留出取消窗口。 */
const SPLIT_SEPARATOR_MENU_DELAY_MS = 220;
/** 分屏操作菜单的估算尺寸，用于把浮层夹在视口内。 */
const SPLIT_MENU_WIDTH = 208;
const SPLIT_MENU_HEIGHT = 176;
/**
 * 失焦栏的工具栏（写死在编辑器内部）必须让位给全宽那一条：
 * 聚焦栏的桌面 expanded 工具栏被 portal 到全宽行（不在本栏子树内，不受此类影响）；
 * 失焦栏的工具栏就地渲染，由这两条类在桌面隐藏。移动端 compact 与它的“更多”展开行不受影响。
 */
const REFERENCE_PANE_TOOLBAR_HIDDEN_CLASS = [
  "md:[&_[data-mobile-editor-toolbar=expanded]]:hidden",
  "md:[&_[data-markdown-mobile-toolbar=expanded]]:hidden",
].join(" ");

export default function EditorSplitView() {
  const { state } = useApp();
  const actions = useAppActions();
  const { t } = useTranslation();
  const split = state.editorSplit;
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const pendingRatioRef = useRef(loadEditorSplitRatio(split?.direction || "right"));
  const [splitRatio, setSplitRatio] = useState(pendingRatioRef.current);
  const [referenceReadOnly, setReferenceReadOnly] = useState(false);
  const [referenceSyncing, setReferenceSyncing] = useState(false);
  /** 分隔条点击弹出的分屏操作菜单（视口坐标）；null = 关闭。 */
  const [splitMenuAt, setSplitMenuAt] = useState<{ x: number; y: number } | null>(null);
  /** 已完整加载过的文档快照：栏内文档换篇后用它首帧直出，避免空白/闪烁。 */
  const noteCacheRef = useRef<Map<string, Note>>(new Map());
  /** 分屏顶部的全宽工具栏落点行（聚焦栏的编辑器把桌面工具栏 portal 进来）。 */
  const [toolbarRowEl, setToolbarRowEl] = useState<HTMLDivElement | null>(null);
  /** 分隔条“点击后延时开菜单”的定时器：双击复位时用它取消。 */
  const separatorMenuTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!split) return;
    const savedRatio = loadEditorSplitRatio(split.direction);
    pendingRatioRef.current = savedRatio;
    setSplitRatio(savedRatio);
  }, [split?.direction]);

  useEffect(() => {
    setReferenceReadOnly(false);
    setReferenceSyncing(false);
    setSplitMenuAt(null);
  }, [split?.noteId, split?.direction]);

  useEffect(() => {
    if (!state.activeNote) return;
    noteCacheRef.current.set(state.activeNote.id, state.activeNote);
  }, [state.activeNote]);

  // 菜单打开期间按 Esc 关闭（捕获阶段，抢在编辑器快捷键之前吃掉）。
  useEffect(() => {
    if (!splitMenuAt) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setSplitMenuAt(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [splitMenuAt]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
      }
      if (separatorMenuTimerRef.current !== null) {
        window.clearTimeout(separatorMenuTimerRef.current);
        separatorMenuTimerRef.current = null;
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

  /**
   * 分隔条按下：位移 > 3px 才算拖拽（改比例），否则按“点击”处理，松开后弹出操作菜单。
   * 按下不再立即把比例跳到光标处 —— 那样单击就会挪动分隔条，和“点击弹菜单”互相打架。
   */
  const startResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!split || event.button !== 0) return;
    event.preventDefault();
    if (separatorMenuTimerRef.current !== null) {
      window.clearTimeout(separatorMenuTimerRef.current);
      separatorMenuTimerRef.current = null;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const cursor = split.direction === "down" ? "row-resize" : "col-resize";
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let dragging = false;

    const applyRatio = (clientX: number, clientY: number) => {
      const rect = splitContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const raw = split.direction === "down"
        ? (clientY - rect.top) / rect.height
        : (clientX - rect.left) / rect.width;
      previewSplitRatio(raw);
    };

    const detach = () => {
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      dragCleanupRef.current = null;
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!dragging) {
        const moved = Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY);
        if (moved <= SPLIT_SEPARATOR_DRAG_THRESHOLD) return;
        dragging = true;
        document.body.style.cursor = cursor;
        document.body.style.userSelect = "none";
      }
      applyRatio(moveEvent.clientX, moveEvent.clientY);
    };

    const onMouseUp = () => {
      detach();
      if (dragging) {
        commitSplitRatio(pendingRatioRef.current, split.direction);
        return;
      }
      // 单击：延时弹菜单，给双击（复位 50/50）留出取消窗口。
      separatorMenuTimerRef.current = window.setTimeout(() => {
        separatorMenuTimerRef.current = null;
        setSplitMenuAt({ x: startX, y: startY });
      }, SPLIT_SEPARATOR_MENU_DELAY_MS);
    };

    // 上一轮若没收尾（例如鼠标在窗口外松开）：只解绑，不落盘、不弹菜单。
    dragCleanupRef.current?.();
    dragCleanupRef.current = detach;
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [commitSplitRatio, previewSplitRatio, split]);

  const handleSeparatorDoubleClick = useCallback(() => {
    if (separatorMenuTimerRef.current !== null) {
      window.clearTimeout(separatorMenuTimerRef.current);
      separatorMenuTimerRef.current = null;
    }
    setSplitMenuAt(null);
    commitSplitRatio(EDITOR_SPLIT_DEFAULT_RATIO);
  }, [commitSplitRatio]);

  const handleSeparatorKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!split) return;
    if (event.key === "Enter" || event.key === " ") {
      // 键盘等价于单击分隔条：在分隔条中心弹出操作菜单。
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setSplitMenuAt({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      return;
    }
    const decreaseKey = split.direction === "down" ? "ArrowUp" : "ArrowLeft";
    const increaseKey = split.direction === "down" ? "ArrowDown" : "ArrowRight";
    if (event.key !== decreaseKey && event.key !== increaseKey) return;
    event.preventDefault();
    const delta = event.key === increaseKey ? EDITOR_SPLIT_RATIO_STEP : -EDITOR_SPLIT_RATIO_STEP;
    commitSplitRatio(pendingRatioRef.current + delta);
  }, [commitSplitRatio, split]);

  // 主栏文档 id：新状态显式保存；旧状态缺省时迁移为当时的 activeNote（无主文档 → null 空态）。
  const primaryNoteId = split
    ? (split.primaryNoteId !== undefined ? split.primaryNoteId : (state.activeNote?.id ?? null))
    : null;

  /**
   * 聚焦某一栏：两栏与文档的绑定原地不动，只把全局 activeNote 指向该栏文档。
   * 不交换文档、不重挂载任何编辑器，因此不触发离开保存/版本快照。
   */
  const focusSplitPane = useCallback((paneNoteId: string) => {
    if (!split) return;
    const activeNote = state.activeNote;
    if (!activeNote || !shouldActivateSplitPane(paneNoteId, activeNote.id)) return;
    const paneNote = noteCacheRef.current.get(paneNoteId);
    if (!paneNote) return;
    actions.setActiveNote(paneNote);
  }, [actions, split, state.activeNote]);

  const handlePaneActivation = useCallback((event: React.MouseEvent<HTMLDivElement>, paneNoteId: string | null) => {
    if (event.button !== 0 || !paneNoteId) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(SPLIT_PANE_ACTIVATION_IGNORE_SELECTOR)) return;
    // 拖选文本/代码时不要抢焦点：选区非空视为“阅读”，保持 activeNote 不变。
    if ((window.getSelection()?.toString() ?? "").length > 0) return;
    focusSplitPane(paneNoteId);
  }, [focusSplitPane]);

  const handlePrimaryPaneClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    handlePaneActivation(event, primaryNoteId);
  }, [handlePaneActivation, primaryNoteId]);

  const handleReferencePaneClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    handlePaneActivation(event, split?.noteId ?? null);
  }, [handlePaneActivation, split]);

  /** ⇄ 交换两栏视觉位置：文档与栏的绑定不动，只翻转参考栏在哪一侧。 */
  const swapSplitSides = useCallback(() => {
    if (!split) return;
    actions.splitEditor({
      noteId: split.noteId,
      primaryNoteId,
      direction: split.direction,
      referenceSide: flipEditorSplitReferenceSide(split.referenceSide),
    });
  }, [actions, primaryNoteId, split]);

  const handleNoteLoaded = useCallback((loaded: Note) => {
    noteCacheRef.current.set(loaded.id, loaded);
  }, []);

  const hideNoteList = useCallback(() => {
    if (!state.noteListCollapsed) actions.toggleNoteListCollapsed();
  }, [actions, state.noteListCollapsed]);

  if (!split) return <FormatAwareEditorPane />;

  // 同文档镜像：两栏绑定同一篇文档（primaryNoteId === noteId），参考栏固定只读。
  const duplicateDocument = !!primaryNoteId && primaryNoteId === split.noteId;
  // 聚焦归属：文档 id === activeNote.id 的栏是焦点栏（唯一可编辑、认领全宽工具栏）。
  // 镜像态固定主栏为焦点栏，避免两栏同时认领工具栏。
  const activeNoteId = state.activeNote?.id ?? null;
  const primaryIsFocused = !!primaryNoteId && primaryNoteId === activeNoteId;
  const referenceIsFocused = !duplicateDocument && split.noteId === activeNoteId;
  const effectiveReadOnly = duplicateDocument || referenceReadOnly;
  const referenceFirst = resolveEditorSplitReferenceSide(split.referenceSide) === "start";

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
        onClick={swapSplitSides}
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
      title={t("editorTabs.splitSeparatorHint", {
        defaultValue: "拖动调整分屏比例，单击打开操作菜单，双击恢复 50/50",
      })}
      aria-haspopup="menu"
      aria-expanded={!!splitMenuAt}
      onMouseDown={startResize}
      onDoubleClick={handleSeparatorDoubleClick}
      onKeyDown={handleSeparatorKeyDown}
      style={{ order: 1 }}
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

  // 主栏空态：沿用编辑区既有空态的视觉（图标 + 主/副文案），只换成「先有分屏、后选文档」
  // 的说法，提示用户从左侧选一篇，参考栏保持原文档不动。
  const mainEmptyState = (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 items-center justify-center px-6"
      data-editor-split-empty="main"
    >
      <div className="flex flex-col items-center text-center">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-accent-primary/10 bg-accent-primary/5">
          <FileText size={28} className="text-accent-primary/30" />
        </div>
        <p className="mb-1 text-sm font-medium text-tx-secondary">{t("editor.selectNote")}</p>
        <p className="max-w-[220px] text-xs leading-relaxed text-tx-tertiary">
          {t("editorTabs.splitEmptyMainHint", {
            defaultValue: "从左侧选择或新建一篇文档，参考栏保留当前文档",
          })}
        </p>
      </div>
    </div>
  );

  /**
   * 参考栏控件条：挂在分屏容器层的固定位置（视觉上始终右上角），
   * 不属于任何一栏，因此 ⇄ 交换左右后它不随参考栏换边移动。
   * 浮层本身 pointer-events-none，控件条 pointer-events-auto；
   * 点击仍作用于参考栏文档（split.noteId），行为不变。
   */
  const referenceControlsOverlay = (
    <div
      className="pointer-events-none absolute right-2 top-2 z-40 flex justify-end"
      data-split-pane-controls-anchor=""
    >
      <div
        className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-md px-0.5 shadow-sm backdrop-blur"
        style={{ backgroundColor: "color-mix(in srgb, var(--color-elevated) 80%, transparent)" }}
        data-split-pane-controls=""
      >
        {referenceControls}
      </div>
    </div>
  );

  // 主栏：固定绑定 primaryNoteId 的文档（与 activeNote 解耦，聚焦切换不换篇）。
  // 页签栏已提到分屏容器顶部（全宽一套），栏内不再重复。
  const primaryColumn = (
    <SplitPaneColumn
      role="main"
      first={!referenceFirst}
      direction={split.direction}
      order={referenceFirst ? 2 : 0}
      onClick={handlePrimaryPaneClick}
      contentClassName={REFERENCE_PANE_TOOLBAR_HIDDEN_CLASS}
    >
      {primaryNoteId ? (
        <PaneToolbarScope active={primaryIsFocused} toolbarRow={toolbarRowEl}>
          <SplitEditorPane
            key={`pane-${primaryNoteId}`}
            noteId={primaryNoteId}
            initialNote={noteCacheRef.current.get(primaryNoteId) ?? null}
            readOnly={false}
            duplicateDocument={duplicateDocument}
            onLoaded={handleNoteLoaded}
            onSyncingChange={noopSyncing}
          />
        </PaneToolbarScope>
      ) : mainEmptyState}
    </SplitPaneColumn>
  );

  // 参考栏：固定绑定 split.noteId 的文档，独立加载；控件条已上提到分屏容器层（固定右上角）。
  // 失焦栏的桌面工具栏就地渲染，由 REFERENCE_PANE_TOOLBAR_HIDDEN_CLASS 让位给全宽那条。
  const referenceColumn = (
    <SplitPaneColumn
      role="reference"
      first={referenceFirst}
      direction={split.direction}
      order={referenceFirst ? 0 : 2}
      onClick={handleReferencePaneClick}
      contentClassName={REFERENCE_PANE_TOOLBAR_HIDDEN_CLASS}
    >
      <PaneToolbarScope active={referenceIsFocused} toolbarRow={toolbarRowEl}>
        <SplitEditorPane
          key={`pane-${split.noteId}`}
          noteId={split.noteId}
          initialNote={noteCacheRef.current.get(split.noteId) ?? null}
          readOnly={effectiveReadOnly}
          duplicateDocument={duplicateDocument}
          onLoaded={handleNoteLoaded}
          onSyncingChange={setReferenceSyncing}
        />
      </PaneToolbarScope>
    </SplitPaneColumn>
  );

  const menuX = splitMenuAt
    ? Math.max(8, Math.min(splitMenuAt.x, window.innerWidth - SPLIT_MENU_WIDTH - 8))
    : 0;
  const menuY = splitMenuAt
    ? Math.max(8, Math.min(splitMenuAt.y, window.innerHeight - SPLIT_MENU_HEIGHT - 8))
    : 0;

  const splitViewBody = (
    <div
      className="flex-1 flex flex-col min-w-0 overflow-hidden bg-app-bg"
      data-editor-split-view=""
      data-editor-split-direction={split.direction}
      data-editor-split-reference-side={resolveEditorSplitReferenceSide(split.referenceSide)}
    >
      {/*
        这里曾挂一条全宽页签栏（受「启用顶部笔记标签页」开关控制）。
        该栏与侧栏「打开的编辑器」面板能力重复（切换/关闭/关闭其他/工具页签全部
        覆盖），且只在应用级分屏时才可能渲染，默认开关关闭时从未露面。已移除，
        打开列表统一由侧栏面板呈现。
      */}

      {/*
        全宽格式工具栏落点行：聚焦栏的编辑器（PaneToolbarScope 内）把自己的
        EditorToolbarExpandSlot portal 到这里，工具栏宽度 = 整个分屏宽度，作用的是聚焦栏文档。
        没有聚焦栏（例如主栏空态、两栏都失焦）时该行为空，高度归零。
      */}
      <div ref={setToolbarRowEl} className="shrink-0" data-editor-split-toolbar-row="" />

      <div
        ref={splitContainerRef}
        style={{
          "--split-primary": `${splitRatio * 100}%`,
          "--split-secondary": `${(1 - splitRatio) * 100}%`,
        } as React.CSSProperties}
        className={cn(
          "relative flex-1 min-h-0 min-w-0 overflow-hidden",
          split.direction === "down" ? "flex flex-col" : "flex"
        )}
      >
        {/*
          两栏与文档固定绑定（key = pane-${noteId}），DOM 顺序固定；
          参考栏换边（⇄）只翻转 CSS order，不重挂载任何编辑器。
          控件条挂在容器层固定右上角（不随换边移动），z 高于两栏内容。
        */}
        {primaryColumn}
        {separator}
        {referenceColumn}
        {referenceControlsOverlay}
      </div>

      {/*
        分隔条操作菜单：单击分隔条 / Enter / Space 打开，点外部或 Esc 关闭。
        整屏透明背板负责“点外部关闭”，菜单本体挂 fixed 坐标以免被分屏容器裁掉。
      */}
      {splitMenuAt && createPortal(
        <div
          className="fixed inset-0 z-[90]"
          data-editor-split-menu-backdrop=""
          onMouseDown={() => setSplitMenuAt(null)}
        >
          <MenuSurface
            style={{ left: menuX, top: menuY }}
            className="fixed z-[91]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <MenuItem
              icon={Columns2}
              label={t("editorTabs.splitMenuSwitch")}
              disabled={duplicateDocument || !state.activeNote}
              onClick={() => {
                setSplitMenuAt(null);
                focusSplitPane(split.noteId);
              }}
            />
            <MenuItem
              icon={ArrowLeftRight}
              label={t("editorTabs.splitMenuSwap")}
              disabled={duplicateDocument || !state.activeNote}
              onClick={() => {
                setSplitMenuAt(null);
                swapSplitSides();
              }}
            />
            <MenuSeparator />
            <MenuItem
              icon={RotateCcw}
              label={t("editorTabs.splitMenuReset")}
              hint="50 / 50"
              onClick={() => {
                setSplitMenuAt(null);
                commitSplitRatio(EDITOR_SPLIT_DEFAULT_RATIO);
              }}
            />
            <MenuItem
              icon={X}
              label={t("editorTabs.splitMenuClose")}
              onClick={() => {
                setSplitMenuAt(null);
                actions.closeEditorSplit();
              }}
            />
          </MenuSurface>
        </div>,
        document.body
      )}
    </div>
  );

  // 不再包全局宿主：每栏在 PaneToolbarScope 里各有一个独立宿主，
  // 聚焦栏把自己的工具栏落点 portal 到全宽行，失焦栏就地渲染（整栏样式隐藏）。
  return splitViewBody;
}

/** 主栏编辑器保存时的同步指示不占独立 UI（保存状态经页签/列表体现），占位回调保持 props 形状稳定。 */
function noopSyncing(_syncing: boolean): void {}

/**
 * 单栏工具栏作用域：每栏一个独立宿主（组件类型与树位置固定，聚焦切换不重挂载栏内编辑器）。
 * 聚焦栏把自己的 EditorToolbarExpandSlot portal 到分屏顶部的全宽行 → 桌面工具栏横跨全宽；
 * 失焦栏不渲染落点（宿主 target 为空）→ 工具栏就地渲染，由整栏样式在桌面隐藏。
 */
function PaneToolbarScope({
  active,
  toolbarRow,
  children,
}: {
  active: boolean;
  toolbarRow: HTMLDivElement | null;
  children: React.ReactNode;
}) {
  return (
    <EditorToolbarHost>
      {children}
      {active && toolbarRow && createPortal(
        <EditorToolbarExpandSlot
          location="header"
          className="w-full [&>*]:w-full [&>*]:min-w-0"
        />,
        toolbarRow,
      )}
    </EditorToolbarHost>
  );
}

function SplitPaneColumn({
  role,
  first,
  order,
  direction,
  contentClassName,
  onClick,
  children,
}: {
  role: "main" | "reference";
  first: boolean;
  /** CSS order：DOM 顺序固定，参考栏换边只翻转视觉位置，不重挂载两栏编辑器。 */
  order: number;
  direction: EditorSplitState["direction"];
  /** 附加到正文容器的类（例如失焦时隐藏编辑器自带的桌面工具栏）。 */
  contentClassName?: string;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  children: React.ReactNode;
}) {
  return (
    <div
      data-editor-split-pane={role}
      data-editor-split-pane-first={first ? "true" : "false"}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-none flex-col overflow-hidden",
        direction === "down" ? "w-full" : "h-full",
      )}
      style={{
        flexBasis: first ? "var(--split-primary)" : "var(--split-secondary)",
        order,
      }}
      onClick={onClick}
    >
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", contentClassName)}>
        {children}
      </div>
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
      !canWriteNote(current) ||
      (data._noteId && data._noteId !== current.id)
    ) return;
    if (duplicateDocument) {
      // 同文档镜像：本栏是可编辑的主栏，把更新实时广播给只读镜像栏。
      publishEditorSplitMirrorUpdate(current.id, data);
    }
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
  }, [actions, duplicateDocument, onLoaded, onSyncingChange, readOnly, state.activeNote?.id, t]);

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
  // 焦点栏与副屏（“允许副屏编辑”）都可编辑：保存由本栏 SplitEditorPane 自理，
  // 不再依赖“是否 activeNote”分流到主编辑器。
  const editable = !!note && canWriteNote(note) && note.id === noteId && !readOnly && !note.isLocked && !note.isTrashed && !loadingState.pendingNoteId;

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
