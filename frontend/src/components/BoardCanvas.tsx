/**
 * Excalidraw 画布（重模块，仅由 BoardEditor / BoardEmbedCard 懒加载）
 *
 * 单独成文件的目的：把 @excalidraw/excalidraw 及其 CSS、字体资源打到
 * 独立的 chunk 里，普通笔记不打开画板就不会下载这块代码。
 */
import "@excalidraw/excalidraw/index.css";
import {
  Excalidraw,
  exportToSvg,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

export { Excalidraw, exportToSvg, restoreElements, serializeAsJSON };
export type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
export default Excalidraw;

function parseScene(content: string): { elements?: unknown; files?: unknown } | null {
  try {
    const parsed = JSON.parse(content || "{}") as unknown;
    return parsed && typeof parsed === "object" ? parsed as { elements?: unknown; files?: unknown } : null;
  } catch {
    return null;
  }
}

/**
 * 把画板场景导出为只读 SVG 字符串（嵌入卡片预览用）。
 *
 * - `restoreElements` 修正绑定/尺寸，避免历史场景里的半成品元素画崩；
 * - `skipInliningFonts` 不把字体打进 SVG，页面里已随 chunk 加载 @font-face；
 * - 空画板返回 null，由调用方显示"空画板"占位。
 */
export async function renderBoardSceneToSvg(
  content: string,
  isDark: boolean,
): Promise<string | null> {
  const scene = parseScene(content);
  const rawElements = Array.isArray(scene?.elements) ? scene!.elements : [];
  if (rawElements.length === 0) return null;

  const restored = restoreElements(rawElements as never, null, { repairBindings: true });
  const visible = restored.filter((element) => !element.isDeleted);
  if (visible.length === 0) return null;

  const svg = await exportToSvg({
    elements: visible as never,
    appState: {
      exportBackground: true,
      viewBackgroundColor: isDark ? "#121212" : "#ffffff",
      exportWithDarkMode: isDark,
      exportPadding: 16,
    },
    files: (scene?.files && typeof scene.files === "object" ? scene.files : {}) as never,
    renderEmbeddables: false,
    skipInliningFonts: true,
  });
  return new XMLSerializer().serializeToString(svg);
}
