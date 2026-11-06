/**
 * PDF 单页渲染：canvas + 文本层 + 标注覆盖层。
 *
 * 三层的职责严格分开：
 *  - canvas：pdfjs 画出来的页面；
 *  - textLayer：透明文字，负责"能选中文字"（没有它就没法做文本高亮）；
 *  - SVG + 覆盖层：存下来的标注（归一化坐标）与正在画的草稿。
 *
 * 只有 select / highlight 工具让文字层接收指针，其余工具靠覆盖层接管，
 * 否则拖动矩形会顺手把文字选走。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

import { cn } from "@/lib/utils";
import {
  arrowHeadPoints,
  normPointToPixels,
  normPolylineDistance,
  normRectHitTest,
  normRectToPixels,
  pixelPointToNorm,
  selectionToNormRects,
} from "@/lib/pdfAnnotationGeometry";
import {
  createPdfAnnotation,
  pdfColorSpec,
  resolvePdfAnnotationKind,
  type PdfAnnotation,
  type PdfAnnotationColor,
  type PdfNormPoint,
  type PdfNormRect,
} from "@/lib/pdfDocContent";

export type PdfTool = "select" | "highlight" | "note" | "rect" | "arrow" | "ink" | "eraser";

export interface PdfPageSize {
  width: number;
  height: number;
}

interface DraftShape {
  kind: "rect" | "arrow" | "ink";
  from: PdfNormPoint;
  to: PdfNormPoint;
  points: PdfNormPoint[];
}

interface Props {
  document: PDFDocumentProxy;
  pageNumber: number;
  /** 1 = 100%（PDF 原始尺寸）。 */
  scale: number;
  tool: PdfTool;
  color: PdfAnnotationColor;
  /** 归一化线宽（相对页宽）。 */
  strokeWidth: number;
  annotations: PdfAnnotation[];
  activeAnnotationId: string | null;
  /** 上层待确认的选区（高亮预览）。 */
  selectionPreview?: PdfNormRect[] | null;
  /** 是否进入可视范围（懒渲染：不在视口内就只占位）。 */
  visible?: boolean;
  /** 页面首次量出尺寸时上报（未缩放尺寸），供滚动容器占位。 */
  onMeasure?: (pageNumber: number, size: PdfPageSize) => void;
  onCreate?: (annotation: PdfAnnotation) => void;
  onActivate?: (annotationId: string | null) => void;
  /** 文字选区变化：给上层弹气泡用。 */
  onSelection?: (payload: {
    page: number;
    rects: PdfNormRect[];
    quote: string;
    /** 选区的视口矩形（气泡定位用）。 */
    anchor: { top: number; left: number; width: number; height: number };
  } | null) => void;
  registerPage?: (pageNumber: number, element: HTMLDivElement | null) => void;
}

const HIT_TOLERANCE = 0.012;

