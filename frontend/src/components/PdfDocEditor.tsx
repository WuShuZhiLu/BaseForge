/**
 * PdfDocEditor —— PDF 文档编辑器（contentFormat = "pdf"）
 *
 * 正文 = 原件引用 + 标注层 JSON：{ attachmentId, annotations: [...] }
 * 阅读区是连续滚动的 PdfDocViewer（缩放 / 跳页 / 文本选择 / 手绘），
 * 工具栏与富文本编辑器共用同一套 ToolbarButton 与宿主 slot，切过来不该有"换了个产品"的感觉。
 *
 * 标注只存归一化几何，不写 PDF 本体；正文保存走通用笔记 PUT，
 * contentText 从批注文本派生，同步 / 版本历史 / 全文检索都免费复用。
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eraser,
  FileWarning,
  Highlighter,
  Loader2,
  MessageSquarePlus,
  Minus,
  MousePointer2,
  MoveHorizontal,
  MoveUpRight,
  PanelRight,
  Pencil,
  Plus,
  Square,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";

import { EditorToolbarPortal, useEditorToolbarSlot } from "@/components/CollapsibleEditorToolbar";
import { ToolbarButton, ToolbarDivider } from "@/components/editors/ToolbarPrimitives";
import type { NoteEditorHandle, NoteEditorProps } from "@/components/editors/types";
import PdfDocViewer, { type PdfDocViewerHandle, type PdfSelectionPayload } from "@/components/pdf/PdfDocViewer";
import type { PdfTool } from "@/components/pdf/PdfPageView";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  createPdfAnnotation,
  nowPdfTimestamp,
  parsePdfDocContent,
  pdfAnnotationLabel,
  pdfColorSpec,
  pdfDocContentText,
  resolvePdfAnnotationKind,
  serializePdfDocContent,
  PDF_ANNOTATION_COLOR_KEYS,
  type PdfAnnotation,
  type PdfAnnotationColor,
  type PdfDocContent,
} from "@/lib/pdfDocContent";

const SAVE_DEBOUNCE_MS = 800;
/** 归一化线宽：相对页宽的比例，随缩放自动适配。 */
const DEFAULT_STROKE_WIDTH = 0.0035;

const TOOL_ITEMS: { tool: PdfTool; label: string; icon: React.ReactNode }[] = [
  { tool: "select", label: "选择文本", icon: <MousePointer2 size={14} /> },
  { tool: "highlight", label: "高亮（选中文字即标注）", icon: <Highlighter size={14} /> },
  { tool: "note", label: "批注便签", icon: <StickyNote size={14} /> },
  { tool: "rect", label: "矩形框", icon: <Square size={14} /> },
  { tool: "arrow", label: "箭头", icon: <MoveUpRight size={14} /> },
  { tool: "ink", label: "自由手绘", icon: <Pencil size={14} /> },
  { tool: "eraser", label: "擦除（点选标注后删除）", icon: <Eraser size={14} /> },
];

const PdfDocEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(
  function PdfDocEditor({ note, onUpdate, editable = true }, ref) {
    const [doc, setDoc] = useState<PdfDocContent>(() => parsePdfDocContent(note.content));
    const [attachmentUrl, setAttachmentUrl] = useState("");
    const [attachmentLoading, setAttachmentLoading] = useState(Boolean(parsePdfDocContent(note.content).attachmentId));
    const [tool, setTool] = useState<PdfTool>("select");
    const [color, setColor] = useState<PdfAnnotationColor>("amber");
    const [colorMenuOpen, setColorMenuOpen] = useState(false);
    const [page, setPage] = useState(1);
    const [pageInput, setPageInput] = useState("1");
    const [scale, setScale] = useState(1);
    const [numPages, setNumPages] = useState(0);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [selection, setSelection] = useState<PdfSelectionPayload | null>(null);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [focusAnnotationId, setFocusAnnotationId] = useState<string | null>(null);

    const viewerRef = useRef<PdfDocViewerHandle>(null);
    const toolbarSlot = useEditorToolbarSlot();
    const annotationListRef = useRef<HTMLDivElement>(null);

    /** 有还没抛给上层的改动（防抖窗口内） */
    const dirtyRef = useRef(false);
    /** 已经抛给上层、但还没确认落库的改动（防抖抛出的那次只进草稿） */
    const unconfirmedRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const docRef = useRef(doc);
    docRef.current = doc;
    const noteRef = useRef(note);
    noteRef.current = note;
    const pageRef = useRef(page);
    pageRef.current = page;

    // 原件 URL：从笔记附件列表按 id 解析（正文只存 attachmentId 引用）。
    useEffect(() => {
      let alive = true;
      const attachmentId = parsePdfDocContent(note.content).attachmentId;
      if (!attachmentId) {
        setAttachmentUrl("");
        setAttachmentLoading(false);
        return;
      }
      setAttachmentLoading(true);
      api.files
        .list({ noteId: note.id, pageSize: 200, sort: "created_desc" })
        .then((res) => {
          if (!alive) return;
          const found = (res.items || []).find((item) => item.id === attachmentId);
          setAttachmentUrl(found?.url || "");
        })
        .catch(() => {
          if (alive) setAttachmentUrl("");
        })
        .finally(() => {
          if (alive) setAttachmentLoading(false);
        });
      return () => { alive = false; };
    }, [note.id]);

    /**
     * 把当前标注写出去。
     *
     * `flushNow` 决定这是不是「显式保存」：EditorPane 的产品决策是普通编辑只更新本地草稿
     * 并显示「待保存」，真正落库只发生在显式入口（Ctrl+S / 点状态区 / 定时保存）。
     * 所以防抖到期调 flush(false) 只让上层标记 pending，flushSave() 才带 `_flush: true`
     * 真正 PUT——否则每加一条标注就会产生一次版本记录。
     */
    const emitUpdate = useCallback((flushNow: boolean) => {
      const current = docRef.current;
      onUpdate({
        title: noteRef.current.title,
        content: serializePdfDocContent(current),
        contentText: pdfDocContentText(current),
        ...(flushNow ? { _flush: true } : {}),
        _noteId: noteRef.current.id,
      });
    }, [onUpdate]);

    /**
     * 坑：防抖那次已经把 dirtyRef 清掉了，如果显式保存时只看 dirtyRef 就会「什么都不发」，
     * 标注永远落不了库。所以另记一个 unconfirmedRef，显式保存时即便没有新改动也要补发一次。
     */
    const flush = useCallback((flushNow = false) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const hasUnsent = dirtyRef.current;
      if (!hasUnsent && !(flushNow && unconfirmedRef.current)) return;
      dirtyRef.current = false;
      unconfirmedRef.current = true;
      emitUpdate(flushNow);
    }, [emitUpdate]);

    // 服务端 ACK 回来（note.content 与本地标注一致）才算真的落库；失败则保持 unconfirmed，
    // 用户再按一次 Ctrl+S 会重发，而不是「以为保存过了」。
    useEffect(() => {
      if (!unconfirmedRef.current) return;
      if (serializePdfDocContent(parsePdfDocContent(note.content)) === serializePdfDocContent(docRef.current)) {
        unconfirmedRef.current = false;
      }
    }, [note.content]);

    const scheduleSave = useCallback(() => {
      dirtyRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush();
      }, SAVE_DEBOUNCE_MS);
    }, [flush]);

    // 卸载时把防抖窗口里的改动抛给上层（只存草稿，不发 PUT），否则切走就丢
    useEffect(() => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (dirtyRef.current) {
        dirtyRef.current = false;
        emitUpdate(false);
      }
    }, [emitUpdate]);

    const mutateDoc = useCallback((next: PdfDocContent) => {
      setDoc(next);
      scheduleSave();
    }, [scheduleSave]);

    const appendAnnotation = useCallback((annotation: PdfAnnotation) => {
      mutateDoc({ ...docRef.current, annotations: [...docRef.current.annotations, annotation] });
      setActiveId(annotation.id);
      setSidebarOpen(true);
    }, [mutateDoc]);

    const updateAnnotation = useCallback((id: string, patch: Partial<PdfAnnotation>) => {
      mutateDoc({
        ...docRef.current,
        annotations: docRef.current.annotations.map((item) => (
          item.id === id ? { ...item, ...patch, updatedAt: nowPdfTimestamp() } : item
        )),
      });
    }, [mutateDoc]);

    const removeAnnotation = useCallback((id: string) => {
      mutateDoc({
        ...docRef.current,
        annotations: docRef.current.annotations.filter((item) => item.id !== id),
      });
      setActiveId((current) => (current === id ? null : current));
    }, [mutateDoc]);

    const goPage = useCallback((target: number) => {
      viewerRef.current?.gotoPage(target);
      setPage(target);
      setPageInput(String(target));
    }, []);

    const addNote = useCallback(() => {
      const annotation = createPdfAnnotation(pageRef.current, "", undefined, { kind: "note", color });
      appendAnnotation(annotation);
      setFocusAnnotationId(annotation.id);
      setTool("select");
    }, [appendAnnotation, color]);

    /** 选区 → 高亮 / 批注。气泡按钮与高亮工具共用同一条路径。 */
    const createFromSelection = useCallback((mode: "highlight" | "note"): PdfAnnotation | null => {
      const current = selection;
      if (!current || !current.rects.length) return null;
      const annotation = createPdfAnnotation(current.page, "", current.quote, {
        kind: mode,
        rects: current.rects,
        color,
      });
      appendAnnotation(annotation);
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      if (mode === "note") setFocusAnnotationId(annotation.id);
      return annotation;
    }, [selection, color, appendAnnotation]);

    // 高亮工具：选完文字直接落成高亮，不用再去点气泡
    useEffect(() => {
      if (tool !== "highlight" || !selection) return;
      createFromSelection("highlight");
    }, [tool, selection, createFromSelection]);

    const sortedAnnotations = useMemo(
      () => [...doc.annotations].sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt)),
      [doc.annotations],
    );

    const stepAnnotation = useCallback((direction: 1 | -1) => {
      if (!sortedAnnotations.length) return;
      const currentIndex = sortedAnnotations.findIndex((item) => item.id === activeId);
      const fallbackIndex = sortedAnnotations.findIndex((item) => item.page >= pageRef.current);
      const base = currentIndex >= 0 ? currentIndex : (fallbackIndex >= 0 ? fallbackIndex - direction : 0);
      const nextIndex = Math.min(sortedAnnotations.length - 1, Math.max(0, base + direction));
      const target = sortedAnnotations[nextIndex];
      if (!target) return;
      setActiveId(target.id);
      goPage(target.page);
      setSidebarOpen(true);
      window.requestAnimationFrame(() => {
        annotationListRef.current
          ?.querySelector(`[data-annotation-id="${target.id}"]`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }, [sortedAnnotations, activeId, goPage]);

    // 激活项变化时，批注栏跟着滚过去
    useEffect(() => {
      if (!activeId) return;
      annotationListRef.current
        ?.querySelector(`[data-annotation-id="${activeId}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, [activeId]);

    // Delete 删除激活标注（焦点在输入框里时不动）
    useEffect(() => {
      if (!editable) return;
      const handle = (event: KeyboardEvent) => {
        if (event.key !== "Delete" && event.key !== "Backspace") return;
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
        if (!activeId) return;
        event.preventDefault();
        removeAnnotation(activeId);
      };
      window.addEventListener("keydown", handle);
      return () => window.removeEventListener("keydown", handle);
    }, [editable, activeId, removeAnnotation]);

    useImperativeHandle(ref, () => ({
      flushSave: () => flush(true),
      discardPending: () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        dirtyRef.current = false;
        unconfirmedRef.current = false;
      },
      getSnapshot: () => {
        const current = docRef.current;
        return {
          content: serializePdfDocContent(current),
          contentText: pdfDocContentText(current),
          title: noteRef.current.title,
        };
      },
    }), [flush]);

    const activeAnnotation = sortedAnnotations.find((item) => item.id === activeId) || null;
    const toolEnabled = editable && Boolean(attachmentUrl);
    const pageCountLabel = numPages ? String(numPages) : "–";

    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-app-bg">
        {/* 桌面：与富文本同一套宿主 slot；没有宿主（分屏参考栏 / 移动端）就地渲染 */}
        <EditorToolbarPortal target={toolbarSlot}>
          <div className="z-30 flex items-center border-b border-app-border bg-app-elevated px-3 py-2 md:sticky md:top-0 md:z-20 md:bg-app-surface/95 md:px-4 md:backdrop-blur md:supports-[backdrop-filter]:bg-app-surface/70">
            <div className="editor-toolbar-scroll-fade hide-scrollbar flex flex-1 items-center gap-0.5 overflow-x-auto [&>*]:shrink-0">
              <ToolbarButton onClick={() => goPage(page - 1)} disabled={page <= 1} title="上一页">
                <ChevronLeft size={14} />
              </ToolbarButton>
              <input
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value.replace(/[^0-9]/g, ""))}
                onBlur={() => {
                  const parsed = Number(pageInput);
                  if (Number.isFinite(parsed) && parsed >= 1) goPage(Math.min(numPages || 1, parsed));
                  else setPageInput(String(page));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                }}
                className="h-6 w-9 rounded-md border border-app-border bg-app-bg px-1 text-center text-[11.5px] tabular-nums text-tx-primary outline-none focus:border-accent-primary"
                aria-label="跳转页码"
              />
              <span className="px-0.5 text-[11.5px] tabular-nums text-tx-tertiary">/ {pageCountLabel}</span>
              <ToolbarButton onClick={() => goPage(page + 1)} disabled={!numPages || page >= numPages} title="下一页">
                <ChevronRight size={14} />
              </ToolbarButton>

              <ToolbarDivider />

              <ToolbarButton onClick={() => viewerRef.current?.zoomOut()} title="缩小">
                <Minus size={14} />
              </ToolbarButton>
              <button
                type="button"
                onClick={() => viewerRef.current?.fitWidth()}
                title="重置为适应宽度"
                className="h-6 min-w-11 rounded-md px-1 text-center text-[11.5px] tabular-nums text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
              >
                {Math.round(scale * 100)}%
              </button>
              <ToolbarButton onClick={() => viewerRef.current?.zoomIn()} title="放大">
                <Plus size={14} />
              </ToolbarButton>
              <ToolbarButton onClick={() => viewerRef.current?.fitWidth()} title="适应宽度">
                <MoveHorizontal size={14} />
              </ToolbarButton>

              <ToolbarDivider />

              {TOOL_ITEMS.map((item) => (
                <ToolbarButton
                  key={item.tool}
                  isActive={tool === item.tool}
                  disabled={!toolEnabled}
                  title={item.label}
                  onClick={() => setTool(item.tool)}
                >
                  {item.icon}
                </ToolbarButton>
              ))}

              <div className="relative">
                <ToolbarButton
                  onClick={() => setColorMenuOpen((open) => !open)}
                  disabled={!toolEnabled}
                  title="标注颜色"
                >
                  <span
                    className="block h-3 w-3 rounded-full ring-1 ring-black/15"
                    style={{ background: pdfColorSpec(color).dot }}
                  />
                </ToolbarButton>
                {colorMenuOpen ? (
                  <div className="absolute left-0 top-8 z-50 flex items-center gap-1 rounded-lg border border-app-border bg-app-elevated p-1.5 shadow-lg">
                    {PDF_ANNOTATION_COLOR_KEYS.map((key) => (
                      <button
                        key={key}
                        type="button"
                        title={pdfColorSpec(key).label}
                        onClick={() => {
                          setColor(key);
                          setColorMenuOpen(false);
                        }}
                        className={cn(
                          "h-5 w-5 rounded-full ring-1 ring-black/10 transition-transform hover:scale-110",
                          color === key && "ring-2 ring-accent-primary",
                        )}
                        style={{ background: pdfColorSpec(key).dot }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>

              <ToolbarDivider />

              <ToolbarButton
                onClick={() => stepAnnotation(-1)}
                disabled={!sortedAnnotations.length}
                title="上一处标注"
              >
                <ChevronLeft size={14} className="rotate-90" />
              </ToolbarButton>
              <span className="px-0.5 text-[11.5px] tabular-nums text-tx-tertiary">
                {sortedAnnotations.length
                  ? `${Math.max(1, sortedAnnotations.findIndex((item) => item.id === activeId) + 1)}/${sortedAnnotations.length}`
                  : "0"}
              </span>
              <ToolbarButton
                onClick={() => stepAnnotation(1)}
                disabled={!sortedAnnotations.length}
                title="下一处标注"
              >
                <ChevronRight size={14} className="rotate-90" />
              </ToolbarButton>

              <div className="mx-1 h-5 flex-1" />

              <ToolbarButton
                isActive={sidebarOpen}
                onClick={() => setSidebarOpen((open) => !open)}
                title={sidebarOpen ? "收起批注栏" : "展开批注栏"}
              >
                <PanelRight size={14} />
              </ToolbarButton>
              {attachmentUrl ? (
                <a
                  href={attachmentUrl}
                  download={note.title ? `${note.title}.pdf` : "original.pdf"}
                  title="下载原文件"
                  className="ml-0.5 flex h-7 shrink-0 items-center justify-center rounded-full p-1.5 text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
                >
                  <Download size={14} />
                </a>
              ) : null}
            </div>
          </div>
        </EditorToolbarPortal>

        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            {attachmentLoading ? (
              <div className="flex h-full items-center justify-center text-tx-tertiary">
                <Loader2 size={16} className="mr-2 animate-spin" />
                正在加载 PDF 原件…
              </div>
            ) : attachmentUrl ? (
              <PdfDocViewer
                ref={viewerRef}
                url={attachmentUrl}
                tool={toolEnabled ? tool : "select"}
                color={color}
                strokeWidth={DEFAULT_STROKE_WIDTH}
                annotations={doc.annotations}
                activeAnnotationId={activeId}
                selectionPreview={selection?.rects ?? null}
                onCreate={appendAnnotation}
                onActivate={setActiveId}
                onSelection={setSelection}
                onScaleChange={setScale}
                onPageChange={(next) => {
                  setPage(next);
                  setPageInput(String(next));
                  setSelection(null);
                }}
                onDocumentReady={({ numPages: total }) => {
                  setNumPages(total);
                  setPageInput("1");
                }}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-tx-tertiary">
                <FileWarning size={20} />
                <span className="text-xs">没有找到关联的 PDF 原件，可在附件面板重新上传后把 id 填入正文</span>
              </div>
            )}
          </div>

          {selection && tool === "select" && editable ? (
            <div
              className="fixed z-[60] flex items-center gap-0.5 rounded-lg border border-app-border bg-app-elevated p-1 shadow-lg"
              style={{
                top: Math.max(8, selection.anchor.top - 42),
                left: Math.max(8, selection.anchor.left + selection.anchor.width / 2 - 78),
              }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <button
                type="button"
                onClick={() => createFromSelection("highlight")}
                className="inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-[11.5px] text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
              >
                <span
                  className="block h-2.5 w-2.5 rounded-[2px]"
                  style={{ background: pdfColorSpec(color).dot }}
                />
                高亮
              </button>
              <ToolbarButton title="加批注" onClick={() => createFromSelection("note")}>
                <MessageSquarePlus size={14} />
              </ToolbarButton>
              <ToolbarButton title="自由手绘" onClick={() => setTool("ink")}>
                <Pencil size={14} />
              </ToolbarButton>
            </div>
          ) : null}

          <aside
            className={cn(
              "flex shrink-0 flex-col border-l border-app-border bg-app-surface transition-[width] duration-200",
              sidebarOpen ? "w-72" : "w-0 overflow-hidden border-l-0",
            )}
          >
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-app-border px-3">
              <span className="text-[12px] font-medium text-tx-primary">批注</span>
              <span className="rounded-full bg-app-hover px-1.5 py-px text-[10px] tabular-nums text-tx-tertiary">
                {doc.annotations.length}
              </span>
              <div className="flex-1" />
              {editable && attachmentUrl ? (
                <ToolbarButton compact title={`在第 ${page} 页添加批注`} onClick={addNote}>
                  <Plus size={14} />
                </ToolbarButton>
              ) : null}
            </div>

            <div ref={annotationListRef} className="min-h-0 flex-1 overflow-y-auto p-2">
              {sortedAnnotations.length === 0 ? (
                <div className="px-3 py-10 text-center text-[11.5px] leading-relaxed text-tx-tertiary">
                  还没有标注。选中文字可高亮或加批注，
                  也可以直接用矩形、箭头、手绘标在页面上。
                </div>
              ) : (
                sortedAnnotations.map((annotation) => (
                  <AnnotationCard
                    key={annotation.id}
                    annotation={annotation}
                    editable={editable}
                    autoFocus={focusAnnotationId === annotation.id}
                    active={annotation.id === activeId}
                    onJump={() => {
                      setActiveId(annotation.id);
                      goPage(annotation.page);
                    }}
                    onChangeText={(text) => updateAnnotation(annotation.id, { text })}
                    onDelete={() => removeAnnotation(annotation.id)}
                  />
                ))
              )}
            </div>

            {activeAnnotation ? (
              <div className="shrink-0 border-t border-app-border px-3 py-2">
                <div className="flex items-center gap-2 text-[11px] text-tx-tertiary">
                  <span>已选中第 {activeAnnotation.page} 页标注</span>
                  <div className="flex-1" />
                  {editable ? (
                    <button
                      type="button"
                      onClick={() => removeAnnotation(activeAnnotation.id)}
                      className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-tx-tertiary hover:bg-app-hover hover:text-red-500"
                    >
                      <Trash2 size={11} />
                      删除
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setActiveId(null)}
                    className="rounded p-0.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                    aria-label="取消选中"
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    );
  },
);

function AnnotationCard({
  annotation,
  editable,
  autoFocus,
  active,
  onJump,
  onChangeText,
  onDelete,
}: {
  annotation: PdfAnnotation;
  editable: boolean;
  autoFocus: boolean;
  active: boolean;
  onJump: () => void;
  onChangeText: (text: string) => void;
  onDelete: () => void;
}) {
  const kind = resolvePdfAnnotationKind(annotation);
  const spec = pdfColorSpec(annotation.color);
  const rows = Math.min(6, Math.max(2, (annotation.text || "").split("\n").length));
  const isShape = kind !== "note";

  return (
    <div
      data-annotation-id={annotation.id}
      onClick={onJump}
      className={cn(
        "mb-2 cursor-pointer rounded-lg border px-2.5 py-2 transition-colors",
        active ? "border-accent-primary/50 bg-accent-primary/5" : "border-app-border hover:bg-app-hover/40",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="h-3 w-1 rounded-full" style={{ background: spec.dot }} />
        <button
          type="button"
          title="跳转到该标注所在页"
          className="rounded px-1 py-0.5 text-[10px] font-medium hover:opacity-80"
          style={{ background: spec.fill, color: spec.stroke }}
        >
          第 {annotation.page} 页
        </button>
        <span className="min-w-0 flex-1 truncate text-[10px] text-tx-tertiary">
          {isShape ? (annotation.text ? "" : pdfAnnotationLabel(annotation)) : annotation.createdAt}
        </span>
        {editable ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            aria-label="删除标注"
            className="rounded p-0.5 text-tx-tertiary hover:bg-app-hover hover:text-red-500"
          >
            <Trash2 size={12} />
          </button>
        ) : null}
      </div>
      {annotation.quote ? (
        <p className="mb-1 border-l-2 pl-2 text-[11px] italic leading-snug text-tx-tertiary" style={{ borderColor: spec.dot }}>
          {annotation.quote}
        </p>
      ) : null}
      <textarea
        autoFocus={autoFocus}
        value={annotation.text}
        readOnly={!editable}
        rows={rows}
        placeholder={isShape ? "给这处标注加点说明…" : "写点什么…"}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onChangeText(event.target.value)}
        className="w-full resize-none bg-transparent text-xs leading-relaxed text-tx-primary outline-none placeholder:text-tx-tertiary/60"
      />
    </div>
  );
}

export default PdfDocEditor;
