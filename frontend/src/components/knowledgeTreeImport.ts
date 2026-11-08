import { choose, prompt as appPrompt } from "@/components/ui/confirm";
import { api, getCurrentWorkspace } from "@/lib/api";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  formatMarkdownImportFailures,
  importMarkdownFilesIntoKnowledgeTree,
  importMarkdownZipFilesIntoKnowledgeTree,
  markdownBatchImportedCount,
  pickMarkdownFiles,
  pickMarkdownZipFiles,
} from "@/lib/knowledgeTreeMarkdownDrop";
import { toast } from "@/lib/toast";

type LoadedNote = Awaited<ReturnType<typeof api.getNote>>;

interface KnowledgeTreeImportOptions {
  parent: KnowledgeTreeNode | null;
  nodes: KnowledgeTreeNode[];
  fallbackNotebookId: string | null;
}

async function resolvePhysicalNotebookId({
  parent,
  nodes,
  fallbackNotebookId,
}: KnowledgeTreeImportOptions): Promise<string> {
  if (parent) {
    let cursor: KnowledgeTreeNode | undefined = parent;
    const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.resourceType === "notebook") return cursor.resourceId;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    if (parent.resourceType === "note") {
      return (await api.getNote(parent.resourceId)).notebookId;
    }
  }
  if (fallbackNotebookId) return fallbackNotebookId;
  const notebooks = await api.getNotebooks();
  if (notebooks[0]?.id) return notebooks[0].id;
  throw new Error("请先创建一个目录，再导入内容");
}

async function moveImportedNote(
  noteId: string,
  notebookId: string,
  parent: KnowledgeTreeNode | null,
): Promise<void> {
  const targetParentId = parent?.id ?? null;
  if (targetParentId !== `notebook:${notebookId}`) {
    await knowledgeTreeApi.move(`note:${noteId}`, { parentId: targetParentId });
  }
}

export async function importWordIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote | null> {
  const notebookId = await resolvePhysicalNotebookId(options);
  const { pickDocxFile, importDocxAsNote } = await import("@/lib/wordNoteService");
  const file = await pickDocxFile();
  if (!file) return null;
  const toastId = toast.info("正在导入 Word 文档…", 0);
  try {
    const result = await importDocxAsNote({ notebookId, file });
    await moveImportedNote(result.note.id, notebookId, options.parent);
    toast.dismiss(toastId);
    // 导入报告：复杂版式按最接近格式转换，逐项提示（过长截断，完整清单在 warnings 里）。
    const downgrades = result.downgrades || [];
    if (downgrades.length > 0) {
      const summary = downgrades
        .map((item) => `${item.detail}×${item.count}`)
        .join("、")
        .slice(0, 80);
      toast.info(`导入成功；以下版式已简化：${summary}${summary.length >= 80 ? "…" : ""}`);
    } else {
      toast.success("导入成功");
    }
    return result.note as LoadedNote;
  } catch (error) {
    toast.dismiss(toastId);
    throw error;
  }
}

/**
 * 导入 Word 原件（预览，不编辑）：走 contentFormat="docx" 专用链路，
 * 正文只存 { attachmentId }，打开笔记即用 DocxAttachmentPreview 渲染原件。
 */
export async function importWordOriginalIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote | null> {
  const notebookId = await resolvePhysicalNotebookId(options);
  const { pickDocxFile } = await import("@/lib/wordNoteService");
  const file = await pickDocxFile();
  if (!file) return null;
  const toastId = toast.info("正在导入 Word 原件…", 0);
  try {
    const title = file.name.replace(/\.docx$/i, "").trim() || "Word 文档";
    const note = await api.createNote({ title, notebookId, contentFormat: "docx" });
    const attachment = await api.attachments.upload(note.id, file);
    const updated = await api.updateNote(note.id, {
      content: JSON.stringify({ attachmentId: attachment.id }),
      contentText: "",
      version: note.version,
    });
    await moveImportedNote(note.id, notebookId, options.parent);
    toast.dismiss(toastId);
    toast.success("导入成功");
    return (updated || note) as LoadedNote;
  } catch (error) {
    toast.dismiss(toastId);
    throw error;
  }
}

