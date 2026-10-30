/**
 * 版本对比服务（v134）
 *
 * 后端负责取两个版本的内容并产出统一的行级差异数据结构，前端只做渲染。
 * diff 基于 contentText（纯文本行序列）；contentText 缺失时回退 content。
 * 算法：公共前/后缀修剪 + 中段 LCS（O(n*m)，规模超限时退化为整段删除+插入）。
 */

import { getDb } from "../db/schema";
import { noteVersionsRepository } from "../repositories/noteVersionsRepository";
import type { NoteVersionRecord, VersionSource } from "../repositories/noteVersionsRepository";

export interface VersionDiffRow {
  type: "equal" | "add" | "remove";
  text: string;
  /** 该行在 A（旧版本）中的行号（1 起），新增行无 */
  oldLine: number | null;
  /** 该行在 B（新版本）中的行号（1 起），删除行无 */
  newLine: number | null;
}

export interface VersionDiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

export interface VersionDiffMeta {
  id: string;
  version: number;
  title: string | null;
  createdAt: string;
  source: VersionSource;
  kind: VersionSource;
  label: string | null;
  contentFormat: string;
  contentBytes: number;
}

export interface VersionDiffResult {
  a: VersionDiffMeta;
  b: VersionDiffMeta;
  rows: VersionDiffRow[];
  stats: VersionDiffStats;
}

export type BuildVersionDiffOutcome =
  | { status: "ok"; diff: VersionDiffResult }
  | { status: "not_found"; missing: "a" | "b" }
  | { status: "cross_note"; offender: "a" | "b" };

type Op = { type: "equal" | "remove" | "add"; text: string };

/** 中段 LCS 产出行操作序列；单元格数超上限时退化为先删后加（保证可用性）。 */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ type: "add" as const, text }));
  if (m === 0) return a.map((text) => ({ type: "remove" as const, text }));
  if (n * m > 4_000_000) {
    return [
      ...a.map((text) => ({ type: "remove" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
  }
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "remove", text: a[i] });
      i += 1;
    } else {
      ops.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < n) { ops.push({ type: "remove", text: a[i] }); i += 1; }
  while (j < m) { ops.push({ type: "add", text: b[j] }); j += 1; }
  return ops;
}

/** 行级 diff：公共前缀/后缀直接判等，仅中段走 LCS。 */
export function diffLines(aText: string, bText: string): VersionDiffRow[] {
  const a = aText.split("\n");
  const b = bText.split("\n");
  const rows: VersionDiffRow[] = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    rows.push({ type: "equal", text: a[start], oldLine: start + 1, newLine: start + 1 });
    start += 1;
  }

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  let oldLine = start;
  let newLine = start;
  for (const op of lcsOps(a.slice(start, endA), b.slice(start, endB))) {
    if (op.type === "equal") {
      oldLine += 1;
      newLine += 1;
      rows.push({ type: "equal", text: op.text, oldLine, newLine });
    } else if (op.type === "remove") {
      oldLine += 1;
      rows.push({ type: "remove", text: op.text, oldLine, newLine: null });
    } else {
      newLine += 1;
      rows.push({ type: "add", text: op.text, oldLine: null, newLine });
    }
  }

  for (let k = endA; k < a.length; k += 1) {
    oldLine += 1;
    newLine += 1;
    rows.push({ type: "equal", text: a[k], oldLine, newLine });
  }
  return rows;
}

function toDiffText(record: NoteVersionRecord): string {
  if (record.contentText !== null && record.contentText !== undefined) return record.contentText;
  return record.content ?? "";
}

function toDiffMeta(record: NoteVersionRecord): VersionDiffMeta {
  return {
    id: record.id,
    version: record.version,
    title: record.title,
    createdAt: record.createdAt,
    source: record.source,
    kind: record.kind,
    label: record.label,
    contentFormat: record.contentFormat,
    contentBytes: Buffer.byteLength(record.content ?? "", "utf8"),
  };
}

/**
 * 构建同一笔记两个版本的行级差异。
 * - 版本不存在 → not_found（路由 404）；
 * - 版本存在但不属于该笔记（跨笔记）→ cross_note（路由 400）；
 * - aId === bId → 返回全等 diff（rows 全 equal），不视为错误。
 */
export function buildVersionDiff(noteId: string, aId: string, bId: string): BuildVersionDiffOutcome {
  const db = getDb();
  const resolve = (id: string) => {
    const record = noteVersionsRepository.getByIdAndNoteId(id, noteId);
    if (record) return record;
    const owner = db.prepare('SELECT "noteId" FROM note_versions WHERE id = ?').get(id) as
      | { noteId: string }
      | undefined;
    return owner ? "cross_note" : "not_found";
  };

  const a = resolve(aId);
  if (a === "not_found") return { status: "not_found", missing: "a" };
  if (a === "cross_note") return { status: "cross_note", offender: "a" };
  const b = resolve(bId);
  if (b === "not_found") return { status: "not_found", missing: "b" };
  if (b === "cross_note") return { status: "cross_note", offender: "b" };

  const rows = diffLines(toDiffText(a), toDiffText(b));
  const stats: VersionDiffStats = { added: 0, removed: 0, unchanged: 0 };
  for (const row of rows) {
    if (row.type === "add") stats.added += 1;
    else if (row.type === "remove") stats.removed += 1;
    else stats.unchanged += 1;
  }
  return { status: "ok", diff: { a: toDiffMeta(a), b: toDiffMeta(b), rows, stats } };
}
