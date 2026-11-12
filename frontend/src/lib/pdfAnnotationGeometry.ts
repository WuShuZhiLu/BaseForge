/**
 * PDF 标注几何换算。
 *
 * 浏览器给的选区是**视口像素**（ClientRect），标注要存的是**归一化页面坐标**，
 * 否则换个缩放比例、换个窗口宽度，高亮就全错位。
 * 这里只做纯换算，不碰 DOM 结构，方便单测。
 */
import type { PdfNormPoint, PdfNormRect } from "./pdfDocContent";

export interface PixelSize {
  width: number;
  height: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** 视口像素矩形 → 归一化矩形（按页面容器尺寸）。 */
export function pixelRectToNorm(
  rect: { left: number; top: number; width: number; height: number },
  pageRect: { left: number; top: number; width: number; height: number },
): PdfNormRect | null {
  if (pageRect.width <= 0 || pageRect.height <= 0) return null;
  const left = Math.max(rect.left, pageRect.left);
  const top = Math.max(rect.top, pageRect.top);
  const right = Math.min(rect.left + rect.width, pageRect.left + pageRect.width);
  const bottom = Math.min(rect.top + rect.height, pageRect.top + pageRect.height);
  if (right - left < 0.5 || bottom - top < 0.5) return null;
  return {
    x: round4(clamp01((left - pageRect.left) / pageRect.width)),
    y: round4(clamp01((top - pageRect.top) / pageRect.height)),
    w: round4(clamp01((right - left) / pageRect.width)),
    h: round4(clamp01((bottom - top) / pageRect.height)),
  };
}

/** 视口坐标点 → 归一化点。 */
export function pixelPointToNorm(
  point: { clientX: number; clientY: number },
  pageRect: { left: number; top: number; width: number; height: number },
): PdfNormPoint {
  if (pageRect.width <= 0 || pageRect.height <= 0) return { x: 0, y: 0 };
  return {
    x: round4(clamp01((point.clientX - pageRect.left) / pageRect.width)),
    y: round4(clamp01((point.clientY - pageRect.top) / pageRect.height)),
  };
}

/** 归一化矩形 → 页面内像素矩形（用于 SVG 覆盖层）。 */
export function normRectToPixels(rect: PdfNormRect, size: PixelSize) {
  return {
    x: rect.x * size.width,
    y: rect.y * size.height,
    width: rect.w * size.width,
    height: rect.h * size.height,
  };
}

export function normPointToPixels(point: PdfNormPoint, size: PixelSize) {
  return { x: point.x * size.width, y: point.y * size.height };
}

/**
 * 把浏览器选区落成若干归一化矩形。
 *
 * 只取落在 `pageEl` 内的部分——跨页拖选时另一页的内容会被裁掉，
 * 不会在错误的页面画出高亮。
 */
export function selectionToNormRects(
  selection: Selection | null,
  pageEl: HTMLElement | null,
): PdfNormRect[] {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !pageEl) return [];
  const pageRect = pageEl.getBoundingClientRect();
  if (pageRect.width <= 0 || pageRect.height <= 0) return [];

  const range = selection.getRangeAt(0);
  const rects: PdfNormRect[] = [];
  for (const clientRect of Array.from(range.getClientRects())) {
    const rect = pixelRectToNorm(clientRect, pageRect);
    if (rect) rects.push(rect);
  }
  return mergeSiblingRects(rects);
}

/** 同一行被拆成多段的矩形合并成一条，避免高亮出现竖向缝隙。 */
export function mergeSiblingRects(rects: PdfNormRect[]): PdfNormRect[] {
  if (rects.length <= 1) return rects;
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const merged: PdfNormRect[] = [];
  for (const rect of sorted) {
    const last = merged[merged.length - 1];
    // 同一行：纵向中心几乎重合、横向紧邻
    const sameLine = last
      && Math.abs(last.y - rect.y) < Math.max(last.h, rect.h) * 0.5
      && rect.x <= last.x + last.w + 0.01;
    if (sameLine) {
      const right = Math.max(last.x + last.w, rect.x + rect.w);
      const bottom = Math.max(last.y + last.h, rect.y + rect.h);
      last.x = Math.min(last.x, rect.x);
      last.y = Math.min(last.y, rect.y);
      last.w = round4(right - last.x);
      last.h = round4(bottom - last.y);
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
}

/** 选区文字：折叠空白、超长截断（quote 只用于对照，不存全文）。 */
export function selectionToQuote(selection: Selection | null, maxLength = 240): string {
  const text = (selection?.toString() || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** 归一化矩形是否点中（橡皮 / 选中标注用）。 */
export function normRectHitTest(rect: PdfNormRect, point: PdfNormPoint, tolerance = 0.004): boolean {
  return point.x >= rect.x - tolerance
    && point.x <= rect.x + rect.w + tolerance
    && point.y >= rect.y - tolerance
    && point.y <= rect.y + rect.h + tolerance;
}

/** 点到折线的最短距离（归一化空间，按页面比例修正），用于点选手绘笔迹。 */
export function normPolylineDistance(points: PdfNormPoint[], point: PdfNormPoint, aspect: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    // 把 x 乘上页面宽高比，避免横向被拉长后距离失真
    const ax = a.x * aspect;
    const bx = b.x * aspect;
    const px = point.x * aspect;
    const dx = bx - ax;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (point.y - a.y) * dy) / lengthSq));
    const cx = ax + t * dx;
    const cy = a.y + t * dy;
    best = Math.min(best, Math.hypot(px - cx, point.y - cy));
  }
  return best;
}

/** 箭头端点几何：给起点终点算出箭头两翼坐标（归一化）。 */
export function arrowHeadPoints(
  from: PdfNormPoint,
  to: PdfNormPoint,
  size: number,
  aspect: number,
): { left: PdfNormPoint; right: PdfNormPoint } {
  const dx = (to.x - from.x) * aspect;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const headLength = Math.max(size * 3.2, 0.008);
  const spread = 0.45;
  const backX = to.x - (ux * Math.cos(spread) - uy * Math.sin(spread)) * headLength / aspect;
  const backY = to.y - (uy * Math.cos(spread) + ux * Math.sin(spread)) * headLength;
  const backX2 = to.x - (ux * Math.cos(spread) + uy * Math.sin(spread)) * headLength / aspect;
  const backY2 = to.y - (uy * Math.cos(spread) - ux * Math.sin(spread)) * headLength;
  return { left: { x: backX, y: backY }, right: { x: backX2, y: backY2 } };
}
