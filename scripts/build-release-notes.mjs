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
 *   CHANGELOG.md     → 中文段落（折进 <details>）
 *   CHANGELOG.en.md  → 英文段落（正文主体）
 *
 * 产物结构：
 *   英文概述 → 中文概述（引用块）→ Download 表（按真实资产生成）
 *   → What's changed（英文分组）→ 中文更新日志（折叠）→ Notes
 *
 * 用法：
 *   node scripts/build-release-notes.mjs --tag v0.2.0 --repo owner/repo --out notes.md
 *   node scripts/build-release-notes.mjs --tag v0.2.0 --repo owner/repo \
 *     --assets release-assets --docker-image repo/image --out notes.md
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
    assets: "",
    dockerImage: "",
    changelog: "CHANGELOG.md",
    changelogEn: "CHANGELOG.en.md",
    out: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") options.tag = argv[++i];
    else if (arg === "--repo") options.repo = argv[++i];
    else if (arg === "--assets") options.assets = argv[++i];
    else if (arg === "--docker-image") options.dockerImage = argv[++i];
    else if (arg === "--changelog") options.changelog = argv[++i];
    else if (arg === "--changelog-en") options.changelogEn = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "用法：node scripts/build-release-notes.mjs --tag vX.Y.Z [--repo owner/repo] [--assets 目录] [--docker-image 镜像] [--out 文件]",
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

const SKIP_RE = /^(?:latest(?:-[a-z0-9._-]+)?\.ya?ml|.*\.blockmap|SHA256SUMS\.txt|builder-(?:debug|effective-config)\.ya?ml)$/i;

/**
 * 资产分类：按真实文件名判断，不依赖 electron-builder 的命名常量，
 * 这样配置里改了 artifactName 也不会让下载表指向不存在的文件。
 */
export function classifyAsset(name) {
  if (SKIP_RE.test(name)) return null;

  const lite = /-lite[-.]/i.test(name);
  const lower = name.toLowerCase();

  if (/\.mjs$/i.test(name)) return { kind: "mcp", lite: false };

  if (lower.endsWith(".exe")) {
    if (/portable/i.test(name)) return { kind: "win-portable", lite };
    if (/setup/i.test(name)) return { kind: "win-setup", lite };
    return null;
  }
  if (lower.endsWith(".dmg") || lower.endsWith(".zip")) {
    const arch = /-arm64[-.]/i.test(name) ? "arm64" : /-x64[-.]/i.test(name) ? "x64" : "x64";
    const kind = lower.endsWith(".dmg") ? "mac-dmg" : "mac-zip";
    return { kind, lite, arch };
  }
  if (lower.endsWith(".appimage")) {
    const arch = /x86_64|amd64/i.test(name) ? "x64" : "x64";
    return { kind: "linux-appimage", lite, arch };
  }
  if (lower.endsWith(".deb")) {
    const arch = /x86_64|amd64/i.test(name) ? "x64" : "x64";
    return { kind: "linux-deb", lite, arch };
  }
  return null;
}

const ARCH_ORDER = { arm64: 0, x64: 1 };

function formatArch(arch) {
  return arch === "arm64" ? "arm64" : "x64";
}

