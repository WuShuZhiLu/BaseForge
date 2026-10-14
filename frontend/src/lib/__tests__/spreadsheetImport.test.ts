// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  csvRowsToSheetData,
  isSpreadsheetFileName,
  parseCsvRows,
  spreadsheetFileToSheetTargets,
} from "@/lib/spreadsheetImport";
import { createSheetXlsx } from "@/lib/sheetXlsx";
import { normalizeSheetData } from "@/lib/sheetModel";

describe("表格文件 → 轻量表格文档导入", () => {
  it("CSV 解析：引号字段内逗号/换行、双引号转义、CRLF、BOM", () => {
    expect(parseCsvRows('名称,备注\r\n"苹果,红","多行\n说明"\r\n"带""引号""",2\r\n')).toEqual([
      ["名称", "备注"],
      ["苹果,红", "多行\n说明"],
      ['带"引号"', "2"],
    ]);
    expect(parseCsvRows("\uFEFFa,b\n1,2\n\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("CSV 行矩阵 → SheetDataModel（单元格键、列字母标题）", () => {
    const data = csvRowsToSheetData([["名称", "数量"], ["苹果", "3"]]);
    const normalized = normalizeSheetData(data);
    expect(normalized.rows).toHaveLength(2);
    expect(normalized.columns).toHaveLength(2);
    expect(normalized.columns.map((c) => c.title)).toEqual(["A", "B"]);
    expect(normalized.cells["r0:c0"]).toBe("名称");
    expect(normalized.cells["r1:c1"]).toBe("3");
  });

  it("xlsx 文件（经 createSheetXlsx 往返）→ 按文件名命名单个表格目标", async () => {
    const sheetData = normalizeSheetData({
      version: 1,
      rows: [{ id: "r0", height: 24 }, { id: "r1", height: 24 }],
      columns: [
        { id: "c0", title: "名称", width: 100, type: "text", align: "left" },
        { id: "c1", title: "数量", width: 100, type: "text", align: "left" },
      ],
      cells: { "r0:c0": "苹果", "r0:c1": "3", "r1:c0": "香蕉", "r1:c1": "12" },
    });
    const bytes = await createSheetXlsx(sheetData, "导出");
    const file = new File([bytes as BlobPart], "库存表.xlsx");
    const targets = await spreadsheetFileToSheetTargets(file);
    expect(targets).toHaveLength(1);
    expect(targets[0].title).toBe("库存表");
    const normalized = normalizeSheetData(targets[0].data);
    expect(normalized.cells).toBeTruthy();
    expect(JSON.stringify(normalized)).toContain("苹果");
  });

  it("文件名过滤只接受 xlsx/csv", () => {
    expect(isSpreadsheetFileName("报表.XLSX")).toBe(true);
    expect(isSpreadsheetFileName("data.csv")).toBe(true);
    expect(isSpreadsheetFileName("notes.docx")).toBe(false);
  });
});
