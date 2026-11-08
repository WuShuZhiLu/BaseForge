/**
 * WordDocEditor —— Word 原件预览编辑器（contentFormat = "docx"）
 *
 * 正文 = 原件引用 JSON：{ attachmentId }
 * 渲染走 docx-preview（docxjs）：直接解析 OOXML，保留分页 / 页眉页脚 /
 * 表格 / 图片 / 原始样式，只读不编辑；工具栏提供下载原件与缩放。
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FileWarning, Loader2 } from "lucide-react";

import type { NoteEditorHandle, NoteEditorProps } from "@/components/editors/types";
import { api } from "@/lib/api";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.15;

const WordDocEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(
  function WordDocEditor({ note }, ref) {
    const [attachmentId, setAttachmentId] = useState<string>("");
    const [attachmentUrl, setAttachmentUrl] = useState("");
    const [filename, setFilename] = useState(note.title || "document.docx");
    const [loading, setLoading] = useState(false);
    const [notFound, setNotFound] = useState(false);
    const [renderError, setRenderError] = useState("");
  const [zoom, setZoom] = useState(1);
  const renderContainerRef = useRef<HTMLDivElement | null>(null);
  const outerContainerRef = useRef<HTMLDivElement | null>(null);


    useImperativeHandle(ref, () => ({}), []);

    // 渲染：拉取 docx → docx-preview 解析绘制（分页 / 页眉页脚 / 图片 / 样式）
    useEffect(() => {
      let alive = true;
      let parsedId = "";
      try {
        parsedId = (JSON.parse(note.content) as { attachmentId?: string }).attachmentId || "";
      } catch {
        parsedId = "";
      }
      setAttachmentId(parsedId);
      if (!parsedId) {
        setAttachmentUrl("");
        setLoading(false);
        setNotFound(true);
        return;
      }
      setLoading(true);
      setNotFound(false);
      setRenderError("");
      api.files
        .list({ noteId: note.id, pageSize: 200, sort: "created_desc" })
        .then((res) => {
          if (!alive) return;
          const found = (res.items || []).find((item) => item.id === parsedId);
          setAttachmentUrl(found?.url || "");
          if (found?.filename) setFilename(found.filename);
          if (!found?.url) {
            setNotFound(true);
            return;
          }
          // docx-preview 渲染到容器（异步动态加载，避免进首屏包）
          const url = found.url;
          Promise.all([
            import("docx-preview"),
            fetch(url).then((resp) => {
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              return resp.arrayBuffer();
            }),
          ]).then(([docxPreview, buffer]) => {
            if (!alive) return;
            const container = renderContainerRef.current;
            if (!container) return;
            container.replaceChildren();
            void docxPreview.renderAsync(buffer, container, undefined, {
              className: "docx-render",
              inWrapper: true,
              breakPages: true,
              renderHeaders: true,
              renderFooters: true,
              renderFootnotes: true,
              ignoreFonts: false,
              useBase64URL: true,
            }).then(() => {
              if (!alive) return;
              // 部分图片是 WMF/EMF 等 Windows 专有格式，浏览器无法解码，
              // docx-preview 会输出裂图占位 —— 检测 naturalWidth=0 的 img，
              // 替换为明确的占位提示，避免出现碎图标。
              const imgs = Array.from(container.querySelectorAll("img"));
              for (const img of imgs) {
                if (img.complete && img.naturalWidth === 0) {
                  const box = document.createElement("div");
                  box.style.cssText = "display:flex;align-items:center;justify-content:center;border:1px dashed #bbb;color:#8f939b;font-size:12px;padding:16px;margin:8px auto;min-width:120px;min-height:60px;max-width:60%";
                  box.textContent = "该图片格式（如 WMF/EMF）浏览器无法直接渲染，请下载原件查看";
                  img.replaceWith(box);
                } else {
                  img.addEventListener("error", () => {
                    const box = document.createElement("div");
                    box.style.cssText = "display:flex;align-items:center;justify-content:center;border:1px dashed #bbb;color:#8f939b;font-size:12px;padding:16px;margin:8px auto;min-width:120px;min-height:60px;max-width:60%";
                    box.textContent = "该图片无法渲染，请下载原件查看";
                    img.replaceWith(box);
                  }, { once: true });
                }
              }
            }).catch((err: unknown) => {
              if (alive) setRenderError((err as Error)?.message || String(err));
            });
          }).catch((err: unknown) => {
            if (alive) setRenderError((err as Error)?.message || String(err));
          });
        })
        .catch(() => {
          if (alive) { setAttachmentUrl(""); setNotFound(true); }
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
      return () => { alive = false; };
    }, [note.id, note.content]);

    // Ctrl/Cmd + 滚轮缩放 Word 页面本身；preventDefault 拦掉浏览器整页缩放。
    // wheel 必须用非 passive 原生监听（React 的 onWheel 是 passive，preventDefault 无效）。
    // 监听挂在外层容器（始终渲染）——挂在内层渲染区会在它挂载前落空。
    useEffect(() => {
      const container = outerContainerRef.current;
      if (!container) return;
      const handleWheel = (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));
      };
      container.addEventListener("wheel", handleWheel, { passive: false });
      return () => container.removeEventListener("wheel", handleWheel);
    }, []);

    return (
      <div
        ref={outerContainerRef}
        className="flex h-full min-h-0 flex-col overflow-hidden bg-app-bg"
      >
        <div className="min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-tx-tertiary">
              <Loader2 size={18} className="mr-2 animate-spin" />正在加载 Word 原件…
            </div>
          ) : notFound || !attachmentUrl ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-tx-tertiary">
              <FileWarning size={30} className="opacity-50" />
              <p>找不到原件附件，可能已被删除</p>
            </div>
          ) : renderError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-tx-tertiary">
              <FileWarning size={30} className="opacity-50" />
              <p>原件渲染失败：{renderError}</p>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              {/* 缩放工具条 */}
              <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-app-border px-3 text-xs text-tx-tertiary">
                <button className="rounded px-1.5 hover:bg-app-hover" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z / ZOOM_STEP)))}>−</button>
                <span className="w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
                <button className="rounded px-1.5 hover:bg-app-hover" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * ZOOM_STEP)))}>＋</button>
                <button className="rounded px-1.5 hover:bg-app-hover" onClick={() => setZoom(1)}>重置</button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-app-panel py-4 flex justify-center">
                {/* 覆盖 docx-preview 默认样式（其默认样式注入在渲染容器内、晚于本规则，
                    特异性相同必须用 !important 才能压过灰底与内边距） */}
                <style>{`
                  .docx-render-wrapper {
                    background: transparent !important;
                    padding: 0 !important;
                    margin: 0 !important;
                    min-width: 0 !important;
                    min-height: 0 !important;
                  }
                `}</style>
                <div
                  ref={renderContainerRef}
                  className="w-fit bg-white shadow-md"
                  style={{ zoom }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
);

export default WordDocEditor;