export default function PdfPageView({
  document,
  pageNumber,
  scale,
  tool,
  color,
  strokeWidth,
  annotations,
  activeAnnotationId,
  selectionPreview,
  visible = true,
  onMeasure,
  onCreate,
  onActivate,
  onSelection,
  registerPage,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<PdfPageSize | null>(null);
  const [draft, setDraft] = useState<DraftShape | null>(null);
  const drawingRef = useRef<DraftShape | null>(null);

  const setPageRef = useCallback(
    (element: HTMLDivElement | null) => {
      rootRef.current = element;
      registerPage?.(pageNumber, element);
    },
    [pageNumber, registerPage],
  );

  // 渲染页面与文字层。scale 变化（缩放）会整页重画。
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: { render: () => Promise<void>; cancel?: () => void } | null = null;

    void (async () => {
      const page = await document.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      setSize({ width: viewport.width, height: viewport.height });
      onMeasure?.(pageNumber, { width: viewport.width / scale, height: viewport.height / scale });

      const canvas = canvasRef.current;
      if (!canvas) return;
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      });
      await renderTask.promise;
      if (cancelled) return;

      const container = textLayerRef.current;
      if (!container) return;
      container.replaceChildren();
      container.style.setProperty("--scale-factor", String(scale));
      const [pdfjs, textContent] = await Promise.all([
        import("pdfjs-dist/legacy/build/pdf.mjs"),
        page.getTextContent(),
      ]);
      if (cancelled) return;
      const layer = new pdfjs.TextLayer({ textContentSource: textContent, container, viewport });
      textLayer = layer as unknown as { render: () => Promise<void>; cancel?: () => void };
      await layer.render();
    })().catch((reason: unknown) => {
      const name = (reason as { name?: string } | null)?.name;
      if (name !== "RenderingCancelledException" && !cancelled) {
        console.error("[PdfPageView] render failed:", reason);
      }
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel?.();
    };
  }, [document, pageNumber, scale, visible, onMeasure]);

  // 选区上报（select / highlight 两种工具下都需要）
  useEffect(() => {
    if (tool !== "select" && tool !== "highlight") return;
    const handle = () => {
      const selection = window.getSelection();
      const rects = selectionToNormRects(selection, rootRef.current);
      if (!rects.length) {
        onSelection?.(null);
        return;
      }
      const quote = (selection?.toString() || "").replace(/\s+/g, " ").trim().slice(0, 240);
      const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      const box = range?.getBoundingClientRect();
      onSelection?.({
        page: pageNumber,
        rects,
        quote,
        anchor: box
          ? { top: box.top, left: box.left, width: box.width, height: box.height }
          : { top: 0, left: 0, width: 0, height: 0 },
      });
    };
    window.document.addEventListener("selectionchange", handle);
    return () => window.document.removeEventListener("selectionchange", handle);
  }, [tool, pageNumber, onSelection]);

  // 切换工具时清掉草稿与选区，避免残留
  useEffect(() => {
    setDraft(null);
    drawingRef.current = null;
  }, [tool]);

  const pageRectOf = () => rootRef.current?.getBoundingClientRect() || null;

  const hitTest = useCallback((point: PdfNormPoint): PdfAnnotation | null => {
    const aspect = size && size.height > 0 ? size.width / size.height : 0.7;
    // 从后往前：后画的在上层
    for (let index = annotations.length - 1; index >= 0; index--) {
      const annotation = annotations[index];
      const kind = resolvePdfAnnotationKind(annotation);
      const tolerance = Math.max(HIT_TOLERANCE, annotation.strokeWidth ?? 0) * 1.4;
      if (kind === "note") {
        // 便签钉是小圆点，命中范围放宽一点才点得到
        if (annotation.rects?.some((rect) => normRectHitTest(rect, point, 0.012))) return annotation;
        continue;
      }
      if (kind === "highlight" || kind === "rect") {
        if (annotation.rects?.some((rect) => normRectHitTest(rect, point, tolerance))) return annotation;
        continue;
      }
      if (annotation.points && annotation.points.length >= 2) {
        if (normPolylineDistance(annotation.points, point, aspect) <= tolerance) return annotation;
      }
    }
    return null;
  }, [annotations, size]);

  const startDraw = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tool === "select" || tool === "highlight") return;
    const pageRect = pageRectOf();
    if (!pageRect) return;
    const point = pixelPointToNorm(event, pageRect);

    if (tool === "eraser") {
      const hit = hitTest(point);
      if (hit) onActivate?.(hit.id);
      return;
    }
    if (tool === "note") {
      // 便签钉在点击位置：给一个极小的 rect 当锚点，页面上渲染成彩色小圆点
      const pin: PdfNormRect = { x: point.x - 0.008, y: point.y - 0.008, w: 0.016, h: 0.016 };
      onCreate?.(createPdfAnnotation(pageNumber, "", undefined, { kind: "note", rects: [pin], color }));
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const next: DraftShape = {
      kind: tool,
      from: point,
      to: point,
      points: tool === "ink" ? [point] : [],
    };
    drawingRef.current = next;
    setDraft(next);
  };

  const moveDraw = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drawingRef.current;
    if (!current) return;
    const pageRect = pageRectOf();
    if (!pageRect) return;
    const point = pixelPointToNorm(event, pageRect);
    const next: DraftShape = current.kind === "ink"
      ? { ...current, points: [...current.points, point], to: point }
      : { ...current, to: point };
    drawingRef.current = next;
    setDraft(next);
  };

  const endDraw = () => {
    const current = drawingRef.current;
    drawingRef.current = null;
    setDraft(null);
    if (!current) return;

    if (current.kind === "rect") {
      const rect: PdfNormRect = {
        x: Math.min(current.from.x, current.to.x),
        y: Math.min(current.from.y, current.to.y),
        w: Math.abs(current.to.x - current.from.x),
        h: Math.abs(current.to.y - current.from.y),
      };
      if (rect.w < 0.006 || rect.h < 0.006) return;
      onCreate?.(createPdfAnnotation(pageNumber, "", undefined, { kind: "rect", rects: [rect], color, strokeWidth }));
      return;
    }
    if (current.kind === "arrow") {
      const distance = Math.hypot(current.to.x - current.from.x, current.to.y - current.from.y);
      if (distance < 0.008) return;
      onCreate?.(createPdfAnnotation(pageNumber, "", undefined, {
        kind: "arrow",
        points: [current.from, current.to],
        color,
        strokeWidth,
      }));
      return;
    }
    if (current.kind === "ink") {
      if (current.points.length < 2) return;
      onCreate?.(createPdfAnnotation(pageNumber, "", undefined, {
        kind: "ink",
        points: current.points,
        color,
        strokeWidth,
      }));
    }
  };

  const pixelWidth = size?.width ?? 0;
  const pixelHeight = size?.height ?? 0;
  const interactive = tool !== "select" && tool !== "highlight";

  return (
    <div
      ref={setPageRef}
      data-pdf-page-number={pageNumber}
      className={cn(
        "relative shrink-0 overflow-hidden bg-white shadow-sm ring-1 ring-black/5",
        tool === "rect" || tool === "arrow" || tool === "ink" ? "cursor-crosshair" : "",
        tool === "eraser" ? "cursor-pointer" : "",
      )}
      style={{
        width: pixelWidth || undefined,
        height: pixelHeight || undefined,
        // 未量出尺寸前用 A4 比例占位，避免滚动条跳动
        ...(pixelWidth ? {} : { width: 595 * scale, height: 842 * scale }),
      }}
    >
      <canvas ref={canvasRef} className="block" />
      <div
        ref={textLayerRef}
        className={cn("pdf-text-layer", interactive && "pointer-events-none")}
      />

      <svg
        className="pointer-events-none absolute inset-0"
        width={pixelWidth || 1}
        height={pixelHeight || 1}
        aria-hidden
      >
        {[...annotations]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((annotation) => (
            <AnnotationShape
              key={annotation.id}
              annotation={annotation}
              size={{ width: pixelWidth, height: pixelHeight }}
              active={annotation.id === activeAnnotationId}
            />
          ))}
        {selectionPreview && tool === "select"
          ? selectionPreview.map((rect, index) => {
            const pixel = normRectToPixels(rect, { width: pixelWidth, height: pixelHeight });
            const spec = pdfColorSpec(color);
            return (
              <rect
                key={`selection-${index}`}
                x={pixel.x}
                y={pixel.y}
                width={pixel.width}
                height={pixel.height}
                fill={spec.fill}
                opacity={0.55}
              />
            );
          })
          : null}
        {draft ? <DraftShapeView draft={draft} size={{ width: pixelWidth, height: pixelHeight }} color={color} strokeWidth={strokeWidth} /> : null}
      </svg>

      {interactive ? (
        <div
          className="absolute inset-0"
          onPointerDown={startDraw}
          onPointerMove={moveDraw}
          onPointerUp={endDraw}
          onPointerCancel={endDraw}
        />
      ) : null}

      {annotations.some((annotation) => resolvePdfAnnotationKind(annotation) === "note" && !annotation.rects?.length)
        ? (
          <div className="absolute right-1 top-1 flex flex-col items-end gap-1">
            {annotations
              .filter((annotation) => resolvePdfAnnotationKind(annotation) === "note" && !annotation.rects?.length)
              .map((annotation, index) => (
                <button
                  key={annotation.id}
                  type="button"
                  title={annotation.quote || annotation.text || "批注"}
                  onClick={() => onActivate?.(annotation.id)}
                  className={cn(
                    "flex h-4 min-w-4 items-center justify-center rounded-[3px] border px-1 text-[9px] font-medium leading-none",
                    annotation.id === activeAnnotationId
                      ? "border-amber-500 bg-amber-100 text-amber-800"
                      : "border-amber-400/70 bg-amber-50 text-amber-700 hover:bg-amber-100",
                  )}
                >
                  {index + 1}
                </button>
              ))}
          </div>
        )
        : null}
    </div>
  );
}

