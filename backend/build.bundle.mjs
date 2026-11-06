#!/usr/bin/env node
/**
 * 后端生产构建：用 esbuild 把整个后端打成单文件 dist/index.js
 *
 * 目的：把 100MB+ 的 backend/node_modules 砍成只剩 4 个真正必须保留为 external 的包，
 * 显著减少 electron 安装包体积（实测 -55MB 解压 / -25MB 压缩）。
 *
 * external 名单（必须保留为 external 的原因）：
 *   - better-sqlite3            含原生 .node，必须 require 真实文件
 *   - sqlite-vec / sqlite-vec-windows-x64 / sqlite-vec-darwin-* / sqlite-vec-linux-*
 *                               平台相关二进制 .so/.dylib/.dll，runtime 探测路径
 *   - bonjour-service           含 multicast-dns 等动态加载的 native-ish 行为
 *   - @aws-sdk/client-s3   unzipper 的可选 AWS SDK require，思源导入只用本地文件
 *   - smb3-client 不在名单：纯 ESM、无动态 require，动态 import 可被正常内联
 *
 * 其他业务依赖（hono, ws, jsonwebtoken, mammoth, jszip, yjs, zod 等）全部 inline 进 bundle。
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, mkdirSync, statSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, "dist");
const outfile = join(outdir, "index.js");

// 干净起步，避免上次 tsc 残留的 d.ts 等无关产物混在里面
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const external = [
  "sqlite-vec",
  "sqlite-vec-windows-x64",
  "sqlite-vec-darwin-x64",
  "sqlite-vec-darwin-arm64",
  "sqlite-vec-linux-x64",
  "bonjour-service",
  "unpdf",
  // unzipper 的 S3_v3 辅助函数里有可选 AWS SDK require；思源导入只用本地文件。
  "@aws-sdk/client-s3",
];

const start = Date.now();
await build({
  entryPoints: [join(__dirname, "src", "index.hardened.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile,
  external,
  treeShaking: true,
  // v1.4.2 后业务代码显著增长，完全不压缩的单文件 bundle 会放大 Windows Defender
  // 扫描、portable 解压和 Node 解析成本。只压缩语法与空白，保留函数/类标识符，
  // 兼顾启动速度、安装包体积和生产报错栈可读性。
  minifySyntax: true,
  minifyWhitespace: true,
  minifyIdentifiers: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  // hono / mammoth 等依赖里偶有 dynamic require，需要明确告诉 esbuild 不要警告
  // （这些都是按需加载，不影响主流程）
  logOverride: {
    "unsupported-dynamic-import": "silent",
    "unsupported-require-call": "silent",
  },
});

const ms = Date.now() - start;
const bundleBytes = statSync(outfile).size;
console.log(
  `[backend bundle] done in ${ms}ms -> ${outfile} (${(bundleBytes / 1024 / 1024).toFixed(2)} MB)`
);
console.log(`[backend bundle] external: ${external.join(", ")}`);
