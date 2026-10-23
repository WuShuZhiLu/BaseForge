/**
 * Excalidraw 画布（重模块，仅由 BoardEditor 懒加载）
 *
 * 单独成文件的目的：把 @excalidraw/excalidraw 及其 CSS、字体资源打到
 * 独立的 chunk 里，普通笔记不打开画板就不会下载这块代码。
 */
import "@excalidraw/excalidraw/index.css";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";

export { Excalidraw, serializeAsJSON };
export type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
export default Excalidraw;
