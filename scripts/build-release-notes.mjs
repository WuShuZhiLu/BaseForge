#!/usr/bin/env node
/**
 * 生成 Release 正文（GitHub / Gitea / Gitee 三端共用同一份）。
 *
 * 为什么不用 `gh release create --generate-notes`：
 *   - 生成的是「自上个 tag 以来的 PR 列表」，本项目按分组手写 CHANGELOG，两套口径对不上；
 *   - 正文没有下载入口，国际访客不知道 Lite 是什么、该下哪个包；
 *   - 全文中文，对外部协作者不友好。
 *
 * 数据来源固定为两个文件，不引入第三份真相：
 *   CHANGELOG.md     → 中文段落（默认，排在前面）
 *   CHANGELOG.en.md  → 英文段落（排在后面）
 *
 * 产物结构（对齐 DeepSeek Harness 的 Release 写法）：
 *   `[中文](#中文) | [English](#english)`
 *   → `## 中文`（概述 + 分组 + 说明）→ `## English`（intro + groups + Notes）
 *
 * 注意：
 *   - Release 页面底部已有 GitHub 自动生成的 Assets 列表，正文不再重复放下载表；
 *   - Release 正文只有一个 body，无法像 README 那样跳转到另一个文件，
 *     因此语言切换用页内锚点；两种语言都完整展开，不折叠。
 *
 * 用法：
 *   node scripts/build-release-notes.mjs --tag v0.2.0 --repo owner/repo --out notes.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GROUP_HEADINGS_EN = [
  "Added",
  "Fixed",
  "Improved",
  "Changed",
  "Docs",
  "Refactored",
  "Other",
];

function parseArgs(argv) {
  const options = {
    tag: "",
    repo: process.env.GITHUB_REPOSITORY || "",
    changelog: "CHANGELOG.md",
    changelogEn: "CHANGELOG.en.md",
    out: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") options.tag = argv[++i];
    else if (arg === "--repo") options.repo = argv[++i];
    else if (arg === "--changelog") options.changelog = argv[++i];
    else if (arg === "--changelog-en") options.changelogEn = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "用法：node scripts/build-release-notes.mjs --tag vX.Y.Z [--repo owner/repo] [--out 文件]",
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!options.tag) throw new Error("必须提供 --tag");
  if (!options.repo) throw new Error("必须提供 --repo（或设置 GITHUB_REPOSITORY）");
  return options;
}

/** 取出 `## <tag>` 段落（到下一个 `## ` 为止），拆成概述与分组。 */
export function extractSection(markdown, tag) {
  const lines = markdown.split(/\r?\n/);
  const heading = `## ${tag}`;
  const start = lines.findIndex(
    (line) => line.trim() === heading || line.trim().startsWith(`${heading} `),
  );
  if (start === -1) return null;

  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }

  const firstGroup = body.findIndex((line) => /^### /.test(line));
  const introLines = firstGroup === -1 ? body : body.slice(0, firstGroup);
  const groupLines = firstGroup === -1 ? [] : body.slice(firstGroup);

  const groups = [];
  let current = null;
  for (const line of groupLines) {
    const match = /^### (.+)$/.exec(line);
    if (match) {
      current = { title: match[1].trim(), lines: [] };
      groups.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  return {
    intro: introLines.join("\n").trim(),
    groups: groups.map((group) => ({
      title: group.title,
      body: group.lines.join("\n").trim(),
    })),
  };
}

/** 把短 hash 与 `#123` 变成链接；只处理反引号包裹的 hash，避免误伤普通代码。 */
export function linkify(text, repo) {
  const commitBase = `https://github.com/${repo}/commit/`;
  const issueBase = `https://github.com/${repo}/issues/`;
  return text
    .replace(/`([0-9a-f]{7,40})`/g, (_, sha) => `[\`${sha}\`](${commitBase}${sha})`)
    .replace(/(^|[\s(（])#(\d+)\b/g, (match, prefix, number) => `${prefix}[#${number}](${issueBase}${number})`);
}

/** 英文分组正文：把中文的 ### 标题映射为英文（英文文件本身已是英文，直接输出）。 */
function renderGroups(section, repo) {
  const output = [];
  for (const group of section.groups) {
    if (!group.body) continue;
    const title = GROUP_HEADINGS_EN.includes(group.title) ? group.title : group.title;
    output.push(`### ${title}`, "", linkify(group.body, repo), "");
  }
  return output.join("\n").trim();
}

function firstParagraph(intro) {
  if (!intro) return "";
  const paragraph = intro.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)[0] || "";
  return paragraph;
}

export function buildReleaseNotes(options) {
  const { tag, repo } = options;
  const version = tag.replace(/^v/, "");
  const prerelease = tag.includes("-");

  const changelog = fs.readFileSync(options.changelog, "utf8");
  const changelogEn = fs.readFileSync(options.changelogEn, "utf8");

  const zh = extractSection(changelog, tag);
  const en = extractSection(changelogEn, tag);
  if (!zh) throw new Error(`${options.changelog} 里没有 ${tag} 段落`);
  if (!en) throw new Error(`${options.changelogEn} 里没有 ${tag} 段落`);

  const enIntro = firstParagraph(en.intro);
  const zhIntro = firstParagraph(zh.intro);

  if (/开发中|in development|WIP/i.test(enIntro + zhIntro)) {
    console.warn(
      "[release-notes] 警告：版本段落第一段仍是「开发中」之类的草稿说明，会原样出现在 Release 正文首行。发版前请改成正式概述。",
    );
  }

  const parts = [];

  // DeepSeek Harness 风格：顶部一行等权语言链接，中文在前、英文在后
  parts.push("[中文](#中文) | [English](#english)", "");

  // ===== 中文 =====
  parts.push("## 中文", "");
  if (zhIntro) parts.push(zhIntro, "");
  if (prerelease) {
    parts.push("> ⚠️ 这是**预发布**版本，稳定版发布前仍可能有较大改动。", "");
  }
  const zhChanges = renderGroups(zh, repo);
  if (zhChanges) parts.push(zhChanges, "");
  parts.push("## 说明", "");
  parts.push("- **校验下载** — `SHA256SUMS.txt` 随本 Release 一同发布，下载后执行 `sha256sum -c SHA256SUMS.txt`。");
  parts.push(
    `- **完整更新日志** — [\`CHANGELOG.md\`](https://github.com/${repo}/blob/${tag}/CHANGELOG.md)`,
  );
  parts.push(`- **源码** — [\`${tag}\`](https://github.com/${repo}/tree/${tag}) · 版本 ${version}`, "");

  // ===== English =====
  parts.push("## English", "");
  if (enIntro) parts.push(enIntro, "");
  if (prerelease) {
    parts.push(
      "> ⚠️ This is a **pre-release** build. Expect rough edges and breaking changes before the stable release.",
      "",
    );
  }
  const enChanges = renderGroups(en, repo);
  if (enChanges) parts.push(enChanges, "");
  parts.push("## Notes", "");
  parts.push(
    "- **Verifying downloads** — `SHA256SUMS.txt` is attached to this release; run `sha256sum -c SHA256SUMS.txt` after downloading.",
  );
  parts.push(
    `- **Full changelog** — [\`CHANGELOG.en.md\`](https://github.com/${repo}/blob/${tag}/CHANGELOG.en.md)`,
  );
  parts.push(`- **Source** — [\`${tag}\`](https://github.com/${repo}/tree/${tag}) · version ${version}`, "");

  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = {
    tag: args.tag,
    repo: args.repo,
    changelog: args.changelog,
    changelogEn: args.changelogEn,
  };
  const notes = buildReleaseNotes(options);
  if (args.out) {
    fs.writeFileSync(args.out, notes, "utf8");
    console.log(
      `[release-notes] ${args.tag} 正文已写入 ${args.out}（${notes.split("\n").length} 行）`,
    );
  } else {
    process.stdout.write(notes);
  }
}

// 仅在直接执行时运行；被测试 import 时不触发。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
