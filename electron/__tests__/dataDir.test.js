const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  FIRST_RUN_DATA_MARKERS,
  adoptLegacyDatabase,
  getDefaultDataPath,
  getDataDirPointerPath,
  getUserDataPathFromRoot,
  migrateLegacyDataDir,
  migrateLegacyUserDataRoot,
  shouldPromptDataDirOnFirstRun,
  writeCustomDataDir,
  validateMigrationTarget,
} = require("../dataDir");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baseforge-data-dir-"));
}

test("uses the default baseforge-data directory when no pointer exists", () => {
  const root = tempRoot();

  assert.equal(getUserDataPathFromRoot(root), path.join(root, "baseforge-data"));
});

test("reads a valid custom data directory from the bootstrap pointer", () => {
  const root = tempRoot();
  const custom = path.join(root, "custom data");
  fs.mkdirSync(custom, { recursive: true });

  writeCustomDataDir(root, custom);

  assert.equal(getDataDirPointerPath(root), path.join(root, "baseforge-data-location.json"));
  assert.equal(getUserDataPathFromRoot(root), custom);
});

test("renames the legacy data directory and pointer to the new names", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "nowen-data"), { recursive: true });
  fs.writeFileSync(path.join(root, "nowen-data-location.json"), "{}");

  migrateLegacyDataDir(root);

  assert.ok(fs.existsSync(path.join(root, "baseforge-data")));
  assert.ok(fs.existsSync(path.join(root, "baseforge-data-location.json")));
  assert.equal(fs.existsSync(path.join(root, "nowen-data")), false);
});

test("migrates the legacy user data root directory name", () => {
  const appDataRoot = tempRoot();
  fs.mkdirSync(path.join(appDataRoot, "nowen-note", "nowen-data"), { recursive: true });
  fs.writeFileSync(
    path.join(appDataRoot, "nowen-note", "nowen-data-location.json"),
    "{}",
    "utf8",
  );

  const migratedRoot = migrateLegacyUserDataRoot(appDataRoot);

  assert.equal(migratedRoot, path.join(appDataRoot, "baseforge"));
  assert.ok(fs.existsSync(path.join(migratedRoot, "nowen-data")));
  assert.ok(fs.existsSync(path.join(migratedRoot, "nowen-data-location.json")));
  assert.equal(fs.existsSync(path.join(appDataRoot, "nowen-note")), false);
});

test("keeps the legacy data directory when the new one already exists", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "nowen-data"), { recursive: true });
  fs.writeFileSync(path.join(root, "nowen-data", "nowen-note.db"), "old");
  fs.mkdirSync(path.join(root, "baseforge-data"), { recursive: true });
  fs.writeFileSync(path.join(root, "baseforge-data", "baseforge.db"), "new");

  migrateLegacyDataDir(root);

  assert.equal(fs.readFileSync(path.join(root, "baseforge-data", "baseforge.db"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(root, "nowen-data", "nowen-note.db"), "utf8"), "old");
});

test("adopts the legacy database file together with its sidecar files", () => {
  const dataDir = tempRoot();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.writeFileSync(path.join(dataDir, `nowen-note.db${suffix}`), suffix || "db");
  }

  assert.equal(adoptLegacyDatabase(dataDir), true);

  for (const suffix of ["", "-wal", "-shm"]) {
    assert.ok(fs.existsSync(path.join(dataDir, `baseforge.db${suffix}`)));
    assert.equal(fs.existsSync(path.join(dataDir, `nowen-note.db${suffix}`)), false);
  }
});

test("keeps the existing database when adopting a legacy file", () => {
  const dataDir = tempRoot();
  fs.writeFileSync(path.join(dataDir, "baseforge.db"), "new");
  fs.writeFileSync(path.join(dataDir, "nowen-note.db"), "old");

  assert.equal(adoptLegacyDatabase(dataDir), false);
  assert.equal(fs.readFileSync(path.join(dataDir, "baseforge.db"), "utf8"), "new");
  assert.ok(fs.existsSync(path.join(dataDir, "nowen-note.db")));
});

test("ignores a custom data directory under Program Files", () => {
  const root = tempRoot();
  const programFiles = path.join(root, "Program Files");
  const custom = path.join(programFiles, "BaseForge");
  fs.mkdirSync(custom, { recursive: true });
  writeCustomDataDir(root, custom);

  const originalProgramFiles = process.env.ProgramFiles;
  process.env.ProgramFiles = programFiles;
  try {
    assert.equal(getUserDataPathFromRoot(root), getDefaultDataPath(root));
  } finally {
    if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = originalProgramFiles;
  }
});

test("rejects unsafe migration targets", () => {
  const root = tempRoot();
  const currentDir = getDefaultDataPath(root);
  const childDir = path.join(currentDir, "nested");
  const nonEmptyDir = path.join(root, "non-empty");
  const rootDir = path.parse(root).root;
  fs.mkdirSync(nonEmptyDir, { recursive: true });
  fs.writeFileSync(path.join(nonEmptyDir, "other.txt"), "x", "utf8");

  assert.equal(validateMigrationTarget("relative-dir", { currentDir }).ok, false);
  assert.equal(validateMigrationTarget(childDir, { currentDir }).ok, false);
  assert.equal(validateMigrationTarget(rootDir, { currentDir }).ok, false);
  assert.equal(validateMigrationTarget(nonEmptyDir, { currentDir }).ok, false);

  const originalProgramFiles = process.env.ProgramFiles;
  process.env.ProgramFiles = path.join(root, "Program Files");
  try {
    const programFilesTarget = path.join(process.env.ProgramFiles, "BaseForge");
    assert.equal(validateMigrationTarget(programFilesTarget, { currentDir }).ok, false);
  } finally {
    if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = originalProgramFiles;
  }
});

test("prompts for data directory on full first run without existing data", () => {
  const root = tempRoot();

  assert.equal(shouldPromptDataDirOnFirstRun(root, { mode: "full", liteOnly: false }), true);
});

test("does not prompt when a custom pointer already exists", () => {
  const root = tempRoot();
  const custom = path.join(root, "custom data");
  fs.mkdirSync(custom, { recursive: true });
  writeCustomDataDir(root, custom);

  assert.equal(shouldPromptDataDirOnFirstRun(root, { mode: "full", liteOnly: false }), false);
});

test("does not prompt when default data directory contains existing user data", () => {
  for (const marker of FIRST_RUN_DATA_MARKERS) {
    const root = tempRoot();
    const defaultDir = getDefaultDataPath(root);
    fs.mkdirSync(defaultDir, { recursive: true });
    const markerPath = path.join(defaultDir, marker);
    if (marker === "attachments") {
      fs.mkdirSync(markerPath, { recursive: true });
    } else {
      fs.writeFileSync(markerPath, "x", "utf8");
    }

    assert.equal(shouldPromptDataDirOnFirstRun(root, { mode: "full", liteOnly: false }), false);
  }
});

test("does not prompt in lite mode or lite-only builds", () => {
  const root = tempRoot();

  assert.equal(shouldPromptDataDirOnFirstRun(root, { mode: "lite", liteOnly: false }), false);
  assert.equal(shouldPromptDataDirOnFirstRun(root, { mode: "full", liteOnly: true }), false);
});
