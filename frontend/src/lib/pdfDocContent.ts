/**
 * PDF 文档（contentFormat = "pdf"）内容模型 —— 与后端 lib/pdfAnnotations.ts 对齐。
 *
 * 正文结构：{ attachmentId, annotations: [...] }
 * 批注是页码锚定的标注层，不是 PDF 本体编辑：正文保存走通用笔记 PUT，
 * 同步 / 版本历史 / 全文检索（contentText 从批注文本派生）全部免费复用。
 *
 * 几何坐标一律**对页面归一化**（0–1，相对页面宽高），与缩放无关：
 * 放大、缩小、适应宽度都不需要重算标注。
 *
 * 向后兼容：老数据只有 { page, text, quote }，没有 kind/rects → 视为 note 类批注，
 * 渲染成页边数字角标而不是可视高亮。
 */

export type PdfAnnotationKind = "note" | "highlight" | "rect" | "arrow" | "ink";

/** 归一化矩形：x/y 为左上角，w/h 为宽高，全都在 0–1 区间。 */
export interface PdfNormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 归一化点（手绘折线、箭头端点）。 */
export interface PdfNormPoint {
  x: number;
  y: number;
}

export interface PdfAnnotation {
  id: string;
  /** 缺省视为 note（兼容老数据）。 */
  kind?: PdfAnnotationKind;
  /** 1 起始的页码锚点。 */
  page: number;
  /** 批注正文（纯文本；PDF 标注层不做富文本）。图形类标注可以为空。 */
  text: string;
  /** 锚定时的原文摘录。 */
  quote?: string;
  /** highlight 的覆盖区域（多行选中会有多块）。 */
  rects?: PdfNormRect[];
  /** ink 折线 / arrow 端点，按绘制顺序。 */
  points?: PdfNormPoint[];
  /** 线宽（归一化，相对页面宽度）；rect / arrow / ink 用。 */
  strokeWidth?: number;
  color?: PdfAnnotationColor;
  createdAt: string;
  updatedAt: string;
}

export interface PdfDocContent {
  attachmentId: string | null;
  annotations: PdfAnnotation[];
}

/**
 * 标注配色。PDF 页面恒为白底，这里用固定色而不是主题变量——
 * 深色界面下高亮也必须能在白纸上读清。
 */
export const PDF_ANNOTATION_COLORS = {
  amber: { stroke: "#BA7517", fill: "rgba(239, 159, 39, 0.34)", dot: "#EF9F27", label: "黄" },
  blue: { stroke: "#185FA5", fill: "rgba(55, 138, 221, 0.26)", dot: "#378ADD", label: "蓝" },
  green: { stroke: "#3B6D11", fill: "rgba(99, 153, 34, 0.26)", dot: "#639922", label: "绿" },
  red: { stroke: "#A32D2D", fill: "rgba(226, 75, 74, 0.26)", dot: "#E24B4A", label: "红" },
  purple: { stroke: "#534AB7", fill: "rgba(127, 119, 221, 0.28)", dot: "#7F77DD", label: "紫" },
} as const;

export type PdfAnnotationColor = keyof typeof PDF_ANNOTATION_COLORS;
export const PDF_ANNOTATION_COLOR_KEYS = Object.keys(PDF_ANNOTATION_COLORS) as PdfAnnotationColor[];

export function pdfColorSpec(color: PdfAnnotationColor | undefined) {
  return PDF_ANNOTATION_COLORS[color && color in PDF_ANNOTATION_COLORS ? color : "amber"];
}

const KINDS: PdfAnnotationKind[] = ["note", "highlight", "rect", "arrow", "ink"];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function parseRects(input: unknown): PdfNormRect[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const rects = input
    .filter((item): item is Record<string, number> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      x: clamp01(Number(item.x)),
      y: clamp01(Number(item.y)),
      w: clamp01(Number(item.w)),
      h: clamp01(Number(item.h)),
    }))
    .filter((rect) => rect.w > 0.0005 && rect.h > 0.0005);
  return rects.length ? rects : undefined;
}

