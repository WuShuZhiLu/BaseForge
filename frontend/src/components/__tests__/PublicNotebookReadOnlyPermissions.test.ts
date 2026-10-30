import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canWriteNote } from "../../lib/notePermissions";

const editorPaneSource = readFileSync(path.resolve(__dirname, "../EditorPane.tsx"), "utf8");
const splitViewSource = readFileSync(path.resolve(__dirname, "../EditorSplitView.tsx"), "utf8");
const publicViewSource = readFileSync(path.resolve(__dirname, "../PublicNotebookView.tsx"), "utf8");
const publicRendererSource = readFileSync(path.resolve(__dirname, "../PublicKnowledgeResourceRenderer.tsx"), "utf8");
const tiptapSource = readFileSync(path.resolve(__dirname, "../TiptapEditor.tsx"), "utf8");

describe("shared note read-only permissions", () => {
  it("only grants write access to explicit write/manage permissions", () => {
    expect(canWriteNote(undefined)).toBe(true);
    expect(canWriteNote({ permission: undefined } as any)).toBe(true);
    expect(canWriteNote({ permission: "manage" } as any)).toBe(true);
    expect(canWriteNote({ permission: "write" } as any)).toBe(true);
    expect(canWriteNote({ permission: "comment" } as any)).toBe(false);
    expect(canWriteNote({ permission: "read" } as any)).toBe(false);
  });

  it("gates every main editor mode with the active note permission", () => {
    expect(editorPaneSource).toContain('import { canWriteNote } from "@/lib/notePermissions";');
    expect(editorPaneSource).toContain("const canEditActiveNote = canWriteNote(activeNote);");
    const gates = editorPaneSource.match(
      /editable=\{canEditActiveNote && !effectiveLocked && !modeSwitching\}/g,
    ) || [];
    // 3 → 7：嵌入块 / PDF 受控查看器 / 导图等编辑模式加入后，每个模式实例都必须
    // 被同一权限门控覆盖（存量契约没跟上功能演进，2026-10-26 实测对齐）。
    expect(gates).toHaveLength(7);
  });

  it("keeps the split editor read-only and ignores stale update callbacks", () => {
    expect(splitViewSource).toContain('import { canWriteNote } from "@/lib/notePermissions";');
    // 分屏改为两栏固定绑定文档（2026-10）：焦点栏编辑不再借道 activeNote 分流，
    // 每一栏的编辑权仍必须过 canWriteNote + readOnly 门，镜像栏固定只读。
    expect(splitViewSource).toContain(
      "const editable = !!note && canWriteNote(note) && note.id === noteId && !readOnly && !note.isLocked && !note.isTrashed && !loadingState.pendingNoteId;",
    );
    expect(splitViewSource).toMatch(/readOnly\s*\|\|[\s\S]*!canWriteNote\(current\)/);
  });

  it("uses a chrome-free Tiptap presentation mode on public pages", () => {
    expect(publicViewSource).toContain('<PublicKnowledgeResourceRenderer resource={activeResource} />');
    expect(publicRendererSource).toContain("presentationMode");
    expect(publicRendererSource).toContain("editable={false}");
    expect(tiptapSource).toContain("presentationMode?: boolean;");
    expect(tiptapSource).toContain('presentationMode && "tiptap-presentation-mode"');
    expect(tiptapSource).toContain("{!presentationMode && (");
    expect(tiptapSource).toContain("editor && !presentationMode");
  });

  it("does not bind format painter DOM listeners for an unmounted read-only guest editor", () => {
    expect(tiptapSource).toContain(
      "if (!editor || !editable || isGuest || editor.isDestroyed || !editor.isInitialized) return;",
    );
    expect(tiptapSource).toContain("const editorDom = editor.view.dom;");
    expect(tiptapSource).toContain(
      'editorDom.removeEventListener("pointerdown", handlePointerDown);',
    );
  });

  it("registers underline only once", () => {
    expect(tiptapSource).toContain("underline: false,");
    expect(tiptapSource).toContain("      Underline,");
  });

  it("does not request comments when the publication is read-only with comments disabled", () => {
    expect(publicViewSource).toContain(
      "info.allowComment || info.permission !== \"read\"",
    );
    expect(publicViewSource).toMatch(/const nextComments = canComment\s+\? await notebookPublicationApi\.getComments\([^;]+\s+: \[\];/);
  });
});
