#!/usr/bin/env node
/**
 * Release 正文生成器回归：
 *   - DeepSeek Harness 风格：顶部 `[中文](#中文) | [English](#english)`，中文在前、英文在后；
 *   - 两种语言各自完整（概述 + 分组 + 说明），不折叠；
 *   - 下载表按真实资产分类，Lite 落在 Lite 列，MCP / Docker 不重复；
 *   - hash 与 #issue 变成链接，普通代码不被误伤。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReleaseNotes,
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

test("完整正文：DeepSeek Harness 风格，中英各成一段且中文在前", () => {
  const { zh, en } = makeFixture();

  const notes = buildReleaseNotes({
    tag: "v0.2.0",
    repo: REPO,
    changelog: zh,
    changelogEn: en,
  });

  // 顶部等权语言链接
  assert.match(notes, /^\[中文\]\(#中文\) \| \[English\]\(#english\)$/m);

  // 两种语言都完整展开，不折叠
  assert.doesNotMatch(notes, /<details/);

  // 中文段在前、英文段在后；各自包含概述、分组与说明小节
  const zhHeading = notes.indexOf("## 中文");
  const enHeading = notes.indexOf("## English");
  assert.ok(zhHeading >= 0 && enHeading > zhHeading);
  assert.ok(notes.indexOf("远程文档内核化") < enHeading);
  assert.ok(notes.indexOf("### 新增") < enHeading);
  assert.ok(notes.indexOf("## 说明") < enHeading);

  assert.ok(notes.indexOf("Remote documents become core") > enHeading);
  assert.ok(notes.indexOf("### Added") > enHeading);
  assert.ok(notes.indexOf("## Notes") > enHeading);

  // 正文不再重复下载表：产物由 Release 页面底部的 Assets 列表展示
  assert.doesNotMatch(notes, /## 下载/);
  assert.doesNotMatch(notes, /releases\/download/);

  // 中英文段落的 hash 都变成链接
  assert.match(notes, /\[`7b456c9cd`\]\(https:\/\/github\.com\/wushuzhilu\/BaseForge\/commit\/7b456c9cd\)/);
  assert.equal(notes.match(/7b456c9cd/g).length >= 4, true);
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
