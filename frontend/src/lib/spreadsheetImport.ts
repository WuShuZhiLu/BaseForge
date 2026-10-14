import { knowledgeTreeApi } from "@/lib/knowledgeTreeApi";
import {
  parseWorkbookXlsx,
  workbookSheetToImport,
  type WorkbookPreviewModel,
} from "@/lib/sheetXlsx";
import { normalizeSheetData, type SheetDataModel } from "@/lib/sheetModel";

/**
 * 表格文件（xlsx / csv）→ **轻量表格文档**（sheet 节点）导入。
 *
 * 与附件预览的「导入为轻量表格」同一数据链路（workbookSheetToImport →
 * knowledgeTreeApi.create({ nodeType: "sheet", sheetData })）——表格数据进
 * 表格编辑器，可继续编辑，而不是降级成 md 死文本。
 *
 * 多工作表策略：每个工作表各建一个独立的轻量表格文档
 * （单工作表 = 常见情形，命名即文件名；多工作表命名为「文件名 · 表名」）。
 */

export const SPREADSHEET_IMPORT_ACCEPT = ".xlsx,.csv";
export const SPREADSHEET_IMPORT_LIMITS = { fileBytes: 20 * 1024 * 1024, rows: 1000, columns: 60 };

export function isSpreadsheetFileName(name: string): boolean {
  return /\.(xlsx|csv)$/i.test(name || "");
}

export function pickSpreadsheetFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = SPREADSHEET_IMPORT_ACCEPT;
    input.multiple = false;
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** 简易 CSV 解析：支持双引号转义、字段内逗号/换行、CRLF、BOM。 */
export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const text = csvText.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

/** 行矩阵 → SheetDataModel（列标题用默认字母序，数据行全部保留）。 */
export function csvRowsToSheetData(rows: string[][]): SheetDataModel {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const colLetter = (index: number): string => {
    let label = "";
    let n = index;
    do { label = String.fromCharCode(65 + (n % 26)) + label; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return label;
  };
  return normalizeSheetData({
    version: 1,
    rows: rows.map((_, i) => ({ id: `r${i}`, height: 24 })),
    columns: Array.from({ length: width }, (_, i) => ({
      id: `c${i}`,
      title: colLetter(i),
      width: 120,
      type: "text",
      align: "left",
    })),
    cells: Object.fromEntries(
      rows.flatMap((row, ri) => row.map((value, ci) => [`r${ri}:c${ci}`, value])),
    ),
  });
}

export interface SpreadsheetImportTarget {
  title: string;
  data: SheetDataModel;
}

/** 文件 → 待创建的轻量表格列表（每个工作表一个）。 */
export async function spreadsheetFileToSheetTargets(file: File): Promise<SpreadsheetImportTarget[]> {
  if (file.size > SPREADSHEET_IMPORT_LIMITS.fileBytes) {
    throw new Error(`文件超过 ${Math.round(SPREADSHEET_IMPORT_LIMITS.fileBytes / 1024 / 1024)}MB 限制`);
  }
  const baseName = file.name.replace(/\.(xlsx|csv)$/i, "") || "表格导入";
  if (/\.csv$/i.test(file.name)) {
    const data = csvRowsToSheetData(parseCsvRows(await file.text()));
    return [{ title: baseName, data }];
  }
  const workbook: WorkbookPreviewModel = await parseWorkbookXlsx(file);
  if (workbook.sheets.length === 1) {
    return [{ title: baseName, data: workbookSheetToImport(workbook.sheets[0].data) }];
  }
  return workbook.sheets.map((sheet) => ({
    title: `${baseName} · ${sheet.name}`,
    data: workbookSheetToImport(sheet.data),
  }));
}

export interface SpreadsheetImportResult {
  /** 创建的轻量表格树节点（resourceId 用于跳转表格编辑器）。 */
  created: Array<{ nodeId: string; resourceId: string; title: string }>;
  /** 多工作表时提示用户「仅导入了 N 个工作表」之类的信息。 */
  note?: string;
}

/** 导入：每个工作表创建一个轻量表格文档。失败时回滚本次已创建的节点。 */
export async function importSpreadsheetFileAsSheets(
  file: File,
  parentId: string | null,
): Promise<SpreadsheetImportResult> {
  const targets = await spreadsheetFileToSheetTargets(file);
  const created: SpreadsheetImportResult["created"] = [];
  try {
    for (const target of targets) {
      const node = await knowledgeTreeApi.create({
        parentId,
        nodeType: "sheet",
        title: target.title,
        sheetData: target.data,
      });
      created.push({ nodeId: node.id, resourceId: node.resourceId, title: target.title });
    }
  } catch (error) {
    for (const item of created) {
      await knowledgeTreeApi.remove(item.nodeId, "subtree").catch(() => undefined);
    }
    throw error;
  }
  return {
    created,
    note: targets.length > 1 ? `工作表较多，已按工作表拆分为 ${targets.length} 个表格文档` : undefined,
  };
}
