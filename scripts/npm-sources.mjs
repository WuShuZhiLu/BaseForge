/**
 * 依赖下载源档位（供 `npm run dev` 的自动安装、`npm run source` 与 CI 共用）。
 *
 * 默认 external：不注入镜像 registry，Electron / ffmpeg 走各自的官方 GitHub Releases，
 * npm 用机器自己的 registry 配置——和全新克隆时的行为一致。
 *
 * cn：把 npm registry 与两个 GitHub 二进制包切到 npmmirror 镜像，供国内网络使用。
 *
 * 两个档位都会注入 `replace-registry-host=always`：
 * 仓库里的 lockfile 历史上存过 npmmirror / 腾讯镜像的 `resolved` 地址，而 `npm ci`
 * 会照着 `resolved` 逐条下载、无视 registry 配置。打开这个开关后，npm 会把所有
 * resolved 的 host 换成当前 registry，锁文件不再决定走哪个源：
 *   - external → 官方 registry.npmjs.org
 *   - cn       → registry.npmmirror.com
 *
 * 选择结果写在仓库根目录的 `.npm-source.json`（已 gitignore）：只记录档位名，
 * 具体镜像地址固定在本文件里维护，避免本地配置和代码各写一份 URL。
 * CI 不读这个文件，用 `node scripts/npm-source.mjs env <profile>` 现取环境变量。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))

export const SOURCE_CONFIG_PATH = path.resolve(scriptsDir, "..", ".npm-source.json")

/** 让 registry 配置覆盖 lockfile 里的 resolved host；两档都需要的公共项。 */
const REPLACE_REGISTRY_HOST_ENV = {
  npm_config_replace_registry_host: "always",
}

export const SOURCE_PROFILES = {
  external: {
    label: "外网默认源（npm 自身配置，Electron / ffmpeg 走 GitHub Releases）",
    env: {
      ...REPLACE_REGISTRY_HOST_ENV,
      npm_config_registry: "https://registry.npmjs.org/",
    },
  },
  cn: {
    label: "国内镜像（npm registry / Electron / ffmpeg 走 npmmirror）",
    env: {
      ...REPLACE_REGISTRY_HOST_ENV,
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
