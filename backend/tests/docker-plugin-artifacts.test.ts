import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Docker-shaped tsc artifacts run both plugin runtimes without source fallbacks", { timeout: 240_000 }, () => {
  const backend = fs.existsSync(path.resolve("src/plugins/runner.ts")) ? process.cwd() : path.resolve("backend");
  const root = path.resolve(backend, "..");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const copy = dockerfile.match(/&& cp ([^\r\n]+) dist\/plugins\//);
  assert.ok(copy, "Docker tsc build must copy plugin child entries into dist/plugins");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-docker-plugin-test-"));
  const artifactBackend = path.join(directory, "backend");
  const dist = path.join(artifactBackend, "dist");
  const smoke = path.join(backend, "scripts/smoke-plugin-artifacts.cjs");
  try {
    // --noCheck：只做 emit 验证产物形态。类型检查由 CI 的独立 typecheck job 负责，
    // 这里再跑一遍完整类型检查会把用例拖到 90s 上限附近。
    execFileSync(process.execPath, [path.join(backend, "node_modules/typescript/bin/tsc"),
      "--noCheck", "--outDir", dist, "--declaration", "false", "--pretty", "false"], { cwd: backend, timeout: 180_000 });
    fs.symlinkSync(path.join(backend, "node_modules"), path.join(artifactBackend, "node_modules"), "junction");
    assert.equal(fs.existsSync(path.join(artifactBackend, "src")), false);
    for (const source of copy[1].trim().split(/\s+/)) {
      fs.copyFileSync(path.join(backend, source), path.join(dist, "plugins", path.basename(source)));
    }
    const run = () => execFileSync(process.execPath, [smoke, artifactBackend], {
      cwd: directory, encoding: "utf8", timeout: 20_000, stdio: "pipe",
    });
    const output = run();
    assert.match(output, /node-action: preflight, execution and Host API passed/);
    assert.match(output, /sandbox-js: preflight, execution and Host API passed/);
    for (const entry of ["runner-child.mjs", "sandbox-child.mjs"]) {
      const file = path.join(dist, "plugins", entry);
      fs.renameSync(file, `${file}.disabled`);
      try {
        assert.throws(run, new RegExp(`Missing plugin artifact: ${entry.replace(".", "\\.")}`));
      } finally {
        fs.renameSync(`${file}.disabled`, file);
      }
    }
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
