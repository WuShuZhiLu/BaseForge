#!/usr/bin/env node
/**
 * 把 better-sqlite3 的原生产物重建为「当前 node 运行时」可用的版本。
 *
 * 为什么需要：开发不再走 Electron，原生模块必须匹配当前 node 的 ABI
 * （例如 node 22 → NODE_MODULE_VERSION 127）。用 npm rebuild --build-from-source
 * 依赖本地编译工具链且会被沙箱的批量删除保护拦住，所以这里直接用 prebuild-install
 * 取官方预编译包，快且无需 MSVC。
 *
 * 用法：npm run rebuild:sqlite:node
 * 说明：数据库层后续会从 better-sqlite3 迁到内置 node:sqlite，届时本脚本可删。
 */
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const moduleDir = path.join(rootDir, "backend", "node_modules", "better-sqlite3")

const args = [
  "prebuild-install",
  "--runtime", "node",
  "--target", process.versions.node,
  "--arch", process.arch,
  "--platform", process.platform,
  "--verbose",
]

console.log(`[rebuild-sqlite] node ${process.version} (ABI ${process.versions.modules}) → ${moduleDir}`)
const result = spawnSync("npx", args, { cwd: moduleDir, stdio: "inherit", shell: true })

if (result.status !== 0) {
  console.error("[rebuild-sqlite] 失败：请确认网络可访问预编译包仓库，或改用 node 22 复现原始环境。")
  process.exit(result.status ?? 1)
}

// 立刻验证能加载，避免"装成功但运行时仍不匹配"
const probe = spawnSync(process.execPath, ["-e", "require('better-sqlite3')"], {
  cwd: path.join(rootDir, "backend"),
  encoding: "utf8",
})
if (probe.status !== 0) {
  console.error("[rebuild-sqlite] 安装后仍无法在当前 node 下加载：")
  console.error(probe.stderr?.trim() || probe.stdout?.trim() || "(无输出)")
  process.exit(1)
}
console.log("[rebuild-sqlite] ✓ 已匹配当前 node，可直接 npm run dev")
