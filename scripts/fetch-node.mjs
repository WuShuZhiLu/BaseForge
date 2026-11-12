#!/usr/bin/env node
/**
 * fetch-node.mjs
 * ----------------------------------------------------------
 * 下载指定版本的 Node.js 官方二进制到 electron/node/<platform>/，
 * 供 electron-builder 通过 extraResources 打进安装包。
 *
 * 为什么必须内嵌：后端用 node:sqlite（Node 22.5+ 才有的内建模块）。
 * Electron 33 基于 Node 20，没有 node:sqlite，所以打包后的后端必须跑
 * 一个真正的 Node 22 二进制，不能退回 ELECTRON_RUN_AS_NODE。
 *
 * 用法：
 *   node scripts/fetch-node.mjs               # 默认仅当前平台
 *   node scripts/fetch-node.mjs --all         # 三平台全下（win/mac/linux x64 + mac arm64）
 *   node scripts/fetch-node.mjs --targets darwin-x64,darwin-arm64   # 只下指定目标
 *   NODE_EMBED_VERSION=v22.23.4 node scripts/fetch-node.mjs
 *
 * 产物目录：
 *   electron/node/win32-x64/node.exe
 *   electron/node/darwin-x64/node
 *   electron/node/darwin-arm64/node
 *   electron/node/linux-x64/node
 */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "electron", "node");

/**
 * 内嵌 Node 版本。必须是 v22.5.0 以上：后端依赖内建 node:sqlite。
 * 22 线是当前 LTS，桌面端后端就跑这个版本。
 */
const VERSION = process.env.NODE_EMBED_VERSION || "v22.23.4";
const MIRROR = process.env.NODE_MIRROR || "https://nodejs.org/dist";

const TARGETS = {
  "win32-x64": {
    url: `${MIRROR}/${VERSION}/node-${VERSION}-win-x64.zip`,
    entry: `node-${VERSION}-win-x64/node.exe`,
    exe: "node.exe",
    kind: "zip",
  },
  "darwin-x64": {
    url: `${MIRROR}/${VERSION}/node-${VERSION}-darwin-x64.tar.gz`,
    entry: `node-${VERSION}-darwin-x64/bin/node`,
    exe: "node",
    kind: "tar.gz",
  },
  "darwin-arm64": {
    url: `${MIRROR}/${VERSION}/node-${VERSION}-darwin-arm64.tar.gz`,
    entry: `node-${VERSION}-darwin-arm64/bin/node`,
    exe: "node",
    kind: "tar.gz",
  },
  "linux-x64": {
    url: `${MIRROR}/${VERSION}/node-${VERSION}-linux-x64.tar.gz`,
    entry: `node-${VERSION}-linux-x64/bin/node`,
    exe: "node",
    kind: "tar.gz",
  },
};

