#!/usr/bin/env node
/**
 * Release 资产跨仓同步：GitHub Release → Gitea / Gitee。
 *
 * 设计要点（与 .cmp 里的发布链路设计一致）：
 *  - GitHub 负责 Windows / macOS / iOS 构建（需要 Windows/macOS runner，Gitea act_runner 做不到）；
 *  - 构建产物先发到 GitHub Release，再由本脚本搬运到 Gitea（主仓）与 Gitee（镜像）；
 *  - 幂等：目标端 release 已存在则复用，资产按「文件名 + 大小」判定，已存在跳过；
 *  - 可重入：每次执行都是「补齐缺口」，失败后重跑即可，不需要重建；
 *  - Gitee 单附件上限 100MB，超限直接报错并列出文件（不静默截断）。
 *
 * 用法：
 *   node scripts/sync-release-assets.mjs --tag <TAG> --targets gitea,gitee
 *   node scripts/sync-release-assets.mjs --targets gitea --dry-run     # tag 自动推断
 *
 * tag 解析顺序（不写死版本，发版不用改脚本）：
 *   --tag 参数 > 环境变量 RELEASE_TAG / GITHUB_REF_NAME（refs/tags/ 前缀自动剥离）
 *   > git describe --tags --abbrev=0 > 根 package.json 的 version
 *
 * 环境变量：
 *   GITHUB_TOKEN          读取 GitHub Release（私有仓库必需）
 *   GITHUB_REPO           owner/repo，默认从 package.json repository 推断
 *   GITEA_URL             https://git.betheone.cc.cd
 *   GITEA_TOKEN           需要 repo 写权限
 *   GITEA_REPO            wushuzhilu/BaseForge
 *   GITEE_TOKEN           access_token
 *   GITEE_REPO            owner/repo
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const GITEE_MAX_ASSET_BYTES = 100 * 1024 * 1024;

function parseArgs(argv) {
  const args = { tag: "", targets: ["gitea"], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--tag") args.tag = argv[++i] || "";
    else if (item === "--targets") args.targets = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (item === "--dry-run") args.dryRun = true;
    else if (item === "--help" || item === "-h") {
      console.log("用法: node scripts/sync-release-assets.mjs --tag <vX.Y.Z> [--targets gitea,gitee] [--dry-run]");
      process.exit(0);
    }
  }
  return args;
}

function requireEnv(name, { optional = false } = {}) {
  const value = process.env[name];
  if (!value && !optional) {
    console.error(`[sync] 缺少环境变量 ${name}`);
    process.exit(2);
  }
  return value || "";
}

function repoFromPackageJson() {
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url || "";
    const match = raw.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (match) return `${match[1]}/${match[2]}`;
  } catch {
    /* ignore */
  }
  return "";
}

/** 版本号不写死：tag 依次从参数/CI 环境/git/package.json 推断。 */
function resolveTag(explicit) {
  const strip = (value) => value.replace(/^refs\/tags\//, "").trim();
  if (explicit) return strip(explicit);
  const fromEnv = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
  if (fromEnv) return strip(fromEnv);
  try {
    const { execSync } = require("node:child_process");
    const described = execSync("git describe --tags --abbrev=0", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (described) return strip(described);
  } catch {
    /* 没有 tag 时回退到 package.json */
  }
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    if (pkg.version) return `v${pkg.version}`;
  } catch {
    /* ignore */
  }
  return "";
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function ghFetch(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${init.method || "GET"} ${url} -> ${response.status} ${await response.text().catch(() => "")}`);
  return response;
}

/** 取 GitHub Release + 资产列表；资产下载走 API（私有仓库不能用浏览器直链）。 */
async function fetchGithubRelease(repo, tag, token) {
  const res = await ghFetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, token);
  const release = await res.json();
  return {
    tag,
    name: release.name || tag,
    body: release.body || "",
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      size: asset.size,
      url: asset.url,
      contentType: asset.content_type || "application/octet-stream",
    })),
  };
}

async function downloadAsset(asset, token, dir) {
  const target = path.join(dir, asset.name);
  const res = await ghFetch(asset.url, token, { headers: { Accept: "application/octet-stream" } });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target));
  const stat = fs.statSync(target);
  if (stat.size !== asset.size) throw new Error(`下载不完整: ${asset.name} (${stat.size}/${asset.size})`);
  return target;
}

async function createGiteaRelease({ baseUrl, token, repo, tag, name, body, dryRun }) {
  const headers = { Authorization: `token ${token}`, "Content-Type": "application/json" };
  const existing = await fetch(`${baseUrl}/api/v1/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  if (existing.ok) {
    const release = await existing.json();
    console.log(`[gitea] release 已存在 #${release.id}，复用`);
    return { id: release.id, assets: (release.assets || []).map((a) => ({ name: a.name, size: a.size })) };
  }
  if (dryRun) {
    console.log(`[gitea] (dry-run) 将创建 release ${tag}`);
    return { id: 0, assets: [] };
  }
  const res = await fetch(`${baseUrl}/api/v1/repos/${repo}/releases`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tag_name: tag, name, body, draft: false, prerelease: tag.includes("-") }),
  });
  if (!res.ok) throw new Error(`[gitea] 创建 release 失败: ${res.status} ${await res.text()}`);
  const release = await res.json();
  console.log(`[gitea] release 创建成功 #${release.id}`);
  return { id: release.id, assets: [] };
}

