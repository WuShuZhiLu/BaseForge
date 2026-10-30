/**
 * PdfDocEditor —— PDF 文档编辑器（contentFormat = "pdf"）
 *
 * 正文 = 原件引用 + 批注层 JSON：{ attachmentId, annotations: [...] }
 * 左侧复用 AttachmentPdfPreview（pdfjs 渲染原文件，受控页码），
 * 右侧是页码锚定的批注层（纯文本笔记，不做 PDF 本体编辑）。
 * 变更防抖落盘走 onUpdate（通用笔记 PUT），contentText 从批注派生；
 * flushSave/getSnapshot 用 imperative API 现取，避免切换笔记丢最后一次编辑。
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
import { Download, FileWarning, Loader2, Plus, StickyNote, Trash2 } from "lucide-react";

import AttachmentPdfPreview from "@/components/attachmentPreview/AttachmentPdfPreview";
import type { NoteEditorHandle, NoteEditorProps } from "@/components/editors/types";
import { api } from "@/lib/api";
import {
  createPdfAnnotation,
  nowPdfTimestamp,
  parsePdfDocContent,
  pdfDocContentText,
  serializePdfDocContent,
  type PdfAnnotation,
  type PdfDocContent,
} from "@/lib/pdfDocContent";

const SAVE_DEBOUNCE_MS = 800;

const PdfDocEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(
  function PdfDocEditor({ note, onUpdate, editable = true }, ref) {
    const [doc, setDoc] = useState<PdfDocContent>(() => parsePdfDocContent(note.content));
    const [attachmentUrl, setAttachmentUrl] = useState("");
    const [attachmentLoading, setAttachmentLoading] = useState(Boolean(parsePdfDocContent(note.content).attachmentId));
    const [page, setPage] = useState(1);
    const [focusAnnotationId, setFocusAnnotationId] = useState<string | null>(null);

    const dirtyRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const docRef = useRef(doc);
    docRef.current = doc;
    const noteRef = useRef(note);
    noteRef.current = note;

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

    const flush = useCallback(() => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      const current = docRef.current;
      onUpdate({
        title: noteRef.current.title,
        content: serializePdfDocContent(current),
        contentText: pdfDocContentText(current),
        _noteId: noteRef.current.id,
      });
    }, [onUpdate]);

    const scheduleSave = useCallback(() => {
      dirtyRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush();
      }, SAVE_DEBOUNCE_MS);
    }, [flush]);

    useEffect(() => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    const mutateDoc = useCallback((next: PdfDocContent) => {
      setDoc(next);
      scheduleSave();
    }, [scheduleSave]);

    const addAnnotation = useCallback(() => {
      const annotation = createPdfAnnotation(page, "");
      mutateDoc({ ...docRef.current, annotations: [annotation, ...docRef.current.annotations] });
      setFocusAnnotationId(annotation.id);
    }, [mutateDoc, page]);

    const updateAnnotationText = useCallback((id: string, text: string) => {
      const annotations = docRef.current.annotations.map((item) => (
        item.id === id ? { ...item, text, updatedAt: nowPdfTimestamp() } : item
      ));
      mutateDoc({ ...docRef.current, annotations });
    }, [mutateDoc]);

    const removeAnnotation = useCallback((id: string) => {
      mutateDoc({
        ...docRef.current,
        annotations: docRef.current.annotations.filter((item) => item.id !== id),
      });
    }, [mutateDoc]);

    useImperativeHandle(ref, () => ({
      flushSave: flush,
      discardPending: () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        dirtyRef.current = false;
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

    const sortedAnnotations = useMemo(
      () => [...doc.annotations].sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt)),
      [doc.annotations],
    );

    return (
      <div className="flex h-full min-h-0 flex-1 overflow-hidden bg-app-bg">
        <div className="min-w-0 flex-1 overflow-auto">
          {attachmentLoading ? (
            <div className="flex h-full min-h-[60vh] items-center justify-center text-tx-tertiary">
              <Loader2 size={16} className="mr-2 animate-spin" />
              正在加载 PDF 原件…
            </div>
          ) : attachmentUrl ? (
            <AttachmentPdfPreview
              url={attachmentUrl}
              filename={note.title || "PDF 文档"}
              page={page}
              onPageChange={setPage}
              heightClass="min-h-full"
            />
          ) : (
            <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-2 text-tx-tertiary">
              <FileWarning size={20} />
              <span className="text-xs">没有找到关联的 PDF 原件，可在附件面板重新上传后把 id 填入正文</span>
            </div>
          )}
        </div>

        <aside className="flex w-80 shrink-0 flex-col border-l border-app-border bg-app-surface">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-app-border px-3">
            <StickyNote size={14} className="text-amber-500" />
            <span className="mr-auto text-xs font-medium text-tx-primary">批注（{doc.annotations.length}）</span>
            {editable && attachmentUrl && (
              <button
                type="button"
                onClick={addAnnotation}
                className="inline-flex items-center gap-1 rounded-md bg-accent-primary/10 px-2 py-1 text-[11px] font-medium text-accent-primary hover:bg-accent-primary/15"
                title={`在第 ${page} 页添加批注`}
              >
                <Plus size={12} />
                第 {page} 页
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {sortedAnnotations.length === 0 ? (
              <div className="px-3 py-10 text-center text-xs text-tx-tertiary">
                还没有批注。翻到需要的页面后点上方按钮添加，批注会锚定所在页码。
              </div>
            ) : (
              sortedAnnotations.map((annotation) => (
                <AnnotationCard
                  key={annotation.id}
                  annotation={annotation}
                  editable={editable}
                  autoFocus={focusAnnotationId === annotation.id}
                  active={page === annotation.page}
                  onJump={() => setPage(annotation.page)}
                  onChangeText={(text) => updateAnnotationText(annotation.id, text)}
                  onDelete={() => removeAnnotation(annotation.id)}
                />
              ))
            )}
          </div>

          {attachmentUrl && (
            <div className="shrink-0 border-t border-app-border px-3 py-2">
              <a
                href={attachmentUrl}
                download={note.title ? `${note.title}.pdf` : "original.pdf"}
                className="inline-flex items-center gap-1 text-[11px] text-tx-secondary hover:text-tx-primary"
              >
                <Download size={12} />
                下载原文件
              </a>
            </div>
          )}
        </aside>
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
  const rows = Math.max(2, annotation.text.split("\n").length);
  return (
    <div
      className={`mb-2 rounded-lg border px-2.5 py-2 transition-colors ${
        active ? "border-accent-primary/40 bg-accent-primary/5" : "border-app-border hover:bg-app-hover/40"
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onJump}
          title="跳转到批注页"
          className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 hover:bg-amber-500/20"
        >
          第 {annotation.page} 页
        </button>
        <span className="min-w-0 flex-1 truncate text-[10px] text-tx-tertiary">{annotation.createdAt}</span>
        {editable && (
          <button
            type="button"
            onClick={onDelete}
            aria-label="删除批注"
            className="rounded p-0.5 text-tx-tertiary hover:bg-app-hover hover:text-red-500"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {annotation.quote && (
        <p className="mb-1 border-l-2 border-app-border pl-2 text-[11px] italic text-tx-tertiary">{annotation.quote}</p>
      )}
      <textarea
        autoFocus={autoFocus}
        value={annotation.text}
        readOnly={!editable}
        rows={rows}
        placeholder="写点什么…"
        onChange={(event) => onChangeText(event.target.value)}
        className="w-full resize-none bg-transparent text-xs leading-relaxed text-tx-primary outline-none placeholder:text-tx-tertiary/60"
      />
    </div>
  );
}

export default PdfDocEditor;
