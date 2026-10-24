// ir-to-tiptap 适配器单元测试：标题/段落/行内标记、列表聚合、表格合并、图片上传与降级。
import { describe, expect, it, vi } from "vitest";
import { irToTiptap, irPlainText } from "../serializers/ir-to-tiptap";
import type { DocxIR, ParagraphNode } from "../../ir/document";

function paragraph(overrides: Partial<ParagraphNode> = {}): ParagraphNode {
  return { type: "paragraph", runs: [], ...overrides };
}

function ir(body: DocxIR["sections"][number]["body"]): DocxIR {
  return { meta: { title: "测试文档" }, sections: [{ body }] };
}

const uploadOk = async ({ bytes, contentType }: { bytes: Uint8Array; contentType: string }) =>
  `att://img-${bytes.length}-${contentType}`;

describe("irToTiptap", () => {
  it("标题与段落映射：headingLevel → heading，对齐 → textAlign", async () => {
    const result = await irToTiptap(ir([
      paragraph({ headingLevel: 2, alignment: "center", runs: [{ type: "run", text: "第二章" }] }),
      paragraph({ runs: [{ type: "run", text: "正文", props: { bold: true } }] }),
    ]), { uploadImage: uploadOk });

    const content = result.doc.content!;
    expect(content[0].type).toBe("heading");
    expect(content[0].attrs).toMatchObject({ level: 2, textAlign: "center" });
    expect(content[1].type).toBe("paragraph");
    expect(content[1].content![0]).toMatchObject({ type: "text", text: "正文" });
    expect(content[1].content![0].marks).toContainEqual({ type: "bold", attrs: {} });
  });

  it("行内样式映射：color/fontSize/highlight/link", async () => {
    const result = await irToTiptap(ir([
      paragraph({
        runs: [
          { type: "run", text: "红字", props: { color: "FF0000", fontSize: 14, highlight: "yellow" } },
          { type: "hyperlink", href: "https://example.com", runs: [{ type: "run", text: "链接" }] },
        ],
      }),
    ]), { uploadImage: uploadOk });

    const [first, link] = result.doc.content![0].content!;
    expect(first.marks).toContainEqual({ type: "textStyle", attrs: { color: "#FF0000", fontSize: "14pt" } });
    expect(first.marks).toContainEqual({ type: "highlight", attrs: { color: "yellow" } });
    expect(link.marks).toContainEqual({ type: "link", attrs: { href: "https://example.com" } });
  });

  it("相邻同编号段落聚合为列表，ilvl 形成嵌套；编号与项目符号分流", async () => {
    const result = await irToTiptap(ir([
      paragraph({ list: { numId: 1, ilvl: 0, marker: "•", numFmt: "bullet" }, runs: [{ type: "run", text: "一" }] }),
      paragraph({ list: { numId: 1, ilvl: 1, marker: "•", numFmt: "bullet" }, runs: [{ type: "run", text: "一点一" }] }),
      paragraph({ list: { numId: 1, ilvl: 0, marker: "•", numFmt: "bullet" }, runs: [{ type: "run", text: "二" }] }),
      paragraph({ list: { numId: 2, ilvl: 0, marker: "1.", numFmt: "decimal" }, runs: [{ type: "run", text: "编号" }] }),
    ]), { uploadImage: uploadOk });

    const [bullet, ordered] = result.doc.content!;
    expect(bullet.type).toBe("bulletList");
    const items = bullet.content!;
    expect(items).toHaveLength(2);
    expect(items[0].content![0].content![0].text).toBe("一");
    // 嵌套子列表挂在第一个 listItem 内
    const nested = items[0].content!.find((node) => node.type === "bulletList");
    expect(nested).toBeTruthy();
    expect(items[1].content![0].content![0].text).toBe("二");
    expect(ordered.type).toBe("orderedList");
  });

  it("表格：gridSpan/rowSpan → colspan/rowspan，单元格段落保留", async () => {
    const result = await irToTiptap(ir([
      {
        type: "table",
        rows: [
          { type: "row", cells: [{ type: "cell", gridSpan: 2, rowSpan: 2, body: [paragraph({ runs: [{ type: "run", text: "合并格" }] })] }] },
          { type: "row", cells: [] },
        ],
      },
    ]), { uploadImage: uploadOk });

    const table = result.doc.content![0];
    expect(table.type).toBe("table");
    const cell = table.content![0].content![0];
    expect(cell.attrs).toMatchObject({ colspan: 2, rowspan: 2 });
    expect(cell.content![0].content![0].text).toBe("合并格");
  });

  it("图片：走 uploadImage 并回填附件 URL 与宽度", async () => {
    const uploadImage = vi.fn().mockResolvedValue("att://uploaded.png");
    const result = await irToTiptap(ir([
      paragraph({ runs: [{ type: "image", src: "blob:abc", widthPt: 300, alt: "截图" }] }),
    ]), {
      uploadImage,
      fetchImageBytes: async () => ({ bytes: new Uint8Array(10), contentType: "image/png" }),
    });

    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(result.imageCount).toBe(1);
    expect(result.failedImageCount).toBe(0);
    const image = result.doc.content![0].content![0];
    expect(image.type).toBe("image");
    expect(image.attrs).toMatchObject({ src: "att://uploaded.png", alt: "截图", width: 400 });
  });

  it("图片上传失败降级为占位文本并计入 downgrades", async () => {
    const result = await irToTiptap(ir([
      paragraph({ runs: [{ type: "image", src: "blob:broken" }] }),
    ]), {
      uploadImage: vi.fn().mockRejectedValue(new Error("network down")),
      fetchImageBytes: async () => ({ bytes: new Uint8Array(5), contentType: "image/png" }),
    });

    expect(result.failedImageCount).toBe(1);
    expect(result.doc.content![0].content![0]).toMatchObject({ type: "text", text: "[图片]" });
    expect(result.downgrades.some((item) => item.kind === "image-failed")).toBe(true);
  });

  it("降级清单：段落底纹/缩进/间距、单元格底纹按类聚合计数", async () => {
    const result = await irToTiptap(ir([
      paragraph({ shading: "EEEEEE", indent: { left: 20 }, spacing: { before: 6 }, runs: [{ type: "run", text: "a" }] }),
      paragraph({ shading: "DDDDDD", runs: [{ type: "run", text: "b" }] }),
      { type: "table", rows: [{ type: "row", cells: [{ type: "cell", gridSpan: 1, rowSpan: 1, shading: "C0C0C0", body: [] }] }] },
    ]), { uploadImage: uploadOk });

    const byKind = new Map(result.downgrades.map((item) => [item.kind, item]));
    expect(byKind.get("paragraph-shading")?.count).toBe(2);
    expect(byKind.get("paragraph-indent")?.count).toBe(1);
    expect(byKind.get("paragraph-spacing")?.count).toBe(1);
    expect(byKind.get("cell-shading")?.count).toBe(1);
  });

  it("irPlainText 收集所有文本（含链接与表格单元格）", () => {
    const text = irPlainText(ir([
      paragraph({ runs: [{ type: "run", text: "前" }, { type: "hyperlink", href: "#", runs: [{ type: "run", text: "链" }] }] }),
      { type: "table", rows: [{ type: "row", cells: [{ type: "cell", gridSpan: 1, rowSpan: 1, body: [paragraph({ runs: [{ type: "run", text: "格" }] })] }] }] },
    ]));
    expect(text).toBe("前链格");
  });
});
