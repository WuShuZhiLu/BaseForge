/**
 * 依赖下载源档位（供 `npm run dev` 的自动安装与 `npm run source` 共用）。
 *
 * 默认 external：不注入任何镜像，Electron / ffmpeg 走各自的官方 GitHub Releases，
 * npm 用机器自己的 registry 配置——和全新克隆时的行为一致。
 *
 * cn：把 npm registry 与两个 GitHub 二进制包切到 npmmirror 镜像，供国内网络使用。
 *
 * 选择结果写在仓库根目录的 `.npm-source.json`（已 gitignore）：只记录档位名，
 * 具体镜像地址固定在本文件里维护，避免本地配置和代码各写一份 URL。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))

export const SOURCE_CONFIG_PATH = path.resolve(scriptsDir, "..", ".npm-source.json")

export const SOURCE_PROFILES = {
  external: {
    label: "外网默认源（npm 自身配置，Electron / ffmpeg 走 GitHub Releases）",
    env: {},
  },
  cn: {
    label: "国内镜像（npm registry / Electron / ffmpeg 走 npmmirror）",
    env: {
      npm_config_registry: "https://registry.npmmirror.com/",
      ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/",
      FFMPEG_BINARIES_URL: "https://cdn.npmmirror.com/binaries/ffmpeg-static",
    },
  },
}

export const DEFAULT_SOURCE_PROFILE = "external"

export function isSourceProfile(value) {
  return Object.prototype.hasOwnProperty.call(SOURCE_PROFILES, value)
}

export function readSourceProfile() {
  try {
    const raw = JSON.parse(fs.readFileSync(SOURCE_CONFIG_PATH, "utf8"))
    if (raw && isSourceProfile(raw.profile)) return raw.profile
  } catch {
    // 没有配置文件、内容损坏都按默认外网源处理。
  }
  return DEFAULT_SOURCE_PROFILE
}

export function readSourceEnv() {
  const profile = readSourceProfile()
  return { profile, env: SOURCE_PROFILES[profile].env }
}

export function writeSourceProfile(profile) {
  if (!isSourceProfile(profile)) throw new Error(`未知的依赖源档位：${profile}`)
  if (profile === DEFAULT_SOURCE_PROFILE) {
    fs.rmSync(SOURCE_CONFIG_PATH, { force: true })
    return
  }
  fs.writeFileSync(
    SOURCE_CONFIG_PATH,
    `${JSON.stringify({ profile }, null, 2)}\n`,
    "utf8",
  )
}
