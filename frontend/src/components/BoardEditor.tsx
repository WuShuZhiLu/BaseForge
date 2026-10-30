/**
 * BoardEditor —— 画板文档编辑器（contentFormat = "board"）
 *
 * 场景 JSON 直接作为笔记正文持久化（Excalidraw 官方推荐格式）：
 *   { type: "excalidraw", version: 2, elements: [...], appState: {...}, files: {...} }
 *
 * 实现要点：
 *   - Excalidraw 通过 BoardCanvas 懒加载，普通笔记不承担这部分体积；
 *   - 变更防抖落盘，flushSave/getSnapshot 用 imperative API 现取场景，
 *     避免切换笔记瞬间丢掉最后一个 pointerup 的改动；
 *   - contentText 只取未绑定容器的文本元素（与后端 plainTextFromNoteContent 对齐）；
 *   - 跟随应用深浅色主题。
 */
import React, {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Loader2 } from "lucide-react";

import type { NoteEditorHandle, NoteEditorProps } from "@/components/editors/types";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from "@/components/BoardCanvas";
import { resolveAppAppearanceMode } from "@/lib/appAppearance";

const SAVE_DEBOUNCE_MS = 800;

// Excalidraw 会在“用户空闲状态”等非场景状态变化时也触发 onChange；
// 场景内容没变就不要排队保存，否则会形成每秒一次的无效 PUT。
const BOARD_UI_OPTIONS: ExcalidrawProps["UIOptions"] = {
  canvasActions: { loadScene: false },
};

const EMPTY_BOARD_SCENE =
  '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}';

const loadBoardCanvas = () => import("@/components/BoardCanvas");
const LazyBoardCanvas = lazy(loadBoardCanvas);

type BoardOnChange = NonNullable<ExcalidrawProps["onChange"]>;
type BoardModule = typeof import("@/components/BoardCanvas");

interface SceneElementLike {
  type?: string;
  text?: string;
  isDeleted?: boolean;
  containerId?: string | null;
}

function parseBoardScene(content: string): ExcalidrawInitialDataState | null {
  try {
    const parsed = JSON.parse(content || EMPTY_BOARD_SCENE) as {
      elements?: unknown;
    } | null;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.elements)) return null;
    return parsed as ExcalidrawInitialDataState;
  } catch {
    return null;
  }
}

function textFromSceneElements(elements: readonly SceneElementLike[]): string {
  return elements
    .filter((element) => (
      !element.isDeleted
      && element.type === "text"
      && typeof element.text === "string"
      && !element.containerId
    ))
    .map((element) => element.text!.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const BoardEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(
  function BoardEditor({ note, onUpdate, editable = true }, ref) {
    const [isDark, setIsDark] = useState(() => resolveAppAppearanceMode() === "dark");
    const [initialData] = useState<ExcalidrawInitialDataState | null>(
      () => parseBoardScene(note.content || EMPTY_BOARD_SCENE),
    );

    const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
    const moduleRef = useRef<BoardModule | null>(null);
    const latestRef = useRef({ content: note.content || EMPTY_BOARD_SCENE, contentText: "" });
    const dirtyRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const noteRef = useRef(note);
    noteRef.current = note;

    // 主题跟随应用外观（next-themes 只改 documentElement 的 class/data-theme）。
    useEffect(() => {
      const root = document.documentElement;
      const sync = () => setIsDark(resolveAppAppearanceMode(root) === "dark");
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      let cancelled = false;
      void loadBoardCanvas().then((module) => {
        if (!cancelled) moduleRef.current = module;
      });
      return () => { cancelled = true; };
    }, []);

    // 用 imperative API 现取场景；模块还没加载完时退回 onChange 缓存。
    const readScene = useCallback(() => {
      const api = apiRef.current;
      const module = moduleRef.current;
      if (!api || !module) return latestRef.current;
      const elements = api.getSceneElementsIncludingDeleted();
      return {
        content: module.serializeAsJSON(elements, api.getAppState(), api.getFiles(), "database"),
        contentText: textFromSceneElements(elements),
      };
    }, []);

    const flush = useCallback(() => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      const scene = readScene();
      latestRef.current = scene;
      const current = noteRef.current;
      onUpdate({
        title: current.title,
        content: scene.content,
        contentText: scene.contentText,
        _noteId: current.id,
      });
    }, [onUpdate, readScene]);

    const handleChange = useCallback<BoardOnChange>((elements, appState, files) => {
      const module = moduleRef.current;
      if (!module) return;
      const content = module.serializeAsJSON(elements, appState, files, "database");
      if (content === latestRef.current.content) return;
      latestRef.current = {
        content,
        contentText: textFromSceneElements(elements),
      };
      dirtyRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush();
      }, SAVE_DEBOUNCE_MS);
    }, [flush]);

    const attachCanvasApi = useCallback((api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
    }, []);

    useEffect(() => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    useImperativeHandle(ref, () => ({
      flushSave: flush,
      discardPending: () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        dirtyRef.current = false;
      },
      getSnapshot: () => {
        const scene = readScene();
        latestRef.current = scene;
        return {
          content: scene.content,
          contentText: scene.contentText,
          title: noteRef.current.title,
        };
      },
      isReady: () => apiRef.current !== null,
    }), [flush, readScene]);

    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-app-bg">
        <Suspense
          fallback={(
            <div className="flex h-full items-center justify-center text-tx-tertiary">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
        >
          <LazyBoardCanvas
            initialData={initialData}
            theme={isDark ? "dark" : "light"}
            langCode="zh-CN"
            viewModeEnabled={!editable}
            // 画板正文由应用自动保存；禁用“打开文件”避免误把本机场景覆盖进来。
            UIOptions={BOARD_UI_OPTIONS}
            onChange={handleChange}
            excalidrawAPI={attachCanvasApi}
          />
        </Suspense>
      </div>
    );
  },
);

export default BoardEditor;
