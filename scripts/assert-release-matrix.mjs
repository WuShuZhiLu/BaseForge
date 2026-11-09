#!/usr/bin/env node
/**
 * 发版资产矩阵断言：确认 GitHub Release 的资产目录里 full / Lite × win / mac / linux
 * 六套产物齐全，且更新元数据没有互相污染。
 *
 * 为什么需要它：
 *   - full 与 Lite 的 Linux 更新元数据都由 electron-builder 生成，文件名可能同样叫
 *     latest-linux.yml；下载到同一个目录会静默覆盖，结果 Release 看着「资产齐全」，
 *     实际 full 的 AppImage 失去元数据引用（或被 Lite 顶替）。
 *   - 缺一个平台的 Lite 也不会让任何现有校验失败，只会在用户下载页空一格。
 *
 * 用法：
 *   node scripts/assert-release-matrix.mjs --dir release-assets --version 0.2.0
 */
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const options = { dir: ".", version: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") options.dir = argv[++i];
    else if (arg === "--version") options.version = String(argv[++i] || "").replace(/^v/, "");
    else if (arg === "--help" || arg === "-h") {
      console.log("用法：node scripts/assert-release-matrix.mjs --dir <资产目录> --version <x.y.z>");
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!options.version) throw new Error("必须提供 --version（不带 v 前缀）");
  return options;
}

const METADATA_RE = /^(?:latest(?:-[a-z0-9._-]+)?|lite(?:-[a-z0-9._-]+)?)\.ya?ml$/i;

function readFileList(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function isLiteName(name) {
  return /-lite[-.]/i.test(name);
}

/** 从 electron-updater 元数据里取出 files[].url 引用的文件名 */
function referencedAssets(metadataPath) {
  const text = fs.readFileSync(metadataPath, "utf8");
  const names = [];
  for (const match of text.matchAll(/^\s*-\s+url:\s*(.+)$/gm)) {
    const url = match[1].trim().replace(/^["']|["']$/g, "");
    names.push(decodeURIComponent(url.split("/").pop()));
  }
  return names;
}

function main() {
  const { dir, version } = parseArgs(process.argv.slice(2));
  const directory = path.resolve(dir);
  if (!fs.existsSync(directory)) throw new Error(`资产目录不存在：${directory}`);

  const files = readFileList(directory);
  const has = (name) => files.includes(name);
  const matches = (re) => files.filter((name) => re.test(name));

  const errors = [];

  const requireExact = (name, label) => {
    if (!has(name)) errors.push(`${label} 缺失：${name}`);
  };
  const requirePattern = (re, label, count = 1) => {
    const found = matches(re);
    if (found.length < count) errors.push(`${label} 缺失（期望 ≥${count} 个，匹配 ${re}）`);
    return found;
  };

  // ---------- Windows ----------
  requireExact(`BaseForge-${version}-setup.exe`, "Windows 安装版（full）");
  requireExact(`BaseForge-${version}-portable.exe`, "Windows 免安装版（full）");
  requireExact(`BaseForge-Lite-${version}-setup.exe`, "Windows 安装版（Lite）");
  requireExact(`BaseForge-Lite-${version}-portable.exe`, "Windows 免安装版（Lite）");

  // ---------- macOS ----------
  for (const arch of ["x64", "arm64"]) {
    for (const ext of ["dmg", "zip"]) {
      requireExact(`BaseForge-${version}-${arch}.${ext}`, `macOS ${arch} ${ext}（full）`);
      requireExact(`BaseForge-Lite-${version}-${arch}.${ext}`, `macOS ${arch} ${ext}（Lite）`);
    }
  }

  // ---------- Linux ----------
  requirePattern(new RegExp(`^BaseForge-${version.replace(/\./g, "\\.")}-[A-Za-z0-9_]+\\.AppImage$`), "Linux AppImage（full）");
  requirePattern(new RegExp(`^BaseForge-${version.replace(/\./g, "\\.")}-[A-Za-z0-9_]+\\.deb$`), "Linux deb（full）");
  requirePattern(new RegExp(`^BaseForge-Lite-${version.replace(/\./g, "\\.")}-[A-Za-z0-9_]+\\.AppImage$`), "Linux AppImage（Lite）");
  requirePattern(new RegExp(`^BaseForge-Lite-${version.replace(/\./g, "\\.")}-[A-Za-z0-9_]+\\.deb$`), "Linux deb（Lite）");

  // ---------- MCP ----------
  requireExact("baseforge-mcp.mjs", "MCP 单文件");

  // ---------- 更新元数据 ----------
  requireExact("latest.yml", "Windows 更新元数据（full）");
  requireExact("latest-linux.yml", "Linux 更新元数据（full）");
  requireExact("latest-mac.yml", "macOS 更新元数据（full）");

  const metadataFiles = files.filter((name) => METADATA_RE.test(name));
  const liteMetadata = metadataFiles.filter((name) => isLiteName(name));
  if (liteMetadata.length === 0) {
    errors.push("缺少 Lite 的更新元数据（latest-lite*.yml）");
  }

  for (const name of metadataFiles) {
    const refs = referencedAssets(path.join(directory, name));
    if (refs.length === 0) errors.push(`${name} 未引用任何资产`);

    const liteMetadataFile = isLiteName(name);
    for (const ref of refs) {
      if (!has(ref)) errors.push(`${name} 引用的资产不存在：${ref}`);
      const refIsLite = isLiteName(ref);
      if (liteMetadataFile && !refIsLite) {
        errors.push(`${name} 是 Lite 的元数据，却引用了 full 资产：${ref}（元数据已被覆盖？）`);
      }
      if (!liteMetadataFile && refIsLite) {
        errors.push(`${name} 是 full 的元数据，却引用了 Lite 资产：${ref}（元数据已被覆盖？）`);
      }
    }
  }

  if (errors.length > 0) {
    console.error(`[release-matrix] ${version} 资产矩阵不完整：`);
    for (const error of errors) console.error(`  - ${error}`);
    console.error(`[release-matrix] 目录内容：\n${files.sort().map((name) => `  ${name}`).join("\n")}`);
    process.exit(1);
  }

  console.log(`[release-matrix] ${version} 资产矩阵完整（${files.length} 个资产，元数据 ${metadataFiles.length} 份）`);
}

main();
