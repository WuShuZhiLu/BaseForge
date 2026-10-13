// 上游 1.5.1 的 UI 结构契约测试：断言的是上游那套界面结构（DOM 属性 / 文案 / 组件组成）。
// 本仓走「UI 保留自有」，结构与我们的界面不一致，属**不跟**的用例 —— 断言原样保留（未改写），
// 仅跳过执行；将来若确实采用上游该 UI，把下面的 .skip 去掉即可恢复。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/EditorPane.tsx", "utf8");

describe.skip("editor outline entry", () => {
  it("exposes the desktop outline toggle in the outer toolbar", () => {
    const outlineIndex = source.indexOf('data-editor-outline-toggle="desktop-toolbar"');
    const moreMenuIndex = source.indexOf('data-editor-more-menu="desktop"');

    expect(outlineIndex).toBeGreaterThan(-1);
    expect(moreMenuIndex).toBeGreaterThan(outlineIndex);
    expect(source).toContain('aria-pressed={showDesktopOutline}');
  });

  it("does not keep the desktop outline action inside the more menu", () => {
    expect(source).not.toContain("setShowOutline(!showOutline)");
    expect(source.match(/data-editor-outline-toggle=/g)).toHaveLength(1);
  });
});
