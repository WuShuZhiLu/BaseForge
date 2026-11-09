#!/usr/bin/env node
/**
 * Release 正文生成器回归：
 *   - 中英两段分别抽取，英文在前、中文折进 <details>；
 *   - 下载表按真实资产分类，Lite 落在 Lite 列，MCP / Docker 不重复；
 *   - hash 与 #issue 变成链接，普通代码不被误伤。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDownloadSection,
  buildReleaseNotes,
  classifyAsset,
  extractSection,
  linkify,
} from "../build-release-notes.mjs";

const REPO = "wushuzhilu/BaseForge";

const ZN_CHANGELOG = `# 更新日志

## Unreleased

下一次要发的版本。

## v0.2.0 - 2026-11-09

远程文档内核化，桌面端内嵌 Node 22。

### 新增

- 远程文档改为内核能力（\`7b456c9cd\`）
- 修复 issue #123 相关行为

### 修复

- 容器基础镜像升到 \`node:22-alpine\`（\`dc3a1c522\`）

## v0.1.0 - 2026-11-05

旧版本。
`;

const EN_CHANGELOG = `# Changelog

## Unreleased

Next up.

## v0.2.0 - 2026-11-09

Remote documents become core; desktop bundles Node 22.

### Added

- Remote documents promoted to core (\`7b456c9cd\`)
- See #123 for details

### Fixed

- Container base image bumped to \`node:22-alpine\` (\`dc3a1c522\`)

## v0.1.0 - 2026-11-05

Old.
`;

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-"));
  const zh = path.join(dir, "CHANGELOG.md");
  const en = path.join(dir, "CHANGELOG.en.md");
  fs.writeFileSync(zh, ZN_CHANGELOG, "utf8");
  fs.writeFileSync(en, EN_CHANGELOG, "utf8");
  return { dir, zh, en };
}

test("extractSection 取到版本段落，概述与分组分开", () => {
  const section = extractSection(ZN_CHANGELOG, "v0.2.0");
  assert.ok(section);
  assert.equal(section.intro, "远程文档内核化，桌面端内嵌 Node 22。");
  assert.deepEqual(
    section.groups.map((group) => group.title),
    ["新增", "修复"],
  );
  assert.match(section.groups[0].body, /远程文档改为内核能力/);
  // 不得越界吃到下一个版本
  assert.doesNotMatch(section.groups[1].body, /旧版本/);
});

test("extractSection 找不到 tag 时返回 null", () => {
  assert.equal(extractSection(ZN_CHANGELOG, "v9.9.9"), null);
});

test("linkify 把 hash 与 issue 变成链接，普通代码保持原样", () => {
  const text = linkify("- 改了 `node:22-alpine` 和 `7b456c9cd`，见 #123", REPO);
  assert.match(text, /`node:22-alpine`/);
  assert.match(text, /\[`7b456c9cd`\]\(https:\/\/github\.com\/wushuzhilu\/BaseForge\/commit\/7b456c9cd\)/);
  assert.match(text, /\[#123\]\(https:\/\/github\.com\/wushuzhilu\/BaseForge\/issues\/123\)/);
});

test("assets 分类：Lite 与 full 分开，元数据不参与下载表", () => {
  assert.deepEqual(classifyAsset("BaseForge-0.2.0-setup.exe"), { kind: "win-setup", lite: false });
  assert.deepEqual(classifyAsset("BaseForge-0.2.0-lite-setup.exe"), {
    kind: "win-setup",
    lite: true,
  });
  assert.deepEqual(classifyAsset("BaseForge-0.2.0-arm64.dmg"), {
    kind: "mac-dmg",
    lite: false,
    arch: "arm64",
  });
  assert.equal(classifyAsset("latest.yml"), null);
  assert.equal(classifyAsset("BaseForge-0.2.0-setup.exe.blockmap"), null);
  assert.equal(classifyAsset("SHA256SUMS.txt"), null);
  assert.deepEqual(classifyAsset("baseforge-mcp.mjs"), { kind: "mcp", lite: false });
});

test("下载表：Lite 落 Lite 列，MCP 单行，Docker 用带 v 的 tag", () => {
  const files = [
    "BaseForge-0.2.0-setup.exe",
    "BaseForge-0.2.0-portable.exe",
    "BaseForge-0.2.0-lite-setup.exe",
    "BaseForge-0.2.0-lite-portable.exe",
    "BaseForge-0.2.0-arm64.dmg",
    "BaseForge-0.2.0-lite-arm64.dmg",
    "BaseForge-0.2.0-x86_64.AppImage",
    "BaseForge-0.2.0-lite.AppImage",
    "baseforge-mcp.mjs",
    "latest.yml",
    "SHA256SUMS.txt",
  ];
  const section = buildDownloadSection(files, {
    tag: "v0.2.0",
    repo: REPO,
    dockerImage: "docker.example.com/baseforge",
  });

  const liteRow = section.split("\n").find((line) => line.startsWith("| **Windows**"));
  assert.ok(liteRow);
  const [fullCell, liteCell] = liteRow.split("|").slice(2, 4);
  assert.match(fullCell, /BaseForge-0\.2\.0-setup\.exe/);
  assert.doesNotMatch(fullCell, /-lite-/);
  assert.match(liteCell, /BaseForge-0\.2\.0-lite-setup\.exe/);

  // MCP 只出现一次（链接文本 + href 各一次，故按 Markdown 链接计数），避免看起来像两份产物
  assert.equal(section.match(/\[baseforge-mcp\.mjs\]\(/g).length, 1);
  // Docker tag 与 Release tag 一致（带 v）
  assert.match(section, /docker pull docker\.example\.com\/baseforge:v0\.2\.0/);
  // 元数据与校验和文件不得进入下载表
  assert.doesNotMatch(section, /latest\.yml/);
  assert.doesNotMatch(section, /SHA256SUMS/);
});

test("完整正文：英文在前，中文折进 details，结构齐全", () => {
  const { dir, zh, en } = makeFixture();
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets);
  for (const name of ["BaseForge-0.2.0-setup.exe", "BaseForge-0.2.0-lite-setup.exe", "baseforge-mcp.mjs"]) {
    fs.writeFileSync(path.join(assets, name), "");
  }

  const notes = buildReleaseNotes({
    tag: "v0.2.0",
    repo: REPO,
    assetsDir: assets,
    dockerImage: "",
    changelog: zh,
    changelogEn: en,
  });

  // 英文概述在中文之前
  const enIntro = notes.indexOf("Remote documents become core");
  const zhIntro = notes.indexOf("远程文档内核化");
  assert.ok(enIntro >= 0 && zhIntro > enIntro);

  for (const heading of ["## Download", "## What's changed", "## Notes"]) {
    assert.ok(notes.includes(heading), `缺少 ${heading}`);
  }
  assert.match(notes, /<details>\n<summary>中文更新日志 · v0\.2\.0<\/summary>/);
  assert.match(notes, /<\/details>/);
  assert.match(notes, /### Added/);
  // 中文分组标题不应出现在折叠块之外
  assert.ok(notes.indexOf("### 新增") > notes.indexOf("<details>"));
  // 英文段落的 hash 变成链接
  assert.match(notes, /\[`7b456c9cd`\]\(https:\/\/github\.com\/wushuzhilu\/BaseForge\/commit\/7b456c9cd\)/);
});

test("缺 tag 段落时抛错，避免发出空正文", () => {
  const { zh, en } = makeFixture();
  assert.throws(
    () =>
      buildReleaseNotes({
        tag: "v9.9.9",
        repo: REPO,
        assetsDir: "",
        dockerImage: "",
        changelog: zh,
        changelogEn: en,
      }),
    /没有 v9\.9\.9 段落/,
  );
});
