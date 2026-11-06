#!/usr/bin/env node
/**
 * 把 src/index.ts 连同 @modelcontextprotocol/sdk、zod 打成单个 dist/baseforge-mcp.mjs。
 * esbuild 优先从本包 node_modules 解析，找不到则回退仓库根 node_modules。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(pkgDir, "..", "..");

function resolveEsbuild() {
  const candidates = [
    path.join(pkgDir, "node_modules", "esbuild", "lib", "main.js"),
    path.join(repoRoot, "node_modules", "esbuild", "lib", "main.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  console.error("找不到 esbuild：请在仓库根执行 npm install，或在本包内 npm install。");
  process.exit(1);
}

const esbuild = (await resolveEsbuild()).default;

await esbuild.build({
  entryPoints: [path.join(pkgDir, "src", "index.ts")],
  outfile: path.join(pkgDir, "dist", "baseforge-mcp.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: false,
  minify: false,
  legalComments: "none",
});

console.error("已生成 dist/baseforge-mcp.mjs");