export async function importPdfIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote | null> {
  const notebookId = await resolvePhysicalNotebookId(options);
  const file = await pickPdfFile();
  if (!file) return null;
  const toastId = toast.info("正在导入 PDF 文档…", 0);
  let noteId: string | null = null;
  try {
    const title = file.name.replace(/\.pdf$/i, "").trim() || "PDF 文档";
    const workspaceId = getCurrentWorkspace();
    // 1) 建正文骨架（contentFormat="pdf"，内容 = 原件引用 + 批注层）
    const note = await api.createNote({
      title,
      notebookId,
      contentFormat: "pdf",
      ...(workspaceId && workspaceId !== "personal" ? { workspaceId } : {}),
    });
    noteId = note.id;
    // 2) 原件存附件
    const attachment = await api.attachments.upload(note.id, file);
    // 3) 回填原件引用。
    //    content / contentText 属于「必须带版本」的写入字段（noteSyncSafety 的
    //    isVersionedNoteMutation），漏传 version 会被拦成 VERSION_REQUIRED_CLIENT
    //    「缺少服务端版本，已阻止不安全保存」，导入随之失败并把半成品笔记丢进回收站。
    const withAttachment = await api.updateNote(note.id, {
      content: JSON.stringify({ attachmentId: attachment.id, annotations: [] }),
      contentText: "",
      version: note.version,
    });
    await moveImportedNote(note.id, notebookId, options.parent);
    toast.dismiss(toastId);
    toast.success("导入成功");
    // 返回回填后的笔记：调用方拿它直接渲染 PDF 预览，不必等下次重新加载才有 attachmentId
    return (withAttachment || note) as LoadedNote;
  } catch (error) {
    toast.dismiss(toastId);
    // 失败回滚：把半成品笔记移入回收站（best-effort）
    if (noteId) {
      try { await api.updateNote(noteId, { isTrashed: 1 }); } catch { /* 尽力而为 */ }
    }
    throw error;
  }
}

function pickPdfFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.onchange = () => resolve(input.files?.[0] || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function importMarkdownIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote | null> {
  const files = await pickMarkdownFiles();
  if (files.length === 0) return null;

  // .txt 可选"保持纯文本"（默认仍转 Markdown；取消/关闭也按 Markdown 处理）
  const txtFiles = files.filter((file) => /\.txt$/i.test(file.name));
  const mdFiles = files.filter((file) => !/\.txt$/i.test(file.name));
  let keepTxtPlain = false;
  if (txtFiles.length > 0) {
    const choice = await choose({
      title: "检测到 .txt 文件",
      description: `将 ${txtFiles.length} 个 .txt 文件导入为：`,
      choices: [
        { value: "markdown", label: "Markdown（转换格式，默认）" },
        { value: "plain", label: "纯文本（保持原样，不做格式转换）" },
      ],
    });
    keepTxtPlain = choice === "plain";
  }

  const importedNotes: LoadedNote[] = [];
  if (mdFiles.length > 0 || (!keepTxtPlain && txtFiles.length > 0)) {
    const toastId = toast.info(`正在导入 ${mdFiles.length + (keepTxtPlain ? 0 : txtFiles.length)} 个 Markdown 文件…`, 0);
    let result: Awaited<ReturnType<typeof importMarkdownFilesIntoKnowledgeTree>>;
    try {
      result = await importMarkdownFilesIntoKnowledgeTree(
        keepTxtPlain ? mdFiles : files,
        options.parent?.id ?? null,
      );
    } finally {
      toast.dismiss(toastId);
    }
    if (result.imported.length === 0 && (mdFiles.length > 0 || !keepTxtPlain)) {
      throw new Error(
        result.failures.length > 0
          ? formatMarkdownImportFailures(result.failures)
          : "Markdown 文件导入失败",
      );
    }
    if (result.failures.length > 0) {
      toast.warning(
        `成功导入 ${result.imported.length} 个文件，${result.failures.length} 个失败：${formatMarkdownImportFailures(result.failures)}`,
        8000,
      );
    }
    importedNotes.push(...(result.imported as LoadedNote[]));
  }

  if (keepTxtPlain && txtFiles.length > 0) {
    const plainNotes = await importPlainTextFiles(txtFiles, options);
    importedNotes.push(...plainNotes);
    toast.success(`已导入 ${plainNotes.length} 个纯文本文件`);
  }

  if (importedNotes.length === 0) {
    throw new Error("没有可导入的文件");
  }
  return importedNotes[0];
}

/** .txt 保持纯文本：逐个建 plain 笔记（正文原样，服务端派生 contentText）。 */
async function importPlainTextFiles(
  files: File[],
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote[]> {
  const notebookId = await resolvePhysicalNotebookId(options);
  const notes: LoadedNote[] = [];
  for (const file of files) {
    const text = await file.text();
    const title = file.name.replace(/\.txt$/i, "").trim() || "无标题纯文本";
    const note = await api.createNote({
      notebookId,
      title,
      content: text,
      contentFormat: "plain",
    });
    await moveImportedNote(note.id, notebookId, options.parent);
    notes.push(note as LoadedNote);
  }
  return notes;
}

export async function importMarkdownZipIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote | null> {
  const files = await pickMarkdownZipFiles();
  if (files.length === 0) return null;

  const toastId = toast.info(`正在导入 ${files.length} 个 Markdown 附件 ZIP…`, 0);
  let result: Awaited<ReturnType<typeof importMarkdownZipFilesIntoKnowledgeTree>>;
  try {
    result = await importMarkdownZipFilesIntoKnowledgeTree(files, {
      parentId: options.parent?.id ?? null,
      targetNotebookId: options.parent?.resourceType === "notebook"
        ? options.parent.resourceId
        : undefined,
      workspaceId: options.parent
        ? options.parent.workspaceId || "personal"
        : getCurrentWorkspace(),
      targetLabel: options.parent?.title || "当前空间根目录",
    });
  } finally {
    toast.dismiss(toastId);
  }

  if (result.cancelled) return null;
  const importedCount = markdownBatchImportedCount(result);
  if (importedCount === 0) {
    throw new Error(
      result.failures.length > 0
        ? formatMarkdownImportFailures(result.failures)
        : "Markdown 附件 ZIP 导入失败",
    );
  }
  if (result.failures.length > 0) {
    toast.warning(
      `成功导入 ${importedCount} 篇笔记，${result.failures.length} 个失败：${formatMarkdownImportFailures(result.failures)}`,
      8000,
    );
  } else {
    toast.success(`已从 ZIP 导入 ${importedCount} 篇笔记`);
  }
  return result.imported[0];
}

export async function importWeChatArticleIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote | null> {
  const raw = await appPrompt({
    title: "导入公众号文章",
    description: "请输入微信公众号文章链接",
    placeholder: "https://mp.weixin.qq.com/s/...",
    confirmText: "导入",
    validate: (value) => {
      const url = value.trim();
      if (!url) return "请输入文章链接";
      return /^https:\/\/mp\.weixin\.qq\.com\/s[\/?]/.test(url) ? null : "暂只支持微信公众号文章链接";
    },
  });
  if (raw == null) return null;
  const notebookId = await resolvePhysicalNotebookId(options);
  const toastId = toast.info("正在导入文章…", 0);
  try {
    const result = await api.urlImport(raw.trim(), notebookId);
    await moveImportedNote(result.noteId, notebookId, options.parent);
    const note = await api.getNote(result.noteId);
    toast.dismiss(toastId);
    toast.success(`已导入：${result.title}`);
    return note;
  } catch (error) {
    toast.dismiss(toastId);
    throw error;
  }
}

