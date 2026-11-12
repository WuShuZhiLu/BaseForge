#!/usr/bin/env node
/**
 * lockfile registry 规范化 / 校验。
 *
 * 背景：国内镜像（腾讯、npmmirror 等）会把 `resolved` 写成镜像地址。
 * 腾讯镜像的路径带 `/npm/` 前缀，而 npm 的 `replace-registry-host=always`
 * 只替换 host、不处理路径，于是会拼出 `registry.npmjs.org/npm/<pkg>/...` 这类 404。
 *
 * 用法：
 *   node scripts/normalize-lockfile-registry.mjs          仅校验，非官方地址则失败
 *   node scripts/normalize-lockfile-registry.mjs --write  就地改写为官方地址
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCKFILES = ["package-lock.json", "backend/package-lock.json", "frontend/package-lock.json"];
const OFFICIAL = "https://registry.npmjs.org";
const MIRROR_HOSTS = new Set([
  "registry.npmmirror.com",
  "registry.npm.taobao.org",
  "registry.cnpmjs.org",
  "mirrors.tencent.com",
  "mirrors.cloud.tencent.com",
]);
const write = process.argv.includes("--write");

function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  let pathname = url.pathname;
  const isMirror = MIRROR_HOSTS.has(url.hostname);
  if (!isMirror && url.hostname !== "registry.npmjs.org") return null;
  if (url.hostname === "registry.npmjs.org" && !pathname.startsWith("/npm/")) return null;
  // 腾讯镜像：/npm/pkg/-/... -> /pkg/-/...
  if (pathname.startsWith("/npm/")) pathname = pathname.slice(4);
  const next = `${OFFICIAL}${pathname}${url.search}${url.hash}`;
  return next === raw ? null : next;
}

let violations = 0;
let fixed = 0;
for (const rel of LOCKFILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  let touched = false;
  for (const [name, pkg] of Object.entries(data.packages || {})) {
    const resolved = pkg.resolved;
    if (!resolved) continue;
    const next = normalizeUrl(resolved);
    if (!next) continue;
    if (write) {
      pkg.resolved = next;
      touched = true;
      fixed += 1;
    } else {
      violations += 1;
      console.error(`[lockfile] ${rel} → ${name || "<root>"}\n  ${resolved}`);
    }
  }
  if (touched) fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

if (write) {
  console.log(`[lockfile] 已规范化 ${fixed} 条 resolved 地址`);
  process.exit(0);
}
if (violations > 0) {
  console.error(
    `\n[lockfile] 发现 ${violations} 条非官方 registry 地址。` +
      `\n  修复：node scripts/normalize-lockfile-registry.mjs --write\n` +
      `  然后提交三个 lockfile。`,
  );
  process.exit(1);
}
console.log("[lockfile] registry 地址均为官方 registry.npmjs.org");
