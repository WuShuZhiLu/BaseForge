#!/usr/bin/env node

/**
 * 切换依赖下载源。
 *
 *   npm run source status     查看当前档位
 *   npm run source cn         国内镜像（npm registry / Electron / ffmpeg）
 *   npm run source external   外网默认源（等价于不注入任何镜像）
 *
 * 只影响之后由 `npm run dev` 触发的自动安装，不会改动已经装好的 node_modules，
 * 也不会写你的全局 npm 配置。
 */
import process from "node:process"

import {
  DEFAULT_SOURCE_PROFILE,
  SOURCE_PROFILES,
  isSourceProfile,
  readSourceProfile,
  writeSourceProfile,
} from "./npm-sources.mjs"

const USAGE = `用法：npm run source <external|cn|status>
  external  外网默认源（默认；Electron / ffmpeg 走 GitHub Releases）
  cn        国内镜像（npm registry / Electron / ffmpeg 走 npmmirror）
  status    查看当前档位`

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
