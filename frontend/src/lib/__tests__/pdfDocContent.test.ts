// pdfDocContent 内容模型单测：解析容错、往返序列化、contentText 派生与批注创建。
import { describe, expect, it } from "vitest";
import {
  createPdfAnnotation,
  parsePdfDocContent,
  pdfDocContentText,
  serializePdfDocContent,
} from "../pdfDocContent";

describe("pdfDocContent", () => {
  it("解析容错：空串/坏 JSON/字段缺失都退化为空模型", () => {
    expect(parsePdfDocContent("")).toEqual({ attachmentId: null, annotations: [] });
    expect(parsePdfDocContent("not-json")).toEqual({ attachmentId: null, annotations: [] });
    expect(parsePdfDocContent('{"attachmentId":"att-1"}').annotations).toEqual([]);
    expect(parsePdfDocContent('{"attachmentId":"","annotations":"bad"}').attachmentId).toBeNull();
  });

  it("往返序列化保留 attachmentId 与批注", () => {
    const doc = {
      attachmentId: "att-1",
      annotations: [createPdfAnnotation(3, "这一段是结论", "结论：……")],
    };
    const restored = parsePdfDocContent(serializePdfDocContent(doc));
    expect(restored.attachmentId).toBe("att-1");
    expect(restored.annotations[0]).toMatchObject({ page: 3, text: "这一段是结论", quote: "结论：……" });
  });

  it("contentText 派生：quote + text 合并、规范化空白", () => {
    const doc = {
      attachmentId: "att-1",
      annotations: [
        { ...createPdfAnnotation(1, "第二段  批注"), quote: "原文摘录" },
        createPdfAnnotation(2, "另一页"),
      ],
    };
    expect(pdfDocContentText(doc)).toBe("原文摘录 第二段 批注 另一页");
  });

  it("createPdfAnnotation 页码钳制到正整数并带时间戳", () => {
    const annotation = createPdfAnnotation(0, "x");
    expect(annotation.page).toBe(1);
    expect(annotation.id).toBeTruthy();
    expect(annotation.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(annotation.createdAt).toBe(annotation.updatedAt);
  });
});
