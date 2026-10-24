/**
 * MindMapDocEditor —— 导图文档编辑器（contentFormat = "mindmap"）
 *
 * 导图归一后正文存 notes（MindMapData JSON）。编辑器复用 MindMapCenter 的
 * embeddedMode（经 vite alias 懒加载独立 chunk），保存走 /api/mindmaps 门面
 * （写 notes 表，带乐观锁与冲突 UI）。切换笔记卸载时的冲刷由 MindMapCenter
 * 的 embeddedMode 卸载钩子负责；这里只提供最小句柄满足 EditorPane 契约。
 */
import React, { forwardRef, useImperativeHandle, useRef } from "react";

import MindMapCenter from "@/components/MindMapEditor";
import type { NoteEditorHandle, NoteEditorProps } from "@/components/editors/types";

const MindMapDocEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(
  function MindMapDocEditor({ note }, ref) {
    const noteRef = useRef(note);
    noteRef.current = note;

    useImperativeHandle(ref, () => ({
      // 保存由 MindMapCenter 自管（防抖 + 卸载冲刷 + 门面乐观锁），无 EditorPane 侧 pending。
      flushSave: () => undefined,
      discardPending: () => undefined,
      getSnapshot: () => ({
        content: noteRef.current.content || "",
        contentText: noteRef.current.contentText || "",
        title: noteRef.current.title,
      }),
    }), []);

    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-app-bg">
        <MindMapCenter
          embeddedMode
          embeddedMindMapId={note.id}
        />
      </div>
    );
  },
);

export default MindMapDocEditor;
