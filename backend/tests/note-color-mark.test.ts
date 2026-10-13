import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-color-mark-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "color-mark-owner";
const notebookId = "color-mark-notebook";
let db: Database.Database;
let closeDb: () => void;
let app: Hono;

test.before(async () => {
  const schema = await import("../src/db/schema");
  const notesRoute = await import("../src/routes/notes");
  db = schema.getDb();
  closeDb = schema.closeDb;
  app = new Hono();
  app.route("/api/notes", notesRoute.default);
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(owner, owner, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(notebookId, owner, "Color Mark");
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createNote(title: string): Promise<string> {
  const response = await app.request("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": owner },
    body: JSON.stringify({ notebookId, title, content: "# body\n", contentFormat: "markdown" }),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { id: string }).id;
}

function storedColorMark(noteId: string): string | null {
  const row = db.prepare("SELECT colorMark FROM notes WHERE id = ?").get(noteId) as
    | { colorMark: string | null }
    | undefined;
  return row?.colorMark ?? null;
}

test("PUT /notes/:id persists the color mark and returns it", async () => {
  const noteId = await createNote("Colors");

  const update = await app.request(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-User-Id": owner },
    body: JSON.stringify({ colorMark: "blue" }),
  });
  assert.equal(update.status, 200);
  const updated = (await update.json()) as { colorMark?: string | null };
  assert.equal(updated.colorMark, "blue");
  assert.equal(storedColorMark(noteId), "blue");

  const read = await app.request(`/api/notes/${noteId}`, {
    headers: { "X-User-Id": owner },
  });
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { colorMark?: string | null }).colorMark, "blue");

  const list = await app.request(`/api/notes?notebookId=${notebookId}`, {
    headers: { "X-User-Id": owner },
  });
  assert.equal(list.status, 200);
  const notes = (await list.json()) as Array<{ id: string; colorMark?: string | null }>;
  const listed = notes.find((note) => note.id === noteId);
  assert.equal(listed?.colorMark, "blue");
});

test("PUT /notes/:id clears the color mark with null", async () => {
  const noteId = await createNote("Clear color");
  await app.request(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-User-Id": owner },
    body: JSON.stringify({ colorMark: "red" }),
  });
  assert.equal(storedColorMark(noteId), "red");

  const cleared = await app.request(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-User-Id": owner },
    body: JSON.stringify({ colorMark: null }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(storedColorMark(noteId), null);
});

test("PUT /notes/:id rejects an unknown color mark", async () => {
  const noteId = await createNote("Invalid color");
  const response = await app.request(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-User-Id": owner },
    body: JSON.stringify({ colorMark: "chartreuse" }),
  });
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { code?: string };
  assert.equal(payload.code, "INVALID_NOTE_COLOR_MARK");
  assert.equal(storedColorMark(noteId), null);
});

test("POST /notes accepts an initial color mark", async () => {
  const response = await app.request("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": owner },
    body: JSON.stringify({
      notebookId,
      title: "Created with color",
      content: "# body\n",
      contentFormat: "markdown",
      colorMark: "green",
    }),
  });
  assert.equal(response.status, 201);
  const created = (await response.json()) as { id: string; colorMark?: string | null };
  assert.equal(created.colorMark, "green");
  assert.equal(storedColorMark(created.id), "green");
});
