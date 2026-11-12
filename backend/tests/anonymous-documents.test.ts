import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  extractEmbeddedDocumentIds,
  findOrphanAnonymousNoteIds,
} from "../src/services/anonymousDocuments";

function sqliteTimestampHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      content TEXT,
      isUnlisted INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    )
  `);
  return db;
}

function insertNote(
  db: DatabaseSync,
  id: string,
  options: { content?: string | null; unlisted?: boolean; hoursAgo?: number } = {},
): void {
  db.prepare("INSERT INTO notes (id, content, isUnlisted, createdAt) VALUES (?, ?, ?, ?)").run(
    id,
    options.content ?? null,
    options.unlisted ? 1 : 0,
    sqliteTimestampHoursAgo(options.hoursAgo ?? 0),
  );
}

const BOARD_A = "11111111-1111-4111-8111-111111111111";
const BOARD_B = "22222222-2222-4222-8222-222222222222";
const BOARD_C = "33333333-3333-4333-8333-333333333333";
const BOARD_D = "44444444-4444-4444-8444-444444444444";

test("extractEmbeddedDocumentIds dedupes board/mindmap/sheet refs", () => {
  // sheet 匿名表格纳入 GC 引用扫描（与 board/mindmap 同权）。
  const SHEET_E = "55555555-5555-4555-8555-555555555555";
  const ids = extractEmbeddedDocumentIds([
    `![[board:${BOARD_A}]]`,
    `![[mindmap:${BOARD_B.toUpperCase()}]]`,
    `![[board:${BOARD_A}]]`,
    `![[sheet:${SHEET_E}]]`,
    "board:not-a-uuid",
  ].join("\n"));

  assert.deepEqual(ids.sort(), [BOARD_A, BOARD_B, SHEET_E].sort());
});

test("extractEmbeddedDocumentIds tolerates empty content", () => {
  assert.deepEqual(extractEmbeddedDocumentIds(null), []);
  assert.deepEqual(extractEmbeddedDocumentIds(""), []);
});

test("findOrphanAnonymousNoteIds follows references transitively from owned notes", () => {
  const db = createDb();
  insertNote(db, "host", {
    content: `![[board:${BOARD_A}]]`,
    hoursAgo: 48,
  });
  // A 引用 B：只要宿主可达，B 也算被引用。
  insertNote(db, BOARD_A, {
    content: `![[board:${BOARD_B}]]`,
    unlisted: true,
    hoursAgo: 48,
  });
  insertNote(db, BOARD_B, { unlisted: true, hoursAgo: 48 });
  // D 没有任何引用，且超过宽限期 → 孤儿。
  insertNote(db, BOARD_D, { unlisted: true, hoursAgo: 48 });

  assert.deepEqual(findOrphanAnonymousNoteIds(db), [BOARD_D]);
  db.close();
});

test("findOrphanAnonymousNoteIds keeps documents inside the grace period", () => {
  const db = createDb();
  insertNote(db, BOARD_A, { unlisted: true, hoursAgo: 23 });

  assert.deepEqual(findOrphanAnonymousNoteIds(db), []);
  assert.deepEqual(findOrphanAnonymousNoteIds(db, { graceHours: 1 }), [BOARD_A]);
  db.close();
});

test("findOrphanAnonymousNoteIds treats trashed hosts as referrers", () => {
  const db = createDb();
  insertNote(db, "trashed-host", {
    content: `![[board:${BOARD_A}]]`,
    hoursAgo: 48,
  });
  insertNote(db, BOARD_A, { unlisted: true, hoursAgo: 48 });

  assert.deepEqual(findOrphanAnonymousNoteIds(db), []);
  db.close();
});

test("findOrphanAnonymousNoteIds collects unreachable anonymous cycles", () => {
  const db = createDb();
  insertNote(db, BOARD_A, {
    content: `![[board:${BOARD_B}]]`,
    unlisted: true,
    hoursAgo: 48,
  });
  insertNote(db, BOARD_B, {
    content: `![[board:${BOARD_A}]]`,
    unlisted: true,
    hoursAgo: 48,
  });

  assert.deepEqual(findOrphanAnonymousNoteIds(db).sort(), [BOARD_A, BOARD_B].sort());
  db.close();
});

test("findOrphanAnonymousNoteIds ignores unknown referenced ids", () => {
  const db = createDb();
  insertNote(db, "host", { content: `![[board:${BOARD_C}]]`, hoursAgo: 48 });
  insertNote(db, BOARD_D, { unlisted: true, hoursAgo: 48 });

  assert.deepEqual(findOrphanAnonymousNoteIds(db), [BOARD_D]);
  db.close();
});