function currentKey() {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32") return "win32-x64";
  if (p === "darwin") return a === "arm64" ? "darwin-arm64" : "darwin-x64";
  return "linux-x64";
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function download(url, dest) {
  console.log(`[fetch-node] GET ${url}`);
  return new Promise((resolve, reject) => {
    const doReq = (u) => {
      https.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return doReq(new URL(res.headers.location, u).toString());
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} on ${u}`));
        }
        const fd = fs.createWriteStream(dest);
        res.pipe(fd);
        fd.on("finish", () => fd.close(() => resolve()));
        fd.on("error", reject);
      }).on("error", reject);
    };
    doReq(url);
  });
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function extractZip(zipPath, entry, outFile) {
  const tmpDir = path.join(path.dirname(outFile), ".tmp-zip");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  ensureDir(tmpDir);

  try {
    let result;
    if (process.platform === "win32") {
      // GitHub Windows Runner 下 Git Bash 的 tar 会把 D:\... 误解析成远程主机路径，
      // 出现 `tar: Cannot connect to D: resolve failed`。Windows ZIP 明确交给
      // PowerShell Expand-Archive，避免路径语义经过 MSYS/tar 二次转换。
      const command = [
        "Expand-Archive",
        "-LiteralPath",
        powershellLiteral(zipPath),
        "-DestinationPath",
        powershellLiteral(tmpDir),
        "-Force",
      ].join(" ");
      result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { stdio: "inherit", windowsHide: true },
      );
      if (result.error) {
        throw new Error(`PowerShell Expand-Archive 启动失败：${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(`PowerShell Expand-Archive 失败（exit=${result.status ?? "unknown"}）`);
      }
    } else {
      // macOS/Linux 保留系统 tar，bsdtar/gnu tar 都可稳定读取 Node 官方 zip。
      result = spawnSync("tar", ["-xf", zipPath, "-C", tmpDir], { stdio: "inherit" });
      if (result.error) {
        throw new Error(`系统 tar 启动失败：${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(`系统 tar 无法解压 zip（exit=${result.status ?? "unknown"}）`);
      }
    }

    const src = path.join(tmpDir, entry);
    if (!fs.existsSync(src) || fs.statSync(src).size <= 0) {
      throw new Error(`ZIP 解压成功但未找到目标文件：${entry}`);
    }
    fs.copyFileSync(src, outFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function extractTarGz(tgzPath, entry, outFile) {
  // 使用系统 tar（macOS/Linux/Win10+ 均自带）
  const tmpDir = path.join(path.dirname(outFile), ".tmp-tgz");
  ensureDir(tmpDir);
  const r = spawnSync("tar", ["-xzf", tgzPath, "-C", tmpDir, entry], { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error("tar -xzf 失败");
  }
  const src = path.join(tmpDir, entry);
  fs.copyFileSync(src, outFile);
  if (process.platform !== "win32") {
    fs.chmodSync(outFile, 0o755);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function fetchOne(key) {
  const cfg = TARGETS[key];
  if (!cfg) throw new Error(`unknown target: ${key}`);
  const platDir = path.join(OUT_DIR, key);
  const outFile = path.join(platDir, cfg.exe);
  // 版本戳：NODE_EMBED_VERSION 变了必须重下，否则会拿旧版本二进制打进包，
  // 表现为「明明改了版本，装完还是旧的 node」。
  //
  // 但已有二进制时不要盲下：之前下过的目录里没有戳（或戳是旧格式）很常见，
  // 直接问它自己的版本就能判断，省掉几十 MB 的无谓下载。
  const stampFile = path.join(platDir, ".version");
  const stamp = fs.existsSync(stampFile)
    ? fs.readFileSync(stampFile, "utf8").trim()
    : "";

  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
    if (stamp === VERSION) {
      console.log(`[fetch-node] ✓ ${key} already exists (${VERSION}), skip`);
      return;
    }
    // 同平台才能执行探测；跨平台（例如在 Linux 上备 win32-x64）只能信戳
    const hostMatches = key.split("-")[0] === process.platform;
    if (hostMatches) {
      const probe = spawnSync(outFile, ["-p", "process.versions.node"], { encoding: "utf8" });
      const actual = (probe.stdout || "").trim();
      if (probe.status === 0 && actual === VERSION.replace(/^v/, "")) {
        fs.writeFileSync(stampFile, VERSION);
        console.log(`[fetch-node] ✓ ${key} already v${actual}，补写版本戳后跳过`);
        return;
      }
      if (probe.status === 0 && actual) {
        console.log(`[fetch-node] ${key} 现有 v${actual}，目标 ${VERSION}，重新下载`);
      }
    }
  }
  ensureDir(platDir);

  const archivePath = path.join(platDir, `_download.${cfg.kind.replace(".", "_")}`);
  await download(cfg.url, archivePath);

  if (cfg.kind === "zip") {
    await extractZip(archivePath, cfg.entry, outFile);
  } else {
    await extractTarGz(archivePath, cfg.entry, outFile);
  }
  fs.unlinkSync(archivePath);
  fs.writeFileSync(stampFile, VERSION);
  console.log(`[fetch-node] ✓ ${key} -> ${outFile} (${VERSION})`);
}

async function main() {
  ensureDir(OUT_DIR);
  // .gitignore 保护：避免把巨大的 node 二进制提交进仓库
  const gi = path.join(OUT_DIR, ".gitignore");
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, "*\n!.gitignore\n");
  }

  const all = process.argv.includes("--all");
  const targetsIndex = process.argv.indexOf("--targets");
  const targetsArg = targetsIndex >= 0 ? (process.argv[targetsIndex + 1] || "") : "";
  const requested = targetsArg.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = requested.filter((key) => !TARGETS[key]);
  if (unknown.length > 0) {
    console.error(`[fetch-node] 未知目标：${unknown.join(", ")}；可选：${Object.keys(TARGETS).join(", ")}`);
    process.exit(1);
  }
  const keys = all ? Object.keys(TARGETS) : requested.length > 0 ? requested : [currentKey()];
  console.log(`[fetch-node] version=${VERSION}, targets=${keys.join(", ")}`);

  for (const k of keys) {
    try {
      await fetchOne(k);
    } catch (e) {
      console.error(`[fetch-node] ✗ ${k}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

main();
