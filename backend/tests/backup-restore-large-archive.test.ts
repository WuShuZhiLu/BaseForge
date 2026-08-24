import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import JSZip from "jszip";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-large-restore-"));
const backupDir = path.join(tmpDir, "backups");
const dbPath = path.join(tmpDir, "nowen-note.db");
const markerKey = "backup-large-restore:marker";
const userId = "large-restore-user";

process.env.DB_PATH = dbPath;
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.BACKUP_DIR = backupDir;

let getDb: typeof import("../src/db/schema").getDb;
let closeDb: typeof import("../src/db/schema").closeDb;
let getDbSchemaVersion: typeof import("../src/db/schema").getDbSchemaVersion;
let manager: import("../src/services/backup").BackupManager;

function resetDb(marker: string): void {
  closeDb?.();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(userId, userId, "hash");
  db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)")
    .run(markerKey, marker);
}

function resetFiles(): void {
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of ["attachments", "fonts", "plugins"]) {
    const dir = path.join(tmpDir, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "old.txt"), `old-${name}`, "utf8");
  }
  fs.writeFileSync(path.join(tmpDir, ".jwt_secret"), "old-secret", "utf8");
}

function readMarker(): string | undefined {
  const row = getDb().prepare("SELECT value FROM system_settings WHERE key = ?")
    .get(markerKey) as { value?: string } | undefined;
  return row?.value;
}

async function writeFullBackup(filename: string): Promise<string> {
  const snapshot = path.join(backupDir, `snapshot-${crypto.randomUUID()}.db`);
  await getDb().backup(snapshot);
  const snapshotDb = new Database(snapshot);
  try {
    snapshotDb.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)")
      .run(markerKey, "backup");
  } finally {
    snapshotDb.close();
  }

  const zip = new JSZip();
  zip.file("meta.json", JSON.stringify({
    formatVersion: 2,
    schemaVersion: getDbSchemaVersion(),
    createdAt: new Date().toISOString(),
    tables: { users: 1, system_settings: 1 },
    files: {
      attachments: { count: 1, bytes: 3 },
      fonts: { count: 1, bytes: 3 },
      plugins: { count: 1, bytes: 3 },
    },
  }));
  zip.file("db.sqlite", fs.readFileSync(snapshot));
  zip.folder("attachments")?.file("new.txt", "new");
  zip.folder("fonts")?.file("new.txt", "new");
  zip.folder("plugins")?.file("new.txt", "new");
  zip.file(".jwt_secret", "new-secret");

  const target = path.join(backupDir, filename);
  fs.writeFileSync(target, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  fs.rmSync(snapshot, { force: true });
  return target;
}

test.before(async () => {
  const schemaModule = await import("../src/db/schema");
  const backupModule = await import("../src/services/backup");
  await import("../src/runtime/backup-restore-large-archive");
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  getDbSchemaVersion = schemaModule.getDbSchemaVersion;
  manager = new backupModule.BackupManager();
});

test.beforeEach(() => {
  fs.rmSync(backupDir, { recursive: true, force: true });
  resetFiles();
  resetDb("current");
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("full ZIP dry-run and restore never read the whole archive into a Buffer", async () => {
  const filename = "streaming-full.zip";
  const archivePath = await writeFullBackup(filename);
  const originalReadFileSync = fs.readFileSync;

  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file !== "number" && path.resolve(String(file)) === path.resolve(archivePath)) {
      throw new Error("whole archive read is forbidden");
    }
    return (originalReadFileSync as (...params: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync;

  try {
    const preview = await manager.restoreFromBackup(filename, { dryRun: true });
    assert.equal(preview.success, true);
    assert.equal(readMarker(), "current", "dry-run must not modify the live database");

    const restored = await manager.restoreFromBackup(filename, { dryRun: false });
    assert.equal(restored.success, true);
    assert.equal(readMarker(), "backup");
    assert.equal(fs.readFileSync(path.join(tmpDir, "attachments", "new.txt"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(tmpDir, "fonts", "new.txt"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(tmpDir, "plugins", "new.txt"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(tmpDir, ".jwt_secret"), "utf8"), "new-secret");
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});