function AnnotationShape({
  annotation,
  size,
  active,
}: {
  annotation: PdfAnnotation;
  size: PdfPageSize;
  active: boolean;
}) {
  const kind = resolvePdfAnnotationKind(annotation);
  const spec = pdfColorSpec(annotation.color);
  const rects = annotation.rects || [];
  const points = annotation.points || [];
  const strokePx = Math.max(1.2, (annotation.strokeWidth ?? 0.003) * size.width);

  if (kind === "highlight") {
    return (
      <>
        {rects.map((rect, index) => {
          const pixel = normRectToPixels(rect, size);
          return (
            <rect
              key={`${annotation.id}-${index}`}
              x={pixel.x}
              y={pixel.y}
              width={pixel.width}
              height={pixel.height}
              fill={spec.fill}
              stroke={active ? spec.stroke : "none"}
              strokeWidth={active ? 1 : 0}
              rx={1.5}
            />
          );
        })}
      </>
    );
  }

  if (kind === "rect" && rects[0]) {
    const pixel = normRectToPixels(rects[0], size);
    return (
      <rect
        x={pixel.x}
        y={pixel.y}
        width={pixel.width}
        height={pixel.height}
        fill="none"
        stroke={spec.stroke}
        strokeWidth={active ? strokePx + 0.8 : strokePx}
        rx={2}
      />
    );
  }

  if (kind === "arrow" && points.length >= 2) {
    const from = normPointToPixels(points[0], size);
    const to = normPointToPixels(points[points.length - 1], size);
    const head = arrowHeadPoints(points[0], points[points.length - 1], strokePx / size.width, size.width / (size.height || 1));
    const left = normPointToPixels(head.left, size);
    const right = normPointToPixels(head.right, size);
    return (
      <g stroke={spec.stroke} strokeWidth={active ? strokePx + 0.8 : strokePx} strokeLinecap="round" fill="none">
        <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
        <path d={`M${left.x} ${left.y} L${to.x} ${to.y} L${right.x} ${right.y}`} />
      </g>
    );
  }

  if (kind === "ink" && points.length >= 2) {
    const path = points
      .map((point, index) => {
        const pixel = normPointToPixels(point, size);
        return `${index === 0 ? "M" : "L"}${pixel.x.toFixed(1)} ${pixel.y.toFixed(1)}`;
      })
      .join(" ");
    return (
      <path
        d={path}
        fill="none"
        stroke={spec.stroke}
        strokeWidth={active ? strokePx + 0.8 : strokePx}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={active ? 1 : 0.92}
      />
    );
  }

  // note 类：钉在页面上的小圆点（有极小 rect），或老数据没有几何 → 靠右上角角标列出
  if (kind === "note" && rects[0]) {
    const rect = rects[0];
    const pixel = normRectToPixels(rect, size);
    const isPin = rect.w < 0.03 && rect.h < 0.03;
    if (isPin) {
      const cx = pixel.x + pixel.width / 2;
      const cy = pixel.y + pixel.height / 2;
      const radius = Math.max(5, size.width * 0.008);
      return (
        <g>
          <circle cx={cx} cy={cy} r={radius} fill={spec.dot} fillOpacity={active ? 1 : 0.85} stroke="#fff" strokeWidth={1.2} />
          <circle cx={cx} cy={cy} r={radius * 0.34} fill="#fff" fillOpacity={0.9} />
        </g>
      );
    }
    return (
      <rect
        x={pixel.x}
        y={pixel.y}
        width={pixel.width}
        height={pixel.height}
        fill={spec.fill}
        stroke={active ? spec.stroke : "none"}
        strokeWidth={active ? 1 : 0}
        opacity={0.55}
        rx={2}
      />
    );
  }
  return null;
}

