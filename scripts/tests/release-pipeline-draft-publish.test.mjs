import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8");
}

test("GitHub Release 先建 draft、校验资产后才转正", async () => {
  const workflow = await readRepoFile(".github/workflows/release.yml");
  assert.match(workflow, /prepare-release:/);
  assert.match(workflow, /gh release create "\$TAG" "\$\{ARGS\[@\]\}"/);
  assert.match(workflow, /--draft --notes-file \/tmp\/release-notes\.md/);
  assert.match(workflow, /draft:\s*false/);
  // publish 必须等全部构建产物就绪（含 MCP 单文件），所以只校验依赖里包含这几项。
  const publishNeeds = workflow.match(/publish:[\s\S]*?needs:\s*\[([^\]]+)\]/)?.[1] || "";
  for (const dep of ["version-guard", "prepare-release", "build", "build-mcp"]) {
    assert.ok(publishNeeds.includes(dep), `publish 缺少依赖 ${dep}（当前：${publishNeeds}）`);
  }
  assert.match(workflow, /verify-release-update-assets\.mjs local/);
  assert.match(workflow, /assert-release-matrix\.mjs/);
});

test("GitHub Release 只汇总已签名 Windows，不带签名前候选", async () => {
  const workflow = await readRepoFile(".github/workflows/release.yml");
  assert.match(workflow, /name:\s*nowen-note-win-signed/);
  assert.match(workflow, /name:\s*baseforge-mac/);
  assert.match(workflow, /name:\s*baseforge-linux/);
  assert.doesNotMatch(workflow, /pattern:\s*baseforge-\*/);
});

test("GitHub 发布后 dispatch Gitea 同步并开启 publish", async () => {
  const workflow = await readRepoFile(".github/workflows/release.yml");
  assert.match(workflow, /dispatch-gitea:/);
  assert.match(workflow, /dispatch-gitea-workflow\.mjs/);
  assert.match(workflow, /--workflow sync-release\.yml/);
  assert.match(workflow, /--input "publish=true"/);
});

test("Gitea 同步 workflow 位于 .gitea 目录，支持 publish 且不再移动 docker latest", async () => {
  const workflow = await readRepoFile(".gitea/workflows/sync-release.yml");
  assert.match(workflow, /publish:/);
  assert.match(workflow, /ARGS\+=\(--publish\)/);
  // latest 由 docker-image.yml 在 tag 阶段直接推送，这里不应再 dispatch latest_only
  assert.doesNotMatch(workflow, /--input "latest_only=true"/);
  // Gitee 没有草稿语义：只有要求转正（或演练）时才同步，publish=false 不得公开
  assert.match(workflow, /github\.event\.inputs\.publish == 'true'/);
});

test("同步脚本创建草稿、校验齐全后才转正", async () => {
  const script = await readRepoFile("scripts/sync-release-assets.mjs");
  assert.match(script, /draft:\s*true/);
  assert.match(script, /async function verifyGiteaAssets/);
  assert.match(script, /async function publishGiteaRelease/);
  assert.match(script, /body:\s*JSON\.stringify\(\{\s*draft:\s*false\s*\}\)/);
  assert.match(script, /args\.publish/);
});

test("Release 正文只有单一来源（CHANGELOG），Gitea 不再单独维护", async () => {
  await assert.rejects(
    readRepoFile(".gitea/workflows/release.yml"),
    /ENOENT/,
    "Gitea 侧不应再有独立的 Release 正文 workflow，否则两端正文取决于谁先建 Release",
  );
  const workflow = await readRepoFile(".github/workflows/release.yml");
  assert.match(workflow, /build-release-notes\.mjs/);
  assert.match(workflow, /--notes-file \/tmp\/release-notes\.md/);
  assert.doesNotMatch(workflow, /--generate-notes/);
  // 正文由 publish 阶段生成后随 Release 发布；产物交给 Release 页面的 Assets 列表
  assert.match(workflow, /body_path:\s*release-notes\.md/);
  assert.doesNotMatch(workflow, /--assets/);
});

test("Docker 镜像 tag 阶段同时推版本与 latest", async () => {
  const workflow = await readRepoFile(".gitea/workflows/docker-image.yml");
  // 先推版本 tag，成功后才移动 latest
  assert.match(workflow, /if ! push_with_retry "\$ref"; then/);
  assert.match(workflow, /echo "推送 \$\{latest_ref\}"/);
  assert.match(workflow, /if push_with_retry "\$latest_ref"; then/);
  // latest_only 仍保留为手动补救入口（只移动 latest，不重新构建）
  assert.match(workflow, /latest_only:/);
  assert.match(workflow, /docker pull "\$ref"/);
  assert.doesNotMatch(workflow, /latest 留到发布门禁通过后再移动/);
});

test("publish 阶段生成 SHA256SUMS 并随 Release 发布", async () => {
  const workflow = await readRepoFile(".github/workflows/release.yml");
  assert.match(workflow, /sha256sum > SHA256SUMS\.txt/);
  // 校验和必须在发布步骤之前生成，否则不会进入 release-assets/*
  const checksumAt = workflow.indexOf("Generate SHA256SUMS");
  const publishAt = workflow.indexOf("Publish GitHub Release");
  assert.ok(checksumAt > 0 && publishAt > checksumAt, "SHA256SUMS 必须在上传 Release 之前生成");
});

test("资产矩阵断言与 electron-builder 的 Lite 命名保持一致", async () => {
  const script = await readRepoFile("scripts/assert-release-matrix.mjs");
  // Lite 产物统一为 BaseForge-<version>-lite-*，与 full 的版本在前规则一致
  assert.doesNotMatch(script, /BaseForge-Lite-\$\{version\}/);
  assert.match(script, /`BaseForge-\$\{version\}-lite-setup\.exe`/);
  assert.match(script, /`BaseForge-\$\{version\}-lite-portable\.exe`/);
  assert.match(script, /`BaseForge-\$\{version\}-lite-\$\{arch\}\.\$\{ext\}`/);
});

test("Gitea dispatch 脚本只接受 workflow_dispatch 输入且不打印 token", async () => {
  const script = await readRepoFile("scripts/dispatch-gitea-workflow.mjs");
  assert.match(script, /actions\/workflows\/\$\{encodeURIComponent\(workflow\)\}\/dispatches/);
  assert.match(script, /JSON\.stringify\(\{\s*ref,\s*inputs\s*\}\)/);
  assert.doesNotMatch(script, /console\.log\(.*token/i);
});
