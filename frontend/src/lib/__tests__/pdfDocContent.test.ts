// pdfDocContent 内容模型单测：解析容错、往返序列化、contentText 派生与批注创建。
import { describe, expect, it } from "vitest";
import {
  createPdfAnnotation,
  parsePdfDocContent,
  pdfAnnotationLabel,
  pdfDocContentText,
  resolvePdfAnnotationKind,
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

  it("几何标注的 kind / rects / points / color 能往返，坐标被钳制到 0–1", () => {
    const highlight = createPdfAnnotation(2, "", "原文", {
      kind: "highlight",
      rects: [{ x: 0.1, y: -0.2, w: 0.3, h: 1.4 }],
      color: "blue",
    });
    const ink = createPdfAnnotation(2, "", undefined, {
      kind: "ink",
      points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.6 }],
      color: "red",
      strokeWidth: 0.004,
    });
    const restored = parsePdfDocContent(serializePdfDocContent({
      attachmentId: "att-1",
      annotations: [highlight, ink],
    }));
    expect(restored.annotations[0]).toMatchObject({
      kind: "highlight",
      color: "blue",
      rects: [{ x: 0.1, y: 0, w: 0.3, h: 1 }],
    });
    expect(restored.annotations[1]).toMatchObject({
      kind: "ink",
      color: "red",
      strokeWidth: 0.004,
    });
    expect(restored.annotations[1].points).toHaveLength(2);
  });

  it("老数据没有 kind：有 rects 视为高亮，只有文字视为批注", () => {
    const legacy = parsePdfDocContent(JSON.stringify({
      attachmentId: "att-1",
      annotations: [
        { id: "a", page: 1, text: "老批注", createdAt: "2026-01-01 00:00:00", updatedAt: "2026-01-01 00:00:00" },
        {
          id: "b", page: 2, text: "", createdAt: "2026-01-01 00:00:00", updatedAt: "2026-01-01 00:00:00",
          rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }],
        },
      ],
    }));
    expect(resolvePdfAnnotationKind(legacy.annotations[0])).toBe("note");
    expect(resolvePdfAnnotationKind(legacy.annotations[1])).toBe("highlight");
  });

  it("图形标注没有正文时给一句可读描述", () => {
    expect(pdfAnnotationLabel(createPdfAnnotation(1, "", undefined, { kind: "ink", points: [{ x: 0, y: 0 }, { x: 0.1, y: 0.1 }] }))).toBe("手绘笔迹");
    expect(pdfAnnotationLabel(createPdfAnnotation(1, "", undefined, { kind: "rect", rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }))).toBe("矩形标注");
    expect(pdfAnnotationLabel(createPdfAnnotation(1, "说明"))).toBe("说明");
  });
});
