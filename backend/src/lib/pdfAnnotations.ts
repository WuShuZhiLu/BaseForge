/**
 * PDF 文档（contentFormat = "pdf"）正文 JSON 的纯函数工具。
 *
 * 正文结构：{ attachmentId: string | null, annotations: PdfAnnotation[] }
 * 批注是页码锚定的笔记层（不做 PDF 本体编辑）；contentText 从批注文本派生，
 * 让全文搜索能命中批注内容。
 */

export interface PdfAnnotation {
  id: string;
  /** 1 起始的页码锚点。 */
  page: number;
  /** 批注正文（纯文本；PDF 笔记层不做富文本）。 */
  text: string;
  /** 可选：锚定时的原文摘录，用于对照。 */
  quote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PdfDocContent {
  attachmentId: string | null;
  annotations: PdfAnnotation[];
}

export function parsePdfDocContent(content: string | null | undefined): PdfDocContent {
  try {
    const parsed = JSON.parse(content || "") as Partial<PdfDocContent> | null;
    if (!parsed || typeof parsed !== "object") return { attachmentId: null, annotations: [] };
    return {
      attachmentId: typeof parsed.attachmentId === "string" && parsed.attachmentId ? parsed.attachmentId : null,
      annotations: Array.isArray(parsed.annotations) ? parsed.annotations : [],
    };
  } catch {
    return { attachmentId: null, annotations: [] };
  }
}

/** 批注文本合并为可检索的一行文本（contentText / 派生搜索文本用）。 */
export function pdfAnnotationsPlainText(content: string | null | undefined): string {
  const { annotations } = parsePdfDocContent(content);
  const parts: string[] = [];
  for (const annotation of annotations) {
    if (annotation.quote) parts.push(annotation.quote);
    if (annotation.text) parts.push(annotation.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
