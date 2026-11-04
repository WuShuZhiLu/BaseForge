import JSZip from "jszip";
import { saveAs } from "file-saver";
import {
  buildPrintableHtml,
  exportNotebook,
  loadNotebookExportNotes,
  renderPrintableHtmlToPdfBlob,
  sanitizeFilename,
  type ExportNote,
  type ExportProgress,
  type NotebookExportScope,
} from "@/lib/exportServiceCore";
import { renderNoteImageFiles } from "@/lib/noteImageExportCore";
import { normalizeNoteImageExportSource } from "@/lib/noteImageExportBridge";
import { exportNoteAsDocx } from "@/lib/wordNoteService";

/**
 * 目录级导出格式：与单篇文档导出的六个选项一一对应。
 * - markdown：每篇一个自包含 .md（图片内嵌）
 * - markdown_zip：md + assets 分开放（可再导入的知识包）
 * - pdf / png / jpg / word：逐篇渲染后打进同一个 zip
 */
export type NotebookExportFormat = "markdown" | "markdown_zip" | "pdf" | "png" | "jpg" | "word";

export const NOTEBOOK_EXPORT_FORMAT_ITEMS: Array<{ id: NotebookExportFormat; label: string }> = [
  { id: "markdown", label: "Markdown" },
  { id: "markdown_zip", label: "Markdown + 附件 ZIP" },
  { id: "pdf", label: "PDF" },
  { id: "png", label: "PNG" },
  { id: "jpg", label: "JPG" },
  { id: "word", label: "Word" },
];

interface RenderedExportFile {
  blob: Blob;
  name: string;
}

/** 同目录重名（"未命名笔记" 之类）时补序号，避免 zip 里互相覆盖。 */
function uniquePath(used: Set<string>, folder: string, fileName: string): string {
  const direct = `${folder}/${fileName}`;
  if (!used.has(direct)) {
    used.add(direct);
    return direct;
  }
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  let index = 2;
  while (used.has(`${folder}/${base}_${index}${ext}`)) index += 1;
  const path = `${folder}/${base}_${index}${ext}`;
  used.add(path);
  return path;
}

/** 把一篇文档渲染成目标格式的文件（PDF/Word 各一份，PNG/JPG 可能因分页多份）。 */
async function renderNoteFiles(note: ExportNote, format: NotebookExportFormat): Promise<RenderedExportFile[]> {
  const baseName = sanitizeFilename(note.title);

  if (format === "pdf") {
    const html = await buildPrintableHtml({
      title: note.title,
      content: note.content,
      contentText: note.contentText,
      contentFormat: note.contentFormat,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    });
    return [{ blob: await renderPrintableHtmlToPdfBlob(html), name: `${baseName}.pdf` }];
  }

  if (format === "word") {
    const blob = await exportNoteAsDocx(note.content || "", note.title || "未命名笔记");
    return [{ blob, name: `${baseName}.docx` }];
  }

  // PNG / JPG：复用单篇图片渲染（只渲染不落盘），否则每篇都会弹一次保存对话框。
  const rendered = await renderNoteImageFiles(
    normalizeNoteImageExportSource({
      id: note.id,
      title: note.title,
      content: note.content,
      contentText: note.contentText,
      contentFormat: note.contentFormat,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    }),
    { format: format === "jpg" ? "jpg" : "png" },
  );
  return rendered.files.map((file) => ({ blob: file.blob, name: file.fileName }));
}

/**
 * 按指定格式导出整个目录（含子目录）。
 * 产物统一是一个 zip：内部按子目录分文件夹，保留原有层级。
 * 单篇失败不阻断整体（加密、资源全挂、单页超限等），最后汇总进 export-failures.json。
 */
export async function exportNotebookAsFormat(
  scope: NotebookExportScope,
  format: NotebookExportFormat,
  onProgress?: (p: ExportProgress) => void,
): Promise<boolean> {
  if (format === "markdown" || format === "markdown_zip") {
    return exportNotebook(scope, onProgress, { inlineImages: format === "markdown" });
  }

  try {
    onProgress?.({ phase: "fetching", current: 0, total: 0, message: "正在读取目录下的文档…" });
    const notes = await loadNotebookExportNotes(scope);
    if (notes.length === 0) {
      onProgress?.({ phase: "error", current: 0, total: 0, message: "该目录下没有可导出的文档" });
      return false;
    }

    const zip = new JSZip();
    const usedPaths = new Set<string>();
    const failures: Array<{ title: string; reason: string }> = [];

    for (let index = 0; index < notes.length; index += 1) {
      const note = notes[index];
      const folder = sanitizeFilename(note.notebookName || scope.notebookName);
      onProgress?.({
        phase: "converting",
        current: index + 1,
        total: notes.length,
        message: `正在转换「${note.title}」（${index + 1}/${notes.length}）`,
      });
      try {
        for (const file of await renderNoteFiles(note, format)) {
          zip.file(uniquePath(usedPaths, folder, file.name), file.blob);
        }
      } catch (error) {
        failures.push({
          title: note.title,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (usedPaths.size === 0) {
      onProgress?.({
        phase: "error",
        current: failures.length,
        total: notes.length,
        message: `${failures.length} 篇文档全部导出失败：${failures[0]?.reason || "未知原因"}`,
      });
      return false;
    }

    if (failures.length > 0) {
      zip.file(
        "export-failures.json",
        JSON.stringify({
          version: "1.0",
          app: "nowen-note",
          scope: "notebook",
          format,
          rootNotebookId: scope.notebookId,
          rootNotebookName: scope.notebookName,
          generatedAt: new Date().toISOString(),
          failed: failures,
          hint: "这些文档没有进入压缩包：可能是内容无法转换为该格式、图片资源全部加载失败，或单页超出图片尺寸上限。",
        }, null, 2),
      );
    }

    onProgress?.({
      phase: "packing",
      current: notes.length,
      total: notes.length,
      message: "正在打包…",
    });
    const blob = await zip.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
      (meta) => {
        onProgress?.({
          phase: "packing",
          current: Math.round(meta.percent),
          total: 100,
          message: `正在压缩 ${Math.round(meta.percent)}%`,
        });
      },
    );

    const date = new Date().toISOString().slice(0, 10);
    saveAs(blob, `${sanitizeFilename(scope.notebookName)}_${format}_${date}.zip`);

    if (failures.length > 0) {
      onProgress?.({
        phase: "error",
        current: failures.length,
        total: notes.length,
        message: `${failures.length} 篇文档导出失败，详见 export-failures.json`,
      });
    } else {
      onProgress?.({ phase: "done", current: notes.length, total: notes.length, message: "导出完成" });
    }
    return true;
  } catch (error) {
    console.error("导出目录失败:", error);
    onProgress?.({
      phase: "error",
      current: 0,
      total: 0,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
