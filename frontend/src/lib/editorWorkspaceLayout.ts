export type EditorWorkspaceMode = "focus" | "split" | "fullscreen";
export type EditorSplitDirection = "right" | "down";
/** 参考栏（副栏）相对主栏沿分屏轴的位置：end=右侧/下方（默认），start=左侧/上方。 */
export type EditorSplitReferenceSide = "start" | "end";

/** The legacy middle note-list column no longer has a keyboard toggle. */
export const EDITOR_LAYOUT_TOGGLE_SHORTCUT_LABEL = "";
const SPLIT_RATIO_STORAGE_PREFIX = "nowen.editorSplit.ratio";

/** 分隔条双击恢复的默认比例（主栏 50%）。 */
export const EDITOR_SPLIT_DEFAULT_RATIO = 0.5;
/** 分隔条键盘微调步长。 */
export const EDITOR_SPLIT_RATIO_STEP = 0.02;

export interface ShortcutLikeEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Kept as a compatibility export for large editor components; always retired. */
export function isEditorLayoutToggleShortcut(_event: ShortcutLikeEvent): boolean {
  return false;
}

export function resolveEditorWorkspaceMode(input: {
  editorFullscreen: boolean;
  noteListCollapsed: boolean;
  hasSplit: boolean;
}): EditorWorkspaceMode {
  if (input.editorFullscreen) return "fullscreen";
  if (input.hasSplit) return "split";
  return "focus";
}

export function clampEditorSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0.2, Math.min(0.8, value));
}

export function getEditorSplitRatioStorageKey(direction: EditorSplitDirection): string {
  return `${SPLIT_RATIO_STORAGE_PREFIX}.${direction}`;
}

export function loadEditorSplitRatio(
  direction: EditorSplitDirection,
  storage: StorageLike | null | undefined = typeof window === "undefined" ? null : window.localStorage,
): number {
  if (!storage) return 0.5;
  try {
    const value = storage.getItem(getEditorSplitRatioStorageKey(direction));
    if (value == null || value.trim() === "") return 0.5;
    return clampEditorSplitRatio(Number(value));
  } catch {
    return 0.5;
  }
}

export function saveEditorSplitRatio(
  direction: EditorSplitDirection,
  value: number,
  storage: StorageLike | null | undefined = typeof window === "undefined" ? null : window.localStorage,
): number {
  const normalized = clampEditorSplitRatio(value);
  if (!storage) return normalized;
  try {
    storage.setItem(getEditorSplitRatioStorageKey(direction), String(normalized));
  } catch {
    // Storage can be unavailable in privacy mode; the in-memory ratio still works.
  }
  return normalized;
}

/** 归一化参考栏位置：缺省（历史状态）为 end。 */
export function resolveEditorSplitReferenceSide(
  side: EditorSplitReferenceSide | null | undefined,
): EditorSplitReferenceSide {
  return side === "start" ? "start" : "end";
}

/**
 * 焦点切换（点副栏抬头/正文把该栏文档设为主文档）时翻转参考栏位置：
 * 两栏的文档留在原地，只交换“谁是主编辑栏”，避免内容对调。
 */
export function flipEditorSplitReferenceSide(
  side: EditorSplitReferenceSide | null | undefined,
): EditorSplitReferenceSide {
  return resolveEditorSplitReferenceSide(side) === "start" ? "end" : "start";
}

/** 该栏文档是否还需要被激活成全局 activeNote（同文档时无需动作）。 */
export function shouldActivateSplitPane(
  paneNoteId: string | null | undefined,
  activeNoteId: string | null | undefined,
): boolean {
  return Boolean(paneNoteId) && paneNoteId !== activeNoteId;
}
