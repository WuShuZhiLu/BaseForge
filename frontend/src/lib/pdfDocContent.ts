/**
 * PDF 文档（contentFormat = "pdf"）内容模型 —— 与后端 lib/pdfAnnotations.ts 对齐。
 *
 * 正文结构：{ attachmentId, annotations: [{ id, page, text, quote?, createdAt, updatedAt }] }
 * 批注是页码锚定的笔记层；正文保存走通用笔记 PUT（同步/版本历史免费复用）。
 */

export interface PdfAnnotation {
  id: string;
  /** 1 起始的页码锚点。 */
  page: number;
  text: string;
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
      annotations: Array.isArray(parsed.annotations)
        ? parsed.annotations.filter((item) => item && typeof item === "object" && typeof item.id === "string")
        : [],
    };
  } catch {
    return { attachmentId: null, annotations: [] };
  }
}

export function serializePdfDocContent(doc: PdfDocContent): string {
  return JSON.stringify({ attachmentId: doc.attachmentId, annotations: doc.annotations });
}

/** 批注文本派生 contentText（与后端 pdfAnnotationsPlainText 同规则，供完整性校验）。 */
export function pdfDocContentText(doc: PdfDocContent): string {
  const parts: string[] = [];
  for (const annotation of doc.annotations) {
    if (annotation.quote) parts.push(annotation.quote);
    if (annotation.text) parts.push(annotation.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function nowPdfTimestamp(): string {
  const value = new Date();
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

export function createPdfAnnotation(page: number, text: string, quote?: string): PdfAnnotation {
  const timestamp = nowPdfTimestamp();
  return {
    id: crypto.randomUUID(),
    page: Math.max(1, Math.round(page)),
    text,
    ...(quote ? { quote } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
