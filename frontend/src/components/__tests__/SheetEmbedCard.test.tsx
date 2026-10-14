// @vitest-environment jsdom

import React from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSheet = vi.fn();
const saveSheet = vi.fn();

vi.mock("@/lib/sheetApi", () => ({
  getSheet: (...args: unknown[]) => getSheet(...args),
  saveSheet: (...args: unknown[]) => saveSheet(...args),
}));

// SheetGrid 用桩替身：记录最近一次 props（含 onChange），避免其内部交互依赖。
const gridProps: Array<{
  data: { cells: Record<string, string> };
  canEdit: boolean;
  onChange?: (recipe: (data: never) => never) => void;
}> = [];

vi.mock("@/components/SheetGrid", () => ({
  default: (props: { data: { cells: Record<string, string> }; canEdit: boolean; onChange?: unknown }) => {
    gridProps.push(props as { data: { cells: Record<string, string> }; canEdit: boolean });
    return (
      <div data-testid="sheet-grid-stub" data-can-edit={props.canEdit ? "1" : "0"}>
        {JSON.stringify(props.data.cells)}
      </div>
    );
  },
}));

import SheetEmbedCard, { buildSheetEmbedMarkdown, parseSheetEmbedHref } from "@/components/SheetEmbedCard";
import { normalizeSheetData } from "@/lib/sheetModel";

const UUID = "33333333-3333-4333-8333-333333333333";

function normalizeCells(cells: Record<string, string>) {
  return normalizeSheetData({
    version: 1,
    rows: [{ id: "r0", height: 24 }],
    columns: [
      { id: "c0", title: "A", width: 100, type: "text", align: "left" },
      { id: "c1", title: "B", width: 100, type: "text", align: "left" },
    ],
    cells,
  });
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  gridProps.length = 0;
});

function renderCard(href: string) {
  act(() => {
    root.render(<SheetEmbedCard href={href} />);
  });
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("SheetEmbedCard（![[sheet:id]] 嵌入卡片）", () => {
  it("parseSheetEmbedHref 只接受合法 uuid", () => {
    expect(parseSheetEmbedHref(`sheet:${UUID}`)).toBe(UUID);
    expect(parseSheetEmbedHref("sheet:not-a-uuid")).toBeNull();
    expect(parseSheetEmbedHref("mindmap:" + UUID)).toBeNull();
    expect(buildSheetEmbedMarkdown(UUID)).toBe(`![[sheet:${UUID}]]`);
  });

  it("加载成功后渲染标题与表格桩（可编辑）", async () => {
    getSheet.mockResolvedValue({
      title: "库存表",
      canEdit: true,
      updatedAt: "2026-10-14 10:00:00",
      data: normalizeCells({ "r0:c0": "苹果", "r0:c1": "3" }),
    });
    renderCard(`sheet:${UUID}`);
    await flush();
    expect(host.textContent).toContain("库存表");
    const grid = host.querySelector('[data-testid="sheet-grid-stub"]');
    expect(grid?.getAttribute("data-can-edit")).toBe("1");
    expect(grid?.textContent).toContain("苹果");
  });

  it("表格被删除时进入错误态（显示错误信息）", async () => {
    getSheet.mockRejectedValue(new Error("404"));
    renderCard(`sheet:${UUID}`);
    await flush();
    // 错误态显示错误消息；无消息时才回退到「表格不存在或已被删除」占位。
    expect(host.textContent).toContain("404");
  });

  it("打开按钮存在且点击不抛错", async () => {
    getSheet.mockResolvedValue({
      title: "T", canEdit: false, updatedAt: "u", data: normalizeCells({ "r0:c0": "x" }),
    });
    renderCard(`sheet:${UUID}`);
    await flush();
    const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("打开"));
    expect(button).toBeTruthy();
    expect(() => button!.click()).not.toThrow();
  });

  it("块内编辑经 saveSheet 乐观锁保存", async () => {
    getSheet.mockResolvedValue({
      title: "T", canEdit: true, updatedAt: "u1", data: normalizeCells({ "r0:c0": "旧" }),
    });
    saveSheet.mockResolvedValue({ updatedAt: "u2", canEdit: true, data: normalizeCells({ "r0:c0": "新" }), noteId: "n" });
    renderCard(`sheet:${UUID}`);
    await flush();

    const last = gridProps[gridProps.length - 1];
    expect(last).toBeTruthy();
    expect(last.onChange).toBeTruthy();
    await act(async () => {
      (last.onChange as unknown as (recipe: (data: { cells: Record<string, string> }) => { cells: Record<string, string> }) => void)(
        (data) => ({ ...data, cells: { ...data.cells, "r0:c0": "新" } }),
      );
      await Promise.resolve();
    });
    expect(saveSheet).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("新");
  });
});
