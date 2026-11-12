const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const full = require(path.join(repoRoot, "electron", "builder.config.js"));
const lite = require(path.join(repoRoot, "electron", "builder.lite.config.js"));
const {
  shouldVerifyEmbeddedNodeVersion,
} = require(path.join(repoRoot, "electron", "embedded-node-layout.js"));

test("embedded node version probe only runs for host platform + arch", () => {
  assert.equal(shouldVerifyEmbeddedNodeVersion("darwin-arm64", "darwin", "arm64"), true);
  // arm64 mac 打 x64 包时无法直接执行 x64 node（依赖 Rosetta），只能校验存在
  assert.equal(shouldVerifyEmbeddedNodeVersion("darwin-x64", "darwin", "arm64"), false);
  assert.equal(shouldVerifyEmbeddedNodeVersion("win32-x64", "linux", "x64"), false);
  assert.equal(shouldVerifyEmbeddedNodeVersion("linux-arm64", "linux", "x64"), false);
});

test("full desktop updater uses stable no-space artifact names", () => {
  assert.equal(full.nsis?.artifactName, "BaseForge-${version}-setup.${ext}");
  assert.equal(full.portable?.artifactName, "BaseForge-${version}-portable.${ext}");
  assert.equal(full.mac?.artifactName, "BaseForge-${version}-${arch}.${ext}");
  assert.equal(full.linux?.artifactName, "BaseForge-${version}-${arch}.${ext}");
  assert.equal(full.afterAllArtifactBuild, undefined);
  assert.match(
    require(path.join(repoRoot, "package.json")).scripts["electron:build"],
    /node build\/verifyUpdateArtifactsCli\.js/,
  );
});

test("lite updater stays on an isolated latest-lite channel", () => {
  assert.ok(Array.isArray(lite.publish));
  assert.ok(lite.publish.every((provider) => provider.channel === "latest-lite"));
  assert.equal(lite.nsis?.artifactName, "BaseForge-${version}-lite-setup.${ext}");
  assert.equal(lite.portable?.artifactName, "BaseForge-${version}-lite-portable.${ext}");
  assert.equal(lite.afterAllArtifactBuild, undefined);
  assert.match(
    fs.readFileSync(path.join(repoRoot, "scripts", "safe-build-legacy.mjs"), "utf8"),
    /verifyUpdateArtifactsCli\.js/,
  );
});
