#!/usr/bin/env node

/**
 * 切换依赖下载源 / 输出 CI 用的环境变量。
 *
 *   npm run source status           查看当前档位
 *   npm run source cn               国内镜像（npm registry / Electron / ffmpeg）
 *   npm run source external         外网默认源（官方 npm registry + GitHub Releases）
 *   npm run source env [外部|内部]   输出 `export KEY=VALUE` 行，供 CI `eval` 使用
 *
 * `env` 模式给 CI 用：
 *   - GitHub Actions（外网）→ node scripts/npm-source.mjs env external
 *   - Gitea Actions（国内）  → node scripts/npm-source.mjs env cn
 * 它不读写 `.npm-source.json`，档位由参数显式指定，避免把本地选择带进流水线。
 *
 * 其余模式只影响之后由 `npm run dev` 触发的自动安装，不会改动已经装好的
 * node_modules，也不会写你的全局 npm 配置。
 */
import process from "node:process"

import {
  DEFAULT_SOURCE_PROFILE,
  SOURCE_PROFILES,
  isSourceProfile,
  readSourceProfile,
  writeSourceProfile,
} from "./npm-sources.mjs"

const USAGE = `用法：npm run source <external|cn|status|env [external|cn]>
  external  外网默认源（默认；npm 官方 registry + GitHub Releases）
  cn        国内镜像（npm registry / Electron / ffmpeg 走 npmmirror）
  status    查看当前档位
  env       输出 export 语句，供 CI eval 使用（默认 external）`

/**
 * 输出环境变量。
 *   默认 KEY=VALUE（可直接追加进 $GITHUB_ENV）
 *   --export 输出 export KEY='VALUE'（供 shell eval，如 Gitea runner）
 */
function printEnv(profile, mode) {
  const entries = Object.entries({
    ...SOURCE_PROFILES[profile].env,
    BASEFORGE_NPM_SOURCE: profile,
  })
  for (const [key, value] of entries) {
    console.log(mode === "export" ? `export ${key}='${value}'` : `${key}=${value}`)
  }
}

function printStatus() {
  const profile = readSourceProfile()
  console.log(`当前依赖源：${profile} —— ${SOURCE_PROFILES[profile].label}`)
  const env = SOURCE_PROFILES[profile].env
  const keys = Object.keys(env)
  if (keys.length === 0) {
    console.log("未注入镜像配置。")
    return
  }
  for (const key of keys) console.log(`  ${key}=${env[key]}`)
}

const target = process.argv[2]

if (target === "env") {
  const rest = process.argv.slice(3)
  const exportMode = rest.includes("--export")
  const profile = rest.find((item) => !item.startsWith("--")) || DEFAULT_SOURCE_PROFILE
  if (!isSourceProfile(profile)) {
    console.error(USAGE)
    process.exit(1)
  }
  printEnv(profile, exportMode ? "export" : "plain")
  process.exit(0)
}

if (!target || target === "status") {
  printStatus()
  if (!target) console.log(`\n${USAGE}`)
  process.exit(0)
}

if (!isSourceProfile(target)) {
  console.error(USAGE)
  process.exit(1)
}

if (target === readSourceProfile()) {
  console.log(`依赖源已是 ${target}，无需切换。`)
  process.exit(0)
}

writeSourceProfile(target)
console.log(`已切换依赖源：${target} —— ${SOURCE_PROFILES[target].label}`)
if (target === DEFAULT_SOURCE_PROFILE) {
  console.log("外网源会从 GitHub Releases 下载 Electron / ffmpeg，网络受限时可能很慢。")
} else {
  console.log("下次 npm run dev 自动补装依赖时生效；已装好的 node_modules 不受影响。")
}
