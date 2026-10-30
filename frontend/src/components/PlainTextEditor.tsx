/**
 * PlainTextEditor —— 纯文本文档编辑器（contentFormat = "plain"）
 *
 * 极简契约（方案 docs/product/kb-block-core-plan.md 阶段 1）：
 * 纯文本就是纯文本——无 blockId、无块引用、无语法渲染，等宽 textarea 即全部。
 * 实现 NoteEditorHandle 最小子集（flushSave/getSnapshot），保证 EditorPane
 * 的切换/保存调度无需感知差异。
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import type { NoteEditorHandle, NoteEditorProps } from "@/components/editors/types";
import { cn } from "@/lib/utils";

const SAVE_DEBOUNCE_MS = 600;

const PlainTextEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(
  function PlainTextEditor({ note, onUpdate, editable = true }, ref) {
    const [value, setValue] = useState<string>(() => note.content || "");
    const valueRef = useRef(value);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 仅在切换笔记时以新笔记正文初始化（EditorPane 已按 note.id remount，这里只是兜底）。
    // 不依赖 note.content：保存 ACK 回填 store 时不能把用户正在输入的内容回滚。
    useEffect(() => {
      setValue(note.content || "");
      valueRef.current = note.content || "";
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [note.id]);

    const flushValue = useCallback((content: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      onUpdate({
        title: note.title,
        content,
        contentText: content.replace(/\u0000/g, "").trim(),
        _noteId: note.id,
      });
    }, [note.id, note.title, onUpdate]);

    const handleChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value;
      setValue(next);
      valueRef.current = next;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flushValue(next);
      }, SAVE_DEBOUNCE_MS);
    }, [flushValue, note.id]);

    useEffect(() => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    useImperativeHandle(ref, () => ({
      flushSave: () => {
        if (timerRef.current) flushValue(valueRef.current);
      },
      discardPending: () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      },
      getSnapshot: () => ({
        content: valueRef.current,
        contentText: valueRef.current.replace(/\u0000/g, "").trim(),
        title: note.title,
      }),
      isReady: () => true,
    }), [flushValue, note.title]);

    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-app-bg">
        <textarea
          key={note.id}
          value={value}
          onChange={handleChange}
          readOnly={!editable}
          spellCheck={false}
          className={cn(
            "h-full w-full flex-1 resize-none bg-transparent px-4 py-3 md:px-8 md:py-4",
            "font-mono text-sm leading-6 text-tx-primary outline-none",
            "placeholder:text-tx-tertiary",
          )}
          placeholder="纯文本文档…"
        />
      </div>
    );
  },
);

export default PlainTextEditor;
