import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 给 DatabaseSync 补齐 better-sqlite3 兼容能力（transaction / pragma / backup、
// 行对象转普通对象、参数归一化）。生产入口 schema.ts 也会引入它；测试进程
// 走 `--import ./tests/setup-db-isolation.ts` 提前挂上，内存库测试才有一致行为。
import "../src/db/sqlite-ext.js";

const STATE_KEY = Symbol.for("nowen-note.backend-test-db-isolation");
const globalState = globalThis as typeof globalThis & {
  [STATE_KEY]?: { directory: string };
};

if (!globalState[STATE_KEY]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nowen-note-test-${process.pid}-`));
  globalState[STATE_KEY] = { directory };
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(directory, "test.db");
  process.env.ELECTRON_USER_DATA = directory;

  process.once("exit", () => {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Process shutdown must not hide the original test result.
    }
  });
}