function DraftShapeView({
  draft,
  size,
  color,
  strokeWidth,
}: {
  draft: DraftShape;
  size: PdfPageSize;
  color: PdfAnnotationColor;
  strokeWidth: number;
}) {
  const spec = pdfColorSpec(color);
  const strokePx = Math.max(1.2, strokeWidth * size.width);

  if (draft.kind === "rect") {
    const left = Math.min(draft.from.x, draft.to.x) * size.width;
    const top = Math.min(draft.from.y, draft.to.y) * size.height;
    const width = Math.abs(draft.to.x - draft.from.x) * size.width;
    const height = Math.abs(draft.to.y - draft.from.y) * size.height;
    return <rect x={left} y={top} width={width} height={height} fill="none" stroke={spec.stroke} strokeWidth={strokePx} rx={2} strokeDasharray="4 3" />;
  }
  if (draft.kind === "arrow") {
    const from = normPointToPixels(draft.from, size);
    const to = normPointToPixels(draft.to, size);
    return <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={spec.stroke} strokeWidth={strokePx} strokeLinecap="round" strokeDasharray="4 3" />;
  }
  const path = draft.points
    .map((point, index) => {
      const pixel = normPointToPixels(point, size);
      return `${index === 0 ? "M" : "L"}${pixel.x.toFixed(1)} ${pixel.y.toFixed(1)}`;
    })
    .join(" ");
  return <path d={path} fill="none" stroke={spec.stroke} strokeWidth={strokePx} strokeLinecap="round" strokeLinejoin="round" />;
}
