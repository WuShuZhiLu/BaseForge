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
  assert.match(workflow, /--draft --generate-notes/);
  assert.match(workflow, /draft:\s*false/);
  assert.match(workflow, /needs:\s*\[version-guard, prepare-release, build\]/);
  assert.match(workflow, /verify-release-update-assets\.mjs local/);
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

test("Gitea 同步 workflow 支持 publish 与 latest_only 门禁", async () => {
  const workflow = await readRepoFile(".github/workflows/sync-release.yml");
  assert.match(workflow, /publish:/);
  assert.match(workflow, /ARGS\+=\(--publish\)/);
  assert.match(workflow, /dispatch-gitea-workflow\.mjs/);
  assert.match(workflow, /--workflow docker-image\.yml/);
  assert.match(workflow, /--input "latest_only=true"/);
});

test("同步脚本创建草稿、校验齐全后才转正", async () => {
  const script = await readRepoFile("scripts/sync-release-assets.mjs");
  assert.match(script, /draft:\s*true/);
  assert.match(script, /async function verifyGiteaAssets/);
  assert.match(script, /async function publishGiteaRelease/);
  assert.match(script, /body:\s*JSON\.stringify\(\{\s*draft:\s*false\s*\}\)/);
  assert.match(script, /args\.publish/);
});

test("Gitea Release workflow 新建草稿、更新时不回退已发布状态", async () => {
  const workflow = await readRepoFile(".gitea/workflows/release.yml");
  assert.match(workflow, /"draft":True/);
  assert.match(workflow, /release-update\.json/);
  assert.match(workflow, /d\.pop\("draft",None\)/);
});

test("Docker 镜像 tag 阶段只推版本，latest 走 latest_only", async () => {
  const workflow = await readRepoFile(".gitea/workflows/docker-image.yml");
  assert.match(workflow, /latest_only:/);
  assert.match(workflow, /LATEST_ONLY="\$\{INPUT_LATEST_ONLY:-false\}"/);
  assert.match(workflow, /docker pull "\$ref"/);
  assert.match(workflow, /只推版本 tag；latest 留到发布门禁通过后再移动/);
});

test("Gitea dispatch 脚本只接受 workflow_dispatch 输入且不打印 token", async () => {
  const script = await readRepoFile("scripts/dispatch-gitea-workflow.mjs");
  assert.match(script, /actions\/workflows\/\$\{encodeURIComponent\(workflow\)\}\/dispatches/);
  assert.match(script, /JSON\.stringify\(\{\s*ref,\s*inputs\s*\}\)/);
  assert.doesNotMatch(script, /console\.log\(.*token/i);
});
