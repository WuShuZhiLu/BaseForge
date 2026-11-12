#!/usr/bin/env node
/**
 * 用后端真实校验链验证一个插件目录。
 *
 * 校验链完全复用 backend/src/plugins/packageValidator.ts 的 validatePluginPackage()：
 * 目录被打成内存 ZIP，再走安装器同一条路径（ZIP 结构 → 禁止文件 → manifest zod schema →
 * 入口/资源存在性 → 限额 → sha256）。
 *
 * 用法（必须用 tsx 运行，才能加载 backend 的 TypeScript 源码）：
 *   node backend/node_modules/tsx/dist/cli.mjs scripts/verify-plugin.mjs examples/plugins/my-plugin
 *
 * 可选参数（用于校验需要 V2.1 门禁或更高宿主版本的贡献式插件）：
 *   --baseforge-version=1.6.0   覆盖宿主版本（默认取 types.ts 的 BASEFORGE_VERSION）
 *   --extensions-v21        打开 extensionsV21 / uiExtensions 门禁
 */
import fs from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".DS_Store"]);

function collectFiles(root, relative = "") {
  const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      files.push(...collectFiles(root, next));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(next);
  }
  return files;
}

async function main() {
  const positional = process.argv.slice(2).filter((item) => !item.startsWith("--"));
  const target = positional[0];
  const options = Object.fromEntries(
    process.argv.slice(2)
      .filter((item) => item.startsWith("--"))
      .map((item) => {
        const [key, ...rest] = item.replace(/^--/, "").split("=");
        return [key, rest.join("=")];
      }),
  );
  if (!target) {
    console.error("用法: node backend/node_modules/tsx/dist/cli.mjs scripts/verify-plugin.mjs <插件目录|插件包.zip> [--baseforge-version=1.6.0] [--extensions-v21]");
    process.exit(2);
  }
  const absolute = path.resolve(process.cwd(), target);
  if (!fs.existsSync(absolute)) {
    console.error(`路径不存在: ${absolute}`);
    process.exit(2);
  }
  const isDirectory = fs.statSync(absolute).isDirectory();
  if (isDirectory && !fs.existsSync(path.join(absolute, "manifest.json"))) {
    console.error(`目录缺少 manifest.json: ${absolute}`);
    process.exit(2);
  }

  const JSZip = (await import("jszip")).default;
  // 后端源码是 TypeScript + ESM 说明符，用动态 import 走 tsx 的 CJS 互操作
  const { validatePluginPackage } = await import("../backend/src/plugins/packageValidator.js");

  let bytes;
  if (isDirectory) {
    const zip = new JSZip();
    for (const relative of collectFiles(absolute)) zip.file(relative, fs.readFileSync(path.join(absolute, relative)));
    bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  } else {
    bytes = fs.readFileSync(absolute);
  }

  const validated = await validatePluginPackage(bytes, {
    ...(options["baseforge-version"] ? { currentVersion: options["baseforge-version"] } : {}),
    ...("extensions-v21" in options ? { extensionsV21: true, uiExtensions: true } : {}),
  });
  const manifest = validated.manifest;

  console.log(`OK  ${manifest.id}@${manifest.version} (apiVersion=${manifest.apiVersion}, runtime=${manifest.runtime})`);
  console.log(`    permissions: ${manifest.permissions.length ? manifest.permissions.join(", ") : "(none)"}`);
  console.log(`    actions: ${manifest.actions?.length ?? 0}  contributes: ${Object.keys(manifest.contributes ?? {}).join(", ") || "(none)"}`);
  console.log(`    files: ${validated.fileCount}  extractedBytes: ${validated.extractedBytes}`);
  console.log(`    sha256: ${validated.checksum}`);
}

main().catch((error) => {
  const headline = error?.issues?.[0]?.message || error?.message || String(error);
  console.error(`FAIL ${error?.code ? `[${error.code}] ` : ""}${headline}`);
  if (error?.issues) for (const issue of error.issues) console.error(`     - ${issue.path?.join(".") || "(root)"}: ${issue.message}`);
  process.exit(1);
});
