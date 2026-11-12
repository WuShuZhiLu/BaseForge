import path from "node:path"
import process from "node:process"
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { forceReleasePorts } from "./dev-port-manager.mjs"
import { ensureWorkspaceDependencies } from "./dev-dependency-manager.mjs"
import { readSourceEnv } from "./npm-sources.mjs"

const __filename = fileURLToPath(import.meta.url)
const scriptsDir = path.dirname(__filename)
const rootDir = path.resolve(scriptsDir, "..")
const backendDir = path.join(rootDir, "backend")
const frontendDir = path.join(rootDir, "frontend")

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback
}

function assertFile(filePath, installHint) {
  if (!existsSync(filePath)) {
    console.error(`\n[dev] 缺少依赖文件：${path.relative(rootDir, filePath)}`)
    console.error(`[dev] 请先执行：${installHint}\n`)
    process.exit(1)
  }
}

const backendPort = parsePort(
  process.env.BASEFORGE_DEV_BACKEND_PORT ?? process.env.PORT,
  3001,
)
const frontendPort = parsePort(process.env.BASEFORGE_DEV_FRONTEND_PORT, 5173)

if (backendPort === frontendPort) {
  console.error(`\n[dev] 前后端不能使用同一个端口：${backendPort}\n`)
  process.exit(1)
}

const backendUrl = `http://127.0.0.1:${backendPort}`
const frontendUrl = `http://localhost:${frontendPort}`

// 依赖下载源由 scripts/npm-source.mjs 切换（默认外网源）；这里只读取当前档位。
// 外部已设置的同名环境变量优先，避免覆盖用户自己的镜像配置。
const { profile: sourceProfile, env: sourceEnv } = readSourceEnv()
const installEnv = {}
for (const [key, value] of Object.entries(sourceEnv)) {
  if (!process.env[key]) installEnv[key] = value
}

console.log("\n[dev] 正在检查项目依赖...")
console.log(`[dev] 依赖下载源：${sourceProfile === "cn" ? "国内镜像" : "外网默认"}`)
try {
  ensureWorkspaceDependencies(rootDir, "根目录", { env: installEnv })
  ensureWorkspaceDependencies(backendDir, "后端", { env: installEnv })
  ensureWorkspaceDependencies(frontendDir, "前端", { env: installEnv })
} catch (error) {
  console.error(`\n[dev] 依赖检查失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

// 开发环境只用系统 node 22 跑前后端，不依赖 Electron（迁移/测试也走同一运行时）。
const tsxCli = path.join(backendDir, "node_modules", "tsx", "dist", "cli.mjs")
const backendEntry = path.join(backendDir, "src", "index.hardened.ts")
const viteCli = path.join(frontendDir, "node_modules", "vite", "bin", "vite.js")
const viteDevConfig = path.join(frontendDir, "vite.dev.config.ts")

assertFile(tsxCli, "npm run install:all")
assertFile(viteCli, "npm run install:all")
assertFile(backendEntry, "确认 backend/src/index.hardened.ts 是否存在")
assertFile(viteDevConfig, "确认 frontend/vite.dev.config.ts 是否存在")

// node 版本下限：22.5 起才有内置 node:sqlite（数据库层已迁移过去）。
// 低于这个版本直接叫停，避免后端跑到一半才因为缺 API 崩掉。
const MIN_NODE = [22, 5, 0]
{
  const current = process.versions.node.split(".").map((part) => Number.parseInt(part, 10))
  const tooOld =
    current[0] < MIN_NODE[0] ||
    (current[0] === MIN_NODE[0] && current[1] < MIN_NODE[1])
  if (tooOld) {
    console.error(
      [
        "",
        `[dev] 当前 node ${process.version} 过低，本项目要求 >= v${MIN_NODE.join(".")}。`,
        "      v22.5 起才有内置 node:sqlite（数据库层已迁移过去）。",
        "      请切换到 node 22.5+ 后重跑：nvm use 22（或把 node 22 放到 PATH 前面）。",
        "",
      ].join("\n"),
    )
    process.exit(1)
  }
}

// 数据库层已迁到内置 node:sqlite，不再有原生 SQLite 模块的 ABI 问题。
// 只确认当前 node 确实提供了 node:sqlite（避免使用被裁剪的 node 构建）。
console.log("[dev] 检查内置 node:sqlite 是否可用…")
{
  const probe = spawnSync(
    process.execPath,
    ["-e", "require('node:sqlite')"],
    { cwd: backendDir, encoding: "utf8" },
  )
  if (probe.status !== 0) {
    console.error(
      [
        "",
        `[dev] 当前 node ${process.version} 未提供内置 node:sqlite。`,
        "      请使用官方 node 22.5+（v22.5 起内置），切换后重跑 npm run dev。",
        "",
      ].join("\n"),
    )
    process.exit(1)
  }
}

console.log("\n[dev] 正在检查开发端口...")
try {
  await forceReleasePorts([
    { label: "后端", port: backendPort },
    { label: "前端", port: frontendPort },
  ])
} catch (error) {
  console.error(`\n[dev] 无法释放开发端口：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

console.log("\n🚀 BaseForge 开发环境")
console.log(`   前端: ${frontendUrl}`)
console.log(`   后端: ${backendUrl}`)
console.log("   依赖变更时会自动执行对应目录的 npm install")
console.log("   端口冲突时会强制停止占用进程并重新启动")
console.log("   按 Ctrl+C 可同时停止前后端\n")

const children = []
let stopping = false

function startProcess(label, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: "inherit",
    detached: process.platform !== "win32",
    windowsHide: false,
  })

  children.push(child)

  child.once("error", (error) => {
    console.error(`[dev] ${label}启动失败:`, error)
    void shutdown(1)
  })

  child.once("exit", (code, signal) => {
    if (stopping) return
    const reason = signal ? `信号 ${signal}` : `退出码 ${code ?? 1}`
    console.error(`\n[dev] ${label}已退出（${reason}），正在停止其余进程...`)
    void shutdown(code ?? 1)
  })

  return child
}

function terminateChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("error", () => resolve())
      killer.once("exit", () => resolve())
    })
  }

  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {
      // 进程可能已自行退出。
    }
  }

  return Promise.resolve()
}

async function shutdown(exitCode = 0) {
  if (stopping) return
  stopping = true
  await Promise.all(children.map(terminateChild))
  process.exit(exitCode)
}

process.once("SIGINT", () => void shutdown(0))
process.once("SIGTERM", () => void shutdown(0))

const backendChild = startProcess(
  "后端",
  process.execPath,
  // 直接用系统 node22 跑后端：sharp 在 Electron 内置 node（20.18）下会原生崩溃，
  // node22 下正常；数据库用内置 node:sqlite，无原生 ABI 依赖。
  [tsxCli, "watch", backendEntry],
  {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(backendPort),
    },
  },
)

/**
 * 等后端真正 listen 再起前端：vite 两三秒就绪、浏览器立刻打一批 /api，
 * 而后端还在 tsx 编译 + 迁移 + vec-store 初始化，那几秒的请求全是 ECONNREFUSED。
 */
async function waitForBackendReady(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (backendChild.exitCode !== null || backendChild.signalCode !== null) return false
    try {
      const res = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      // 还没 listen，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

console.log(`\n[dev] 等待后端就绪：${backendUrl}/api/health`)
if (!(await waitForBackendReady())) {
  console.error("[dev] 后端未在 120 秒内就绪，前端不启动（请查看上面的后端日志）")
  await shutdown(1)
}

startProcess(
  "前端",
  process.execPath,
  [
    viteCli,
    "--config",
    viteDevConfig,
    "--host",
    "0.0.0.0",
    "--port",
    String(frontendPort),
    "--strictPort",
  ],
  {
    cwd: frontendDir,
    env: {
      ...process.env,
      BASEFORGE_DEV_BACKEND_URL: backendUrl,
      BASEFORGE_DEV_BACKEND_PORT: String(backendPort),
    },
  },
)