function parsePoints(input: unknown): PdfNormPoint[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const points = input
    .filter((item): item is Record<string, number> => Boolean(item) && typeof item === "object")
    .map((item) => ({ x: clamp01(Number(item.x)), y: clamp01(Number(item.y)) }));
  return points.length >= 2 ? points : undefined;
}

/** 老数据没有 kind：有折线就是手绘，有矩形就是高亮，否则就是文字批注。 */
export function resolvePdfAnnotationKind(annotation: PdfAnnotation): PdfAnnotationKind {
  if (annotation.kind && KINDS.includes(annotation.kind)) return annotation.kind;
  if (annotation.points && annotation.points.length >= 2) return "ink";
  if (annotation.rects && annotation.rects.length) return "highlight";
  return "note";
}

export function parsePdfDocContent(content: string | null | undefined): PdfDocContent {
  try {
    const parsed = JSON.parse(content || "") as Partial<PdfDocContent> | null;
    if (!parsed || typeof parsed !== "object") return { attachmentId: null, annotations: [] };
    return {
      attachmentId: typeof parsed.attachmentId === "string" && parsed.attachmentId ? parsed.attachmentId : null,
      annotations: Array.isArray(parsed.annotations)
        ? parsed.annotations
            .filter((item) => item && typeof item === "object" && typeof item.id === "string")
            .map((item) => {
              const annotation: PdfAnnotation = {
                id: item.id,
                page: Math.max(1, Math.round(Number(item.page) || 1)),
                text: typeof item.text === "string" ? item.text : "",
                createdAt: typeof item.createdAt === "string" ? item.createdAt : nowPdfTimestamp(),
                updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowPdfTimestamp(),
              };
              if (typeof item.kind === "string" && KINDS.includes(item.kind as PdfAnnotationKind)) {
                annotation.kind = item.kind as PdfAnnotationKind;
              }
              if (typeof item.quote === "string" && item.quote) annotation.quote = item.quote;
              const rects = parseRects(item.rects);
              if (rects) annotation.rects = rects;
              const points = parsePoints(item.points);
              if (points) annotation.points = points;
              if (typeof item.strokeWidth === "number" && Number.isFinite(item.strokeWidth)) {
                annotation.strokeWidth = item.strokeWidth;
              }
              if (typeof item.color === "string" && item.color in PDF_ANNOTATION_COLORS) {
                annotation.color = item.color as PdfAnnotationColor;
              }
              return annotation;
            })
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

/**
 * 新建批注。
 *
 * 前三个参数保持老签名（page / text / quote），第 4 个参数承载几何与样式扩展，
 * 这样历史调用与单测不用改，图形类标注也能一次建出来。
 */
export function createPdfAnnotation(
  page: number,
  text: string,
  quote?: string,
  extra?: Partial<Pick<PdfAnnotation, "kind" | "rects" | "points" | "strokeWidth" | "color">>,
): PdfAnnotation {
  const timestamp = nowPdfTimestamp();
  return {
    id: crypto.randomUUID(),
    page: Math.max(1, Math.round(page)),
    text,
    ...(quote ? { quote } : {}),
    ...(extra?.kind ? { kind: extra.kind } : {}),
    ...(extra?.rects?.length ? { rects: extra.rects } : {}),
    ...(extra?.points?.length ? { points: extra.points } : {}),
    ...(typeof extra?.strokeWidth === "number" ? { strokeWidth: extra.strokeWidth } : {}),
    ...(extra?.color ? { color: extra.color } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** 批注在批注栏里的显示文本：图形类标注没有正文时给一句描述。 */
export function pdfAnnotationLabel(annotation: PdfAnnotation): string {
  if (annotation.quote) return annotation.quote;
  if (annotation.text) return annotation.text;
  switch (resolvePdfAnnotationKind(annotation)) {
    case "ink":
      return "手绘笔迹";
    case "rect":
      return "矩形标注";
    case "arrow":
      return "箭头标注";
    case "highlight":
      return "高亮";
    default:
      return "空白批注";
  }
}
