// PDF 标注几何换算单测：归一化、裁剪、同行合并、命中判定。
import { describe, expect, it } from "vitest";
import {
  mergeSiblingRects,
  normPolylineDistance,
  normRectHitTest,
  pixelPointToNorm,
  pixelRectToNorm,
} from "../pdfAnnotationGeometry";

const page = { left: 100, top: 50, width: 400, height: 800 };

describe("pdfAnnotationGeometry", () => {
  it("像素矩形归一化：按页面尺寸换算并四舍五入", () => {
    expect(pixelRectToNorm({ left: 200, top: 250, width: 100, height: 80 }, page)).toEqual({
      x: 0.25,
      y: 0.25,
      w: 0.25,
      h: 0.1,
    });
  });

  it("超出页面的部分被裁掉，完全在外面的返回 null", () => {
    // 左边界溢出 100px、下边界也未进入页面 → 高度为 0，视为无有效区域
    expect(pixelRectToNorm({ left: 0, top: 0, width: 200, height: 50 }, page)).toBeNull();
    // 跨页面左边界：从页面左沿开始，右侧被裁
    expect(pixelRectToNorm({ left: 0, top: 250, width: 200, height: 80 }, page)).toEqual({
      x: 0,
      y: 0.25,
      w: 0.25,
      h: 0.1,
    });
    expect(pixelRectToNorm({ left: 0, top: 0, width: 50, height: 40 }, page)).toBeNull();
  });

  it("像素点归一化并钳制到 0–1", () => {
    expect(pixelPointToNorm({ clientX: 300, clientY: 450 }, page)).toEqual({ x: 0.5, y: 0.5 });
    expect(pixelPointToNorm({ clientX: 0, clientY: 0 }, page)).toEqual({ x: 0, y: 0 });
  });

  it("同一行的碎片合并成一条，不同行保持分开", () => {
    const merged = mergeSiblingRects([
      { x: 0.1, y: 0.2, w: 0.1, h: 0.02 },
      { x: 0.21, y: 0.2, w: 0.1, h: 0.02 },
      { x: 0.1, y: 0.3, w: 0.2, h: 0.02 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ x: 0.1, y: 0.2, w: 0.21, h: 0.02 });
    expect(merged[1].y).toBeCloseTo(0.3, 4);
  });

  it("矩形命中测试带容差", () => {
    const rect = { x: 0.2, y: 0.3, w: 0.4, h: 0.1 };
    expect(normRectHitTest(rect, { x: 0.4, y: 0.35 })).toBe(true);
    // 右边界 0.6，容差 0.004 内仍算命中
    expect(normRectHitTest(rect, { x: 0.603, y: 0.35 })).toBe(true);
    expect(normRectHitTest(rect, { x: 0.61, y: 0.35 })).toBe(false);
  });

  it("折线距离按页面比例修正横向拉伸", () => {
    const line = [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }];
    // 竖直角距离 0.02
    expect(normPolylineDistance(line, { x: 0.5, y: 0.52 }, 1)).toBeCloseTo(0.02, 4);
    // aspect=2 时 x 方向被拉长，竖向距离仍然是 0.02
    expect(normPolylineDistance(line, { x: 0.5, y: 0.52 }, 2)).toBeCloseTo(0.02, 4);
    // 远端点的距离
    expect(normPolylineDistance(line, { x: 1.2, y: 0.5 }, 1)).toBeCloseTo(0.2, 4);
  });
});
