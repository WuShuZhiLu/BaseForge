import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  encryptedBlocksInContent,
  guardEncryptedBlockWriter,
  isEncryptedBlockLanguage,
  isProtectedNotePayload,
} from "../src/lib/encryptedNotes.js";
import { encryptedBlocksMigration } from "../src/db/encryptedBlocksMigration.js";

const objectId = "00112233-4455-4677-8899-aabbccddeeff";
const base64 = (bytes: number, seed = 0): string => Buffer.alloc(bytes, seed).toString("base64");
const envelope = {
  version: 1,
  algorithm: "AES-256-GCM",
  objectId,
  kind: "block",
  originalFormat: "markdown",
  kdf: { algorithm: "argon2id", version: 19, memoryKiB: 65536, iterations: 3, parallelism: 4, salt: base64(16, 1) },
  wrappedKey: { iv: base64(12, 2), ciphertext: base64(48, 3) },
  payload: { iv: base64(12, 4), ciphertext: base64(32, 5) },
};
const payload = JSON.stringify(envelope);

test("旧 nowen-encrypted 围栏语言在加密块识别中与新名同等对待", () => {
  assert.equal(isEncryptedBlockLanguage("nowen-encrypted-v1"), true);
  assert.equal(isEncryptedBlockLanguage("baseforge-encrypted-v1"), true);
  assert.equal(isEncryptedBlockLanguage("javascript"), false);

  const markdown = `# 标题\n\`\`\`nowen-encrypted-v1\n${payload}\n\`\`\`\n`;
  const markdownBlocks = encryptedBlocksInContent(markdown, "markdown");
  assert.equal(markdownBlocks.length, 1);
  assert.equal(markdownBlocks[0].objectId, objectId);

  const tiptap = JSON.stringify({ type: "doc", content: [{ type: "codeBlock", attrs: { language: "nowen-encrypted-v1" }, content: [{ type: "text", text: payload }] }] });
  const tiptapBlocks = encryptedBlocksInContent(tiptap, "tiptap-json");
  assert.equal(tiptapBlocks.length, 1);
  assert.equal(tiptapBlocks[0].objectId, objectId);
});

test("旧围栏内容触发写保护：缺少 encryptedBlocksVersion 时拒绝", () => {
  const markdown = `\`\`\`nowen-encrypted-v1\n${payload}\n\`\`\``;
  const current = { content: markdown, contentFormat: "markdown" };
  assert.throws(() => guardEncryptedBlockWriter({ content: "plain text", contentFormat: "markdown" }, current), /ENCRYPTED_NOTE|加密/);
  assert.equal(guardEncryptedBlockWriter({ content: "plain text", contentFormat: "markdown", encryptedBlocksVersion: 1 }, current), true);
});

test("isProtectedNotePayload 兜底正则同时识别新旧前缀", () => {
  assert.equal(isProtectedNotePayload({ content: "```nowen-encrypted-v1\nbroken residue\n```", contentFormat: "markdown" }), true);
  assert.equal(isProtectedNotePayload({ content: "```baseforge-encrypted-v1\nbroken residue\n```", contentFormat: "markdown" }), true);
  assert.equal(isProtectedNotePayload({ content: "normal note", contentFormat: "markdown" }), false);
});

test("加密块写保护触发器对 nowen-encrypted 内容生效", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT NOT NULL, contentFormat TEXT NOT NULL);`);
  encryptedBlocksMigration.up(db as never);
  db.exec(`INSERT INTO notes (id, content, contentFormat) VALUES ('n1', 'plain', 'markdown');`);
  assert.throws(() => {
    db.exec(`UPDATE notes SET content = 'x nowen-encrypted-v1 y' WHERE id = 'n1';`);
  }, /ENCRYPTED_BLOCK_WRITE_FORBIDDEN/);
  assert.throws(() => {
    db.exec(`UPDATE notes SET content = 'x baseforge-encrypted-v1 y' WHERE id = 'n1';`);
  }, /ENCRYPTED_BLOCK_WRITE_FORBIDDEN/);
  db.exec(`UPDATE notes SET content = 'still plain' WHERE id = 'n1';`);
});
