import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveAs: vi.fn(),
  loadNotebookExportNotes: vi.fn(),
  exportNotebook: vi.fn(),
  buildPrintableHtml: vi.fn(),
  renderPrintableHtmlToPdfBlob: vi.fn(),
  renderNoteImageFiles: vi.fn(),
  normalizeNoteImageExportSource: vi.fn((note: unknown) => note),
  exportNoteAsDocx: vi.fn(),
}));

vi.mock("file-saver", () => ({ saveAs: mocks.saveAs }));
vi.mock("@/lib/exportServiceCore", () => ({
  exportNotebook: mocks.exportNotebook,
  loadNotebookExportNotes: mocks.loadNotebookExportNotes,
  buildPrintableHtml: mocks.buildPrintableHtml,
  renderPrintableHtmlToPdfBlob: mocks.renderPrintableHtmlToPdfBlob,
  sanitizeFilename: (name: string) => (name || "未命名").replace(/[/\\?<>:*|"]/g, "_").trim(),
}));
vi.mock("@/lib/noteImageExportCore", () => ({
  renderNoteImageFiles: mocks.renderNoteImageFiles,
}));
vi.mock("@/lib/noteImageExportBridge", () => ({
  normalizeNoteImageExportSource: mocks.normalizeNoteImageExportSource,
}));
vi.mock("@/lib/wordNoteService", () => ({
  exportNoteAsDocx: mocks.exportNoteAsDocx,
}));

import {
  NOTEBOOK_EXPORT_FORMAT_ITEMS,
  exportNotebookAsFormat,
} from "../notebookFormatExport";

const scope = {
  notebookId: "nb-root",
  notebookName: "项目库",
  descendantNotebookIds: new Set(["nb-root", "nb-child"]),
};

function note(overrides: Record<string, unknown>) {
  return {
    id: "note-1",
    title: "文档",
    content: "{}",
    contentText: "",
    contentFormat: "tiptap-json",
    notebookId: "nb-root",
    notebookName: "设计",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    ...overrides,
  };
}

async function readZip(blob: Blob): Promise<JSZip> {
  const data = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  return JSZip.loadAsync(data);
}

/** JSZip 会为每个目录额外补一条以 / 结尾的空条目，断言时只看文件。 */
function files(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((path) => !path.endsWith("/")).sort();
}

describe("exportNotebookAsFormat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildPrintableHtml.mockResolvedValue("<html></html>");
    mocks.renderPrintableHtmlToPdfBlob.mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }));
    mocks.exportNoteAsDocx.mockResolvedValue(new Blob(["docx"]));
    mocks.renderNoteImageFiles.mockResolvedValue({
      files: [{ blob: new Blob(["png"]), fileName: "文档.png", mimeType: "image/png", width: 1, height: 1 }],
      warnings: [],
      failedResources: [],
      paginated: false,
    });
  });

  it("offers the same six formats as single-note export", () => {
    expect(NOTEBOOK_EXPORT_FORMAT_ITEMS.map((item) => item.id)).toEqual([
      "markdown",
      "markdown_zip",
      "pdf",
      "png",
      "jpg",
      "word",
    ]);
  });

  it("keeps the directory tree and disambiguates duplicate titles in one folder", async () => {
    mocks.loadNotebookExportNotes.mockResolvedValue([
      note({ id: "n1", title: "规范", notebookName: "设计" }),
      note({ id: "n2", title: "规范", notebookName: "设计" }),
      note({ id: "n3", title: "报价", notebookName: "商务" }),
    ]);

    expect(await exportNotebookAsFormat(scope, "pdf")).toBe(true);

    const blob = mocks.saveAs.mock.calls[0][0] as Blob;
    const zip = await readZip(blob);
    expect(files(zip)).toEqual([
      "商务/报价.pdf",
      "设计/规范.pdf",
      "设计/规范_2.pdf",
    ]);
    expect(mocks.saveAs.mock.calls[0][1]).toContain("项目库_pdf_");
  });

  it("exports the remaining documents when one fails and records the failure", async () => {
    mocks.loadNotebookExportNotes.mockResolvedValue([
      note({ id: "n1", title: "好的", notebookName: "设计" }),
      note({ id: "n2", title: "坏掉的", notebookName: "设计" }),
    ]);
    mocks.renderPrintableHtmlToPdfBlob
      .mockResolvedValueOnce(new Blob(["pdf"], { type: "application/pdf" }))
      .mockRejectedValueOnce(new Error("页面超出渲染上限"));

    expect(await exportNotebookAsFormat(scope, "pdf")).toBe(true);

    const zip = await readZip(mocks.saveAs.mock.calls[0][0] as Blob);
    expect(zip.file("设计/好的.pdf")).not.toBeNull();
    expect(zip.file("设计/坏掉的.pdf")).toBeNull();
    const failures = JSON.parse(await zip.file("export-failures.json")!.async("string"));
    expect(failures.format).toBe("pdf");
    expect(failures.failed).toEqual([{ title: "坏掉的", reason: "页面超出渲染上限" }]);
  });

  it("returns false without saving anything when every document fails", async () => {
    mocks.loadNotebookExportNotes.mockResolvedValue([note({ id: "n1", title: "坏的" })]);
    mocks.renderPrintableHtmlToPdfBlob.mockRejectedValue(new Error("boom"));

    expect(await exportNotebookAsFormat(scope, "pdf")).toBe(false);
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });

  it("packs every paginated image of one document", async () => {
    mocks.loadNotebookExportNotes.mockResolvedValue([note({ id: "n1", title: "长文", notebookName: "设计" })]);
    mocks.renderNoteImageFiles.mockResolvedValue({
      files: [
        { blob: new Blob(["p1"]), fileName: "长文-01.png", mimeType: "image/png", width: 1, height: 1 },
        { blob: new Blob(["p2"]), fileName: "长文-02.png", mimeType: "image/png", width: 1, height: 1 },
      ],
      warnings: [],
      failedResources: [],
      paginated: true,
    });

    expect(await exportNotebookAsFormat(scope, "png")).toBe(true);

    const zip = await readZip(mocks.saveAs.mock.calls[0][0] as Blob);
    expect(files(zip)).toEqual(["设计/长文-01.png", "设计/长文-02.png"]);
    expect(mocks.renderNoteImageFiles).toHaveBeenCalledWith(
      expect.objectContaining({ id: "n1" }),
      { format: "png" },
    );
  });

  it("delegates both Markdown variants to the knowledge-package exporter", async () => {
    mocks.exportNotebook.mockResolvedValue(true);

    await exportNotebookAsFormat(scope, "markdown");
    expect(mocks.exportNotebook).toHaveBeenLastCalledWith(scope, undefined, { inlineImages: true });

    await exportNotebookAsFormat(scope, "markdown_zip");
    expect(mocks.exportNotebook).toHaveBeenLastCalledWith(scope, undefined, { inlineImages: false });
  });
});