async function uploadGiteaAsset({ baseUrl, token, repo, releaseId, file, existing, dryRun }) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  if (existing.some((a) => a.name === name && a.size === size)) {
    console.log(`[gitea] 跳过已存在资产 ${name}`);
    return;
  }
  if (dryRun) {
    console.log(`[gitea] (dry-run) 将上传 ${name} (${humanSize(size)})`);
    return;
  }
  const form = new FormData();
  form.append("attachment", new Blob([fs.readFileSync(file)]), name);
  const res = await fetch(`${baseUrl}/api/v1/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { Authorization: `token ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`[gitea] 上传 ${name} 失败: ${res.status} ${await res.text()}`);
  console.log(`[gitea] 已上传 ${name} (${humanSize(size)})`);
}

async function createGiteeRelease({ baseUrl, token, repo, tag, name, body, dryRun }) {
  const qs = `access_token=${encodeURIComponent(token)}`;
  const headers = { "Content-Type": "application/json;charset=UTF-8" };
  const existing = await fetch(`${baseUrl}/api/v5/repos/${repo}/releases/tags/${encodeURIComponent(tag)}?${qs}`);
  if (existing.ok) {
    const release = await existing.json();
    console.log(`[gitee] release 已存在 #${release.id}，复用`);
    return { id: release.id, assets: (release.assets || []).map((a) => ({ name: a.name, size: a.size })) };
  }
  if (dryRun) {
    console.log(`[gitee] (dry-run) 将创建 release ${tag}`);
    return { id: 0, assets: [] };
  }
  const res = await fetch(`${baseUrl}/api/v5/repos/${repo}/releases?${qs}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tag_name: tag, name, body, prerelease: tag.includes("-"), target_commitish: "main" }),
  });
  if (!res.ok) throw new Error(`[gitee] 创建 release 失败: ${res.status} ${await res.text()}`);
  const release = await res.json();
  console.log(`[gitee] release 创建成功 #${release.id}`);
  return { id: release.id, assets: [] };
}

async function uploadGiteeAsset({ baseUrl, token, repo, releaseId, file, existing, dryRun }) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  if (size > GITEE_MAX_ASSET_BYTES) {
    throw new Error(`[gitee] ${name} 大小 ${humanSize(size)} 超过 Gitee 单附件 100MB 限制，需要分卷或改用外链`);
  }
  if (existing.some((a) => a.name === name && a.size === size)) {
    console.log(`[gitee] 跳过已存在资产 ${name}`);
    return;
  }
  if (dryRun) {
    console.log(`[gitee] (dry-run) 将上传 ${name} (${humanSize(size)})`);
    return;
  }
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)]), name);
  const res = await fetch(`${baseUrl}/api/v5/repos/${repo}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`[gitee] 上传 ${name} 失败: ${res.status} ${await res.text()}`);
  console.log(`[gitee] 已上传 ${name} (${humanSize(size)})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tag = resolveTag(args.tag);
  if (!tag) {
    console.error("[sync] 无法确定 tag：请传 --tag，或设置 RELEASE_TAG，或先打 git tag");
    process.exit(2);
  }
  args.tag = tag;
  const githubToken = requireEnv("GITHUB_TOKEN");
  const githubRepo = process.env.GITHUB_REPO || repoFromPackageJson();
  if (!githubRepo) {
    console.error("[sync] 无法推断 GITHUB_REPO，请显式设置环境变量");
    process.exit(2);
  }

  console.log(`[sync] 源 GitHub ${githubRepo} tag=${args.tag} → 目标 ${args.targets.join(",")}`);
  const release = await fetchGithubRelease(githubRepo, args.tag, githubToken);
  if (!release.assets.length) {
    console.error("[sync] GitHub Release 没有任何资产，终止");
    process.exit(1);
  }
  console.log(`[sync] 资产 ${release.assets.length} 个：${release.assets.map((a) => `${a.name}(${humanSize(a.size)})`).join(", ")}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "baseforge-release-"));
  const files = [];
  for (const asset of release.assets) {
    files.push(await downloadAsset(asset, githubToken, tmpDir));
  }
  console.log(`[sync] 已下载到 ${tmpDir}`);

  let failed = false;
  for (const target of args.targets) {
    try {
      if (target === "gitea") {
        const baseUrl = requireEnv("GITEA_URL").replace(/\/+$/, "");
        const token = requireEnv("GITEA_TOKEN");
        const repo = requireEnv("GITEA_REPO");
        const state = await createGiteaRelease({ baseUrl, token, repo, tag: release.tag, name: release.name, body: release.body, dryRun: args.dryRun });
        for (const file of files) await uploadGiteaAsset({ baseUrl, token, repo, releaseId: state.id, file, existing: state.assets, dryRun: args.dryRun });
      } else if (target === "gitee") {
        const baseUrl = (process.env.GITEE_URL || "https://gitee.com").replace(/\/+$/, "");
        const token = requireEnv("GITEE_TOKEN");
        const repo = requireEnv("GITEE_REPO");
        const state = await createGiteeRelease({ baseUrl, token, repo, tag: release.tag, name: release.name, body: release.body, dryRun: args.dryRun });
        for (const file of files) await uploadGiteeAsset({ baseUrl, token, repo, releaseId: state.id, file, existing: state.assets, dryRun: args.dryRun });
      } else {
        console.warn(`[sync] 未知目标 ${target}，跳过`);
      }
      console.log(`[sync] ${target} 完成`);
    } catch (error) {
      failed = true;
      console.error(`[sync] ${target} 失败：${error instanceof Error ? error.message : error}`);
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failed) process.exit(1);
  console.log("[sync] 全部目标同步完成");
}

main().catch((error) => {
  console.error("[sync] 未捕获错误：", error);
  process.exit(1);
});
