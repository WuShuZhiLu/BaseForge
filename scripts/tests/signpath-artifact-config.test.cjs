const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const configDir = path.join(repoRoot, ".signpath", "artifact-configurations");
const full = fs.readFileSync(path.join(configDir, "windows-full.xml"), "utf8");
const lite = fs.readFileSync(path.join(configDir, "windows-lite.xml"), "utf8");

function count(source, pattern) {
  return (source.match(pattern) || []).length;
}

function assertCommonContract(source) {
  assert.match(source, /<artifact-configuration xmlns="http:\/\/signpath\.io\/artifact-configuration\/v1">/);
  // 参数化 artifact configuration 是付费能力，免费/试用订阅会拒绝 `<parameters>`。
  assert.doesNotMatch(source, /<parameters[\s>]/);
  assert.doesNotMatch(source, /\$\{/);
  assert.match(source, /<zip-file>/);
  assert.match(source, /<pe-file-set>/);
  assert.equal(count(source, /<include\b/g), 2);
  assert.equal(count(source, /<authenticode-sign\b/g), 1);
  assert.equal(count(source, /hash-algorithm="sha256"/g), 1);
  // SignPath OSS subscriptions enforce their own Authenticode watermark/description.
  // Custom description fields are rejected by the service, so keep them absent.
  assert.doesNotMatch(source, /authenticode-sign[^>]*\bdescription=/);
  assert.doesNotMatch(source, /authenticode-sign[^>]*\bdescription-url=/);
}

test("Full Artifact Configuration only signs stable setup/portable executables", () => {
  assertCommonContract(full);
  assert.match(full, /<include path="BaseForge-\*-setup\.exe" \/>/);
  assert.match(full, /<include path="BaseForge-\*-portable\.exe" \/>/);
});

test("Lite Artifact Configuration only signs stable Lite setup/portable executables", () => {
  assertCommonContract(lite);
  assert.match(lite, /<include path="BaseForge-\*-lite-setup\.exe" \/>/);
  assert.match(lite, /<include path="BaseForge-\*-lite-portable\.exe" \/>/);
});