/** 由资产目录生成下载表；同一格内按 安装版 → 免安装 → 各架构 排序。 */
export function buildDownloadSection(files, { tag, repo, dockerImage }) {
  const downloadBase = `https://github.com/${repo}/releases/download/${tag}`;
  const link = (name, label) => `[${label}](${downloadBase}/${encodeURIComponent(name)})`;

  const buckets = { full: new Map(), lite: new Map() };
  const unclassified = [];

  for (const name of files) {
    const info = classifyAsset(name);
    if (!info) {
      if (!SKIP_RE.test(name)) unclassified.push(name);
      continue;
    }
    if (info.kind === "mcp") continue;
    const bucket = info.lite ? buckets.lite : buckets.full;
    if (!bucket.has(info.kind)) bucket.set(info.kind, []);
    bucket.get(info.kind).push({ name, arch: info.arch || "x64" });
  }

  const sortEntries = (entries = []) =>
    entries
      .slice()
      .sort((a, b) => (ARCH_ORDER[a.arch] ?? 9) - (ARCH_ORDER[b.arch] ?? 9) || a.name.localeCompare(b.name));

  const cell = (kind, labelFor) => {
    const full = sortEntries(buckets.full.get(kind));
    const lite = sortEntries(buckets.lite.get(kind));
    const render = (entries) =>
      entries.length === 0 ? "—" : entries.map((entry) => link(entry.name, labelFor(entry))).join(" · ");
    return { full: render(full), lite: render(lite) };
  };

  const winSetup = cell("win-setup", (e) => `Setup .exe (${formatArch(e.arch)})`);
  const winPortable = cell("win-portable", (e) => `Portable .exe`);
  const macDmg = cell("mac-dmg", (e) => `${formatArch(e.arch)} .dmg`);
  const macZip = cell("mac-zip", (e) => `${formatArch(e.arch)} .zip`);
  const linuxAppImage = cell("linux-appimage", (e) => `.AppImage (${formatArch(e.arch)})`);
  const linuxDeb = cell("linux-deb", (e) => `.deb (${formatArch(e.arch)})`);

  const join = (a, b) => [a, b].filter((x) => x && x !== "—").join(" · ") || "—";

  const rows = [
    `| **Windows** <br><sub>10 / 11 · x64</sub> | ${join(winSetup.full, winPortable.full)} | ${join(winSetup.lite, winPortable.lite)} |`,
    `| **macOS** <br><sub>Apple Silicon / Intel</sub> | ${join(macDmg.full, macZip.full)} | ${join(macDmg.lite, macZip.lite)} |`,
    `| **Linux** <br><sub>x64</sub> | ${join(linuxAppImage.full, linuxDeb.full)} | ${join(linuxAppImage.lite, linuxDeb.lite)} |`,
  ];

  const mcp = files.find((name) => classifyAsset(name)?.kind === "mcp");
  if (mcp) {
    // MCP 是同一份单文件，不区分 full / Lite，只放在完整版一列，避免看起来像两份产物。
    rows.push(`| **MCP server** <br><sub>single file · Node 20+</sub> | ${link(mcp, "baseforge-mcp.mjs")} | — |`);
  }
  if (dockerImage) {
    // 镜像 tag 与 Release tag 一致（带 v 前缀），见 .gitea/workflows/docker-image.yml。
    rows.push(`| **Docker** <br><sub>server only</sub> | \`docker pull ${dockerImage}:${tag}\` | — |`);
  }

  const lines = [
    "## Download",
    "",
    "| Platform | Full（完整版） | Lite（仅远程） |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "> **Lite** 不含本地数据库，只能连接远端 BaseForge 服务器使用；本地写作与本地库请用完整版。",
    "> Lite ships without a local database and only works against a remote BaseForge server.",
    "",
  ];

  if (unclassified.length > 0) {
    lines.push(`<sub>其他附件：${unclassified.map((name) => link(name, name)).join(" · ")}</sub>`, "");
  }
  return lines.join("\n");
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
  const { tag, repo, assetsDir, dockerImage } = options;
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
  if (enIntro) parts.push(enIntro, "");
  if (zhIntro) parts.push(`> ${zhIntro.replace(/\n/g, "\n> ")}`, "");

  if (prerelease) {
    parts.push(
      "> ⚠️ This is a **pre-release** build. Expect rough edges and breaking changes before the stable release.",
      "",
    );
  }

  if (assetsDir) {
    const files = fs
      .readdirSync(assetsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    parts.push(buildDownloadSection(files, { tag, repo, dockerImage }), "");
  }

  const enChanges = renderGroups(en, repo);
  if (enChanges) parts.push("## What's changed", "", enChanges, "");

  const zhChanges = renderGroups(zh, repo);
  if (zhChanges) {
    parts.push(
      "<details>",
      `<summary>中文更新日志 · ${tag}</summary>`,
      "",
      zhChanges,
      "",
      "</details>",
      "",
    );
  }

  parts.push("## Notes", "");
  parts.push(
    assetsDir
      ? "- **Verifying downloads** — every asset is listed in `SHA256SUMS.txt`; run `sha256sum -c SHA256SUMS.txt` after downloading."
      : "- **Verifying downloads** — `SHA256SUMS.txt` is attached to this release; run `sha256sum -c SHA256SUMS.txt` after downloading.",
  );
  parts.push(
    `- **Full changelog** — [\`CHANGELOG.md\`](https://github.com/${repo}/blob/${tag}/CHANGELOG.md) · [English](https://github.com/${repo}/blob/${tag}/CHANGELOG.en.md)`,
  );
  parts.push(
    `- **Source** — [\`${tag}\`](https://github.com/${repo}/tree/${tag}) · 版本 ${version}`,
  );
  parts.push("");

  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = {
    tag: args.tag,
    repo: args.repo,
    assetsDir: args.assets || "",
    dockerImage: args.dockerImage,
    changelog: args.changelog,
    changelogEn: args.changelogEn,
  };
  const notes = buildReleaseNotes(options);
  if (args.out) {
    fs.writeFileSync(args.out, notes, "utf8");
    console.log(
      `[release-notes] ${args.tag} 正文已写入 ${args.out}（${notes.split("\n").length} 行，${args.assets ? "含下载表" : "无下载表"}）`,
    );
  } else {
    process.stdout.write(notes);
  }
}

// 仅在直接执行时运行；被测试 import 时不触发。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
