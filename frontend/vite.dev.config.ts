import { defineConfig, type Plugin, type UserConfig } from "vite"
import baseConfig from "./vite.config"

const config = baseConfig as UserConfig
const backendUrl = process.env.NOWEN_DEV_BACKEND_URL?.trim() || "http://127.0.0.1:3001"
const backendWsUrl = backendUrl
  .replace(/^http:/, "ws:")
  .replace(/^https:/, "wss:")

/**
 * dev-only：后端就绪探测端点。
 *
 * 前端首屏前轮询它，等后端真正 listen 后再挂载 React——否则浏览器那批 /api
 * 请求会撞上 tsx 编译/迁移/重启窗口，vite 代理对每一次失败都打印
 * `http proxy error: ECONNREFUSED`。探测在 dev server 进程内完成，失败不经过
 * 代理，因此不会产生上述日志噪音。生产构建不包含该中间件。
 */
function devBackendReadyPlugin(): Plugin {
  return {
    name: "dev-backend-ready",
    configureServer(server) {
      server.middlewares.use("/__dev/backend-ready", (_req, res) => {
        void fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(2000) })
          .then((probe) => {
            res.statusCode = probe.ok ? 200 : 503
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ ready: probe.ok }))
          })
          .catch(() => {
            res.statusCode = 503
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ ready: false }))
          })
      })
    },
  }
}

export default defineConfig({
  ...config,
  plugins: [...(config.plugins ?? []), devBackendReadyPlugin()],
  server: {
    ...config.server,
    proxy: {
      ...config.server?.proxy,
      "/api": {
        target: backendUrl,
        changeOrigin: true,
      },
      "/ws": {
        target: backendWsUrl,
        ws: true,
        changeOrigin: true,
      },
    },
  },
})

