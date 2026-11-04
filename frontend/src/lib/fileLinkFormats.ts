/**
 * 公开链接格式化工具（原 imageHostFormats.ts）
 * ---------------------------------------------------------------------------
 * 把附件 URL 和文件名格式化为不同生态常用的引用片段。
 * 统一文件池下所有文件类型都能拿到公开直链，因此片段形态按 MIME 自动选择：
 *   图片 → Markdown `![]()` / HTML `<img>`（可以直接内联渲染）
 *   视频 → HTML `<video controls>`（Markdown 无标准视频语法，退回普通链接）
 *   音频 → HTML `<audio controls>`（同上）
 *   其他 → Markdown `[]()` / HTML `<a href>`
 * 纯函数，便于在 FileManager / DetailDrawer / 编辑器右键菜单 等多处复用。
 *
 * 设计要点：
 *   - filename 里可能包含 `] [ ( ) " ' & < >` 等特殊字符，必须做最小转义，
 *     否则贴进 Markdown / HTML 会破坏语法或引发 XSS（虽然只是自己引用自己的内容，
 *     但 HTML 走外部网站时仍可能触发渲染异常）。
 *   - URL 里不应再做 encode：调用方传进来的就是浏览器真实可访问的完整 URL。
 *   - 不做 i18n：这些是开发者面向的代码片段。
 */

export type FileLinkFormat = "url" | "markdown" | "html";

/** 片段形态：由 MIME 前缀决定，与后端 mime-category 的类型划分保持同一口径。 */
export type FileLinkKind = "image" | "video" | "audio" | "other";

/** Markdown alt 文本里 `[ ]` 会破坏语法，做最小替换。 */
function escapeMdAlt(s: string): string {
  return s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** HTML 属性里需要转义 `& " < >`。 */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 由 MIME 推断片段形态（空 MIME 按普通文件处理）。 */
export function resolveFileLinkKind(mimeType: string | null | undefined): FileLinkKind {
  const mime = (mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "other";
}

/** 把附件信息格式化为指定类型的代码片段。 */
export function formatFileLinkSnippet(
  format: FileLinkFormat,
  url: string,
  filename: string,
  mimeType?: string | null,
): string {
  const safeFilename = (filename || "file").trim() || "file";
  const kind = resolveFileLinkKind(mimeType);
  switch (format) {
    case "url":
      return url;
    case "markdown":
      // Markdown 没有通用的视频/音频内联语法：图片用 ![]()，其余用普通链接。
      return kind === "image"
        ? `![${escapeMdAlt(safeFilename)}](${url})`
        : `[${escapeMdAlt(safeFilename)}](${url})`;
    case "html":
      if (kind === "image") {
        return `<img src="${escapeHtmlAttr(url)}" alt="${escapeHtmlAttr(safeFilename)}" />`;
      }
      if (kind === "video") {
        return `<video src="${escapeHtmlAttr(url)}" controls></video>`;
      }
      if (kind === "audio") {
        return `<audio src="${escapeHtmlAttr(url)}" controls></audio>`;
      }
      return `<a href="${escapeHtmlAttr(url)}">${escapeHtmlAttr(safeFilename)}</a>`;
    default:
      return url;
  }
}

/** 给 UI 提示用的简短标签。 */
export function fileLinkFormatLabel(f: FileLinkFormat): string {
  return f === "url" ? "URL" : f === "markdown" ? "Markdown" : "HTML";
}
