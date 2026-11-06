# baseforge-mcp

BaseForge 的本地 stdio MCP Server，让支持 Model Context Protocol 的 AI 客户端在授权范围内搜索、读取和维护笔记。

> 完整用户教程：[中文安装指南](../../docs/tutorials/mcp.md) · [English guide](../../docs/tutorials/mcp.en.md)

## 特点

- **单文件、零依赖**：`dist/baseforge-mcp.mjs` 已把 `@modelcontextprotocol/sdk`、`zod` 全部打进文件，使用方无需 `npm install`。
- **只配两个环境变量**：`BASEFORGE_URL` + `BASEFORGE_API_TOKEN`。
- **权限全部在服务端**：由 Personal API Token（scopes + 笔记本资源授权）决定，旧的本地笔记本白名单层已移除。

## 客户端配置

```json
{
  "mcpServers": {
    "baseforge": {
      "command": "node",
      "args": ["/absolute/path/to/Base-Notes/packages/baseforge-mcp/dist/baseforge-mcp.mjs"],
      "env": {
        "BASEFORGE_URL": "http://192.168.1.20:3001",
        "BASEFORGE_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `BASEFORGE_URL` | BaseForge 后端地址 | `http://localhost:3001` |
| `BASEFORGE_API_TOKEN` | Personal API Token（必填，缺失时启动即报错） | — |

## 开发

```bash
npm install
npm run build   # esbuild 打包 -> dist/baseforge-mcp.mjs
npm test        # tsx --test tests/
```

快速检查：命令行运行 `node ./dist/baseforge-mcp.mjs`，提示缺少 `BASEFORGE_API_TOKEN` 即表示文件可执行（按 `Ctrl+C` 结束）。

源码结构：

- `src/index.ts` — MCP 工具注册（笔记本、笔记、块、双链、附件、标签、AI、系统工具）
- `src/api-client.ts` — Token 认证的 REST API 客户端
- `src/note-format.ts` — 笔记内容 payload 组装
- `scripts/build.mjs` — esbuild 打包脚本
