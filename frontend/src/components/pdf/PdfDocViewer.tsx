/**
 * PDF 连续滚动视图。
 *
 * 与附件预览的区别：这里的 PDF 是"正在读的文档"，不是"瞄一眼的附件"——
 * 所以支持连续滚动、缩放、任意跳页、文本选择与标注。附件预览保持轻量，两者不共用。
 *
 * 渲染策略：
 *  - 每页先用 scale=1 的尺寸乘缩放算出占位高度，滚动条长度稳定，不会边滚边跳；
 *  - 只有进入视口（含 600px 预取）的页才真正跑 pdfjs 渲染，几百页的文档也不卡；
 *  - 当前页由滚动位置反推，跳页用 DOM 位移，不重新排版。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { AlertCircle, Loader2 } from "lucide-react";

import PdfPageView, { type PdfPageSize, type PdfTool } from "./PdfPageView";
import { pdfjsAssetUrl } from "@/lib/pdfjsAssets";
import type { PdfAnnotation, PdfAnnotationColor, PdfNormRect } from "@/lib/pdfDocContent";

export interface PdfSelectionPayload {
  page: number;
  rects: PdfNormRect[];
  quote: string;
  anchor: { top: number; left: number; width: number; height: number };
}

export interface PdfDocViewerHandle {
  gotoPage: (page: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitWidth: () => void;
  fitPage: () => void;
}

interface Props {
  url: string;
  tool: PdfTool;
  color: PdfAnnotationColor;
  strokeWidth: number;
  annotations: PdfAnnotation[];
  activeAnnotationId: string | null;
  selectionPreview?: PdfNormRect[] | null;
  onCreate?: (annotation: PdfAnnotation) => void;
  onActivate?: (annotationId: string | null) => void;
  onSelection?: (payload: PdfSelectionPayload | null) => void;
  onScaleChange?: (scale: number) => void;
  onPageChange?: (page: number) => void;
  onDocumentReady?: (info: { numPages: number }) => void;
}

/** 给 url 加 inline=1，让后端走 inline 渲染而不是 attachment 下载（与附件预览一致）。 */
function toInlineUrl(url: string): string {
  if (!url) return url;
  if (/[?&]inline=1\b/.test(url)) return url;
  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  return base + (base.includes("?") ? "&" : "?") + "inline=1" + hash;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const ZOOM_STEP = 1.15;

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

const PdfDocViewer = forwardRef<PdfDocViewerHandle, Props>(function PdfDocViewer({
  url,
  tool,
  color,
  strokeWidth,
  annotations,
  activeAnnotationId,
  selectionPreview,
  onCreate,
  onActivate,
  onSelection,
  onScaleChange,
  onPageChange,
  onDocumentReady,
}, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageElementsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [sizes, setSizes] = useState<Record<number, PdfPageSize>>({});
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(1);
  const [visiblePages, setVisiblePages] = useState<number[]>([1]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const pageRef = useRef(page);
  pageRef.current = page;
  // 回调放进 ref：父组件每次渲染都会换函数身份，直接进 effect 依赖会让 PDF 反复重载
  const callbacksRef = useRef({ onDocumentReady, onPageChange, onScaleChange });
  callbacksRef.current = { onDocumentReady, onPageChange, onScaleChange };

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let loaded: PDFDocumentProxy | null = null;

    setLoading(true);
    setError("");
    setDoc(null);
    setNumPages(0);
    setSizes({});
    setVisiblePages([1]);
    setPage(1);

    void (async () => {
      try {
        const response = await fetch(toInlineUrl(url));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const [pdfjs, workerModule] = await Promise.all([
          import("pdfjs-dist/legacy/build/pdf.mjs"),
          import("pdfjs-dist/legacy/build/pdf.worker.mjs?url"),
        ]);
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
          pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
        }
        const task = pdfjs.getDocument({
          data: new Uint8Array(await response.arrayBuffer()),
          isEvalSupported: false,
          useSystemFonts: true,
          // CJK 字符映射与非内嵌标准字体：缺失会导致中文丢字、部分页渲染失败空白
          cMapUrl: pdfjsAssetUrl("cmaps"),
          cMapPacked: true,
          standardFontDataUrl: pdfjsAssetUrl("standard_fonts"),
        });
        loadingTask = task;
        const next = await task.promise;
        loaded = next;
        if (cancelled) {
          await next.destroy();
          return;
        }
        setDoc(next);
        setNumPages(next.numPages);
        callbacksRef.current.onDocumentReady?.({ numPages: next.numPages });

        // 先把每页在 100% 下的尺寸拿全：占位高度稳定，跳页也不用等渲染
        const measured: Record<number, PdfPageSize> = {};
        for (let index = 1; index <= next.numPages; index++) {
          if (cancelled) return;
          const pdfPage = await next.getPage(index);
          const viewport = pdfPage.getViewport({ scale: 1 });
          measured[index] = { width: viewport.width, height: viewport.height };
        }
        if (!cancelled) setSizes(measured);
      } catch (reason) {
        if (loadingTask && !loaded) {
          const failed = loadingTask;
          loadingTask = null;
          void failed.destroy().catch(() => {});
        }
        if (!cancelled) {
          console.error("[PdfDocViewer] load failed:", reason);
          setError("PDF 加载失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (loaded) {
        if (!loadingTask) void loaded.destroy().catch(() => {});
      } else if (loadingTask) {
        void loadingTask.destroy().catch(() => {});
      }
      setDoc(null);
    };
  }, [url]);

  const applyScale = useCallback((next: number) => {
    const clamped = clampScale(next);
    setScale(clamped);
    callbacksRef.current.onScaleChange?.(clamped);
  }, []);

  const fitWidth = useCallback(() => {
    const container = scrollRef.current;
    const first = sizes[1];
    if (!container || !first) return;
    const available = container.clientWidth - 40;
    applyScale(available / first.width);
  }, [sizes, applyScale]);

  const fitPage = useCallback(() => {
    const container = scrollRef.current;
    const first = sizes[1];
    if (!container || !first) return;
    const availableWidth = container.clientWidth - 40;
    const availableHeight = container.clientHeight - 40;
    applyScale(Math.min(availableWidth / first.width, availableHeight / first.height));
  }, [sizes, applyScale]);

  // Ctrl/Cmd + 滚轮缩放 PDF 页面本身；preventDefault 拦掉浏览器整页缩放。
  // passive 必须显式为 false，否则 wheel 监听里不允许 preventDefault。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      applyScale(scaleRef.current * factor);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
    // loading 期间 scroll 容器还没挂载，结束后再绑定
  }, [applyScale, loading]);

  const gotoPage = useCallback((target: number) => {
    const clamped = Math.min(numPages || 1, Math.max(1, Math.round(target)));
    const element = pageElementsRef.current.get(clamped);
    const container = scrollRef.current;
    if (element && container) {
      const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTo({ top: container.scrollTop + delta - 12, behavior: "smooth" });
    }
    setPage(clamped);
    callbacksRef.current.onPageChange?.(clamped);
  }, [numPages]);

  useImperativeHandle(ref, () => ({
    gotoPage,
    zoomIn: () => applyScale(scaleRef.current * ZOOM_STEP),
    zoomOut: () => applyScale(scaleRef.current / ZOOM_STEP),
    fitWidth,
    fitPage,
  }), [gotoPage, applyScale, fitWidth, fitPage]);

  const registerPage = useCallback((pageNumber: number, element: HTMLDivElement | null) => {
    if (element) pageElementsRef.current.set(pageNumber, element);
    else pageElementsRef.current.delete(pageNumber);
  }, []);

  const handleMeasure = useCallback((pageNumber: number, size: PdfPageSize) => {
    setSizes((previous) => {
      const current = previous[pageNumber];
      if (current && Math.abs(current.width - size.width) < 0.5 && Math.abs(current.height - size.height) < 0.5) {
        return previous;
      }
      return { ...previous, [pageNumber]: size };
    });
  }, []);

  // 懒渲染：进入视口（含预取）才挂真渲染。
  // 注意必须等 loading 结束（wrapper 挂载后）再观察：numPages 变化时 UI 还在
  // loading 占位，pageElementsRef 为空，此时观察 0 个元素会导致后页永远不渲染。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !numPages || loading) return;
    const targets = Array.from(pageElementsRef.current.values());
    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const pageNumber = Number((entry.target as HTMLElement).dataset.pageWrapper);
            if (!pageNumber) continue;
            if (entry.isIntersecting) next.add(pageNumber);
            else if (next.size > 1) next.delete(pageNumber);
          }
          return Array.from(next).sort((a, b) => a - b);
        });
      },
      { root: container, rootMargin: "600px 0px" },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [numPages, loading]);

  // 当前页跟随滚动
  useEffect(() => {
    const container = scrollRef.current;
    // 同懒渲染：loading 期间 scroll 容器还没挂载，等它结束再绑定
    if (!container || !numPages || loading) return;
    let frame = 0;
    const handle = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const anchor = container.getBoundingClientRect().top + container.clientHeight * 0.3;
        let current = 1;
        for (const [pageNumber, element] of pageElementsRef.current) {
          if (element.getBoundingClientRect().top <= anchor) current = Math.max(current, pageNumber);
        }
        if (current !== pageRef.current) {
          pageRef.current = current;
          setPage(current);
          callbacksRef.current.onPageChange?.(current);
        }
      });
    };
    container.addEventListener("scroll", handle, { passive: true });
    return () => {
      container.removeEventListener("scroll", handle);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [numPages, loading]);

  const annotationsByPage = useMemo(() => {
    const map = new Map<number, PdfAnnotation[]>();
    for (const annotation of annotations) {
      const list = map.get(annotation.page);
      if (list) list.push(annotation);
      else map.set(annotation.page, [annotation]);
    }
    return map;
  }, [annotations]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-tx-tertiary">
        <Loader2 size={16} className="mr-2 animate-spin" />
        正在加载 PDF…
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-tx-tertiary">
        <AlertCircle size={20} />
        <span className="text-xs">{error || "PDF 预览不可用"}</span>
      </div>
    );
  }

  const pages = Array.from({ length: numPages }, (_, index) => index + 1);

  return (
    <div ref={scrollRef} className="h-full overflow-auto bg-app-bg" data-pdf-scroll="">
      <div className="flex flex-col items-center gap-3 px-4 py-4">
        {pages.map((pageNumber) => {
          const base = sizes[pageNumber];
          return (
            <div
              key={pageNumber}
              ref={(element) => registerPage(pageNumber, element)}
              data-page-wrapper={pageNumber}
              style={base ? { width: base.width * scale } : undefined}
              className="relative"
            >
              <PdfPageView
                document={doc}
                pageNumber={pageNumber}
                scale={scale}
                tool={tool}
                color={color}
                strokeWidth={strokeWidth}
                annotations={annotationsByPage.get(pageNumber) || []}
                activeAnnotationId={activeAnnotationId}
                selectionPreview={selectionPreview}
                visible={visiblePages.includes(pageNumber)}
                onMeasure={handleMeasure}
                onCreate={onCreate}
                onActivate={onActivate}
                onSelection={onSelection}
              />
              <div className="pointer-events-none absolute -left-8 top-1 hidden text-[10px] tabular-nums text-tx-tertiary lg:block">
                {pageNumber}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default PdfDocViewer;
