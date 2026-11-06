# MCP Server 安装与使用教程

> 通过 Model Context Protocol（MCP），让 Claude Code、Cursor、VS Code 等 AI 客户端在授权范围内搜索、读取和维护你的 BaseForge 笔记。

[返回教程中心](./README.md) · [English](./mcp.en.md) · [MCP 包说明](../../packages/baseforge-mcp/README.md)

## 先看结论

- MCP 是一个**单文件** Node.js 程序：`packages/baseforge-mcp/dist/baseforge-mcp.mjs`，所有依赖已打进文件里，无需 `npm install`。
- 只需要两个环境变量：`BASEFORGE_URL`（BaseForge 地址）和 `BASEFORGE_API_TOKEN`（个人访问令牌）。
- 不要直接照抄 `/path/to/...`。客户端配置中的脚本路径必须替换为你电脑上的**绝对路径**。
- 如果 BaseForge 部署在 NAS 或其他服务器，`BASEFORGE_URL` 应填写该设备能从当前电脑访问的地址，例如 `http://192.168.1.20:3001`，而不是 `localhost`。
- 权限完全由 Token 决定：建议为每个 AI 客户端创建独立的 restricted Token（限定笔记本、最小 scope），不要把管理员密码写进 MCP 配置。

## 5 分钟快速接入

### 1. 确认 BaseForge 可以访问

先在运行 AI 客户端的电脑浏览器中打开 `http://你的服务器IP:3001`（本机部署用 `http://localhost:3001`）。如果浏览器都打不开，请先处理 Docker 端口、防火墙或反向代理问题，MCP 无法绕过网络问题。

### 2. 确认 Node.js 20+

```bash
node --version
```

### 3. 创建 Personal API Token

进入 BaseForge `设置 → 个人访问令牌 → 创建令牌`：

1. 为每个 AI 客户端创建独立 Token，例如"Claude Code"或"Cursor"。
2. 只开启实际需要的 scopes，例如 `notes:read`、`notes:write`。
3. 资源范围选择"限定笔记本"，为每个笔记本设置"只读"或"读写"，按需开启"自动包含子笔记本"。
4. 设置合理过期时间，Token 泄露后立即撤销。

复制生成的 Token，例如 `nkn_xxxxxxxxxxxxxxxxx`（通常只展示一次）。

### 4. 配置客户端

客户端配置统一指向仓库里的单文件 `packages/baseforge-mcp/dist/baseforge-mcp.mjs`：

#### Claude Code

```bash
claude mcp add baseforge --scope user \
  --env BASEFORGE_URL=http://192.168.1.20:3001 \
  --env BASEFORGE_API_TOKEN=nkn_xxx \
  -- node "C:\Users\YourName\Base-Notes\packages\baseforge-mcp\dist\baseforge-mcp.mjs"
```

#### Cursor（`.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "baseforge": {
      "command": "node",
      "args": ["C:\\Users\\YourName\\Base-Notes\\packages\\baseforge-mcp\\dist\\baseforge-mcp.mjs"],
      "env": {
        "BASEFORGE_URL": "http://192.168.1.20:3001",
        "BASEFORGE_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

#### VS Code / GitHub Copilot（`.vscode/mcp.json`）

VS Code 顶层字段是 `servers`，不是 `mcpServers`：

```json
{
  "servers": {
    "baseforge": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\YourName\\Base-Notes\\packages\\baseforge-mcp\\dist\\baseforge-mcp.mjs"],
      "env": {
        "BASEFORGE_URL": "http://192.168.1.20:3001",
        "BASEFORGE_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

#### 其他通用客户端

支持本地 stdio MCP 的客户端都用同一结构：`command: node` + 单文件绝对路径 + 两个 env。Windows 路径 `\` 需转义为 `\\`；Linux/macOS 路径必须以 `/` 开头。

保存后完全重启客户端，在 MCP 设置中确认 `baseforge` 已启动。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `BASEFORGE_URL` | BaseForge 服务地址 | `http://localhost:3001` |
| `BASEFORGE_API_TOKEN` | Personal API Token（必填，缺失时启动即报错） | — |

## 可用工具

### 笔记本

| 工具 | 说明 |
|---|---|
| `baseforge_list_notebooks` | 列出当前 Token 可以访问的笔记本 |
| `baseforge_create_notebook` | 创建笔记本 |

### 笔记与搜索

| 工具 | 说明 |
|---|---|
| `baseforge_list_notes` | 列出授权范围内的笔记 |
| `baseforge_read_note` | 读取笔记 |
| `baseforge_create_note` | 创建笔记 |
| `baseforge_update_note` | 更新笔记 |
| `baseforge_delete_note` | 删除笔记 |
| `baseforge_search` | 全文搜索 |

### 块与双链

| 工具 | 说明 |
|---|---|
| `baseforge_get_block` / `baseforge_create_block` / `baseforge_update_block` / `baseforge_delete_block` / `baseforge_move_block` | 块级读写 |
| `baseforge_search_blocks` | 块级搜索 |
| `baseforge_get_backlinks` / `baseforge_get_block_backlinks` / `baseforge_resolve_link` | 双链与内部链接解析 |

### 附件与标签

| 工具 | 说明 |
|---|---|
| `baseforge_upload_attachment` | 上传附件（可绑定到笔记） |
| `baseforge_list_attachments` | 列出附件 |
| `baseforge_attach_to_note` | 将附件插入 Markdown 笔记 |
| `baseforge_list_tags` / `baseforge_manage_tags` | 标签读取与管理 |

### AI 与知识库

| 工具 | 说明 |
|---|---|
| `baseforge_ai_ask` | 按指定笔记本进行知识库问答 |
| `baseforge_ai_process` | AI 处理调用方直接提供的文本 |
| `baseforge_knowledge_stats` | 知识库统计 |

### 系统（需要对应 scope）

| 工具 | 说明 |
|---|---|
| `baseforge_list_plugins` / `baseforge_execute_plugin` | 插件查询与执行 |
| `baseforge_list_webhooks` / `baseforge_create_webhook` | Webhook 管理 |
| `baseforge_list_backups` / `baseforge_create_backup` | 备份查询与创建 |
| `baseforge_audit_stats` | 审计统计 |

## 验证是否安装成功

重启客户端后，确认工具列表中出现 `baseforge_list_notebooks`，然后让 AI 执行只读测试：

```text
请使用 BaseForge MCP 列出我有权限访问的笔记本，不要修改任何内容。
```

如果只读成功而写入失败，通常是 Token scope 或笔记本资源权限不足，属于正常的安全拦截。

## 常见问题

### 提示缺少 BASEFORGE_API_TOKEN

在 BaseForge `设置 → 个人访问令牌` 创建 Token 后填入客户端配置的 `env`。

### `BASEFORGE_URL` 连接失败

- MCP 与 BaseForge 同一台电脑：`http://localhost:3001`。
- BaseForge 在 NAS：`http://NAS局域网IP:3001`。
- 先在运行客户端的电脑浏览器中验证该地址。

### 返回 401 或 403

- 401：Token 错误、过期或已撤销。
- 403：Token scope 或笔记本资源授权拒绝了请求，应修正最小权限配置，不要改用管理员密码。

### 工具没有出现

1. 确认配置里的单文件绝对路径存在（仓库被移动后需同步修改）；
2. 完全退出并重启客户端；
3. 在客户端中 Restart Server / Reset Cached Tools。

## 安全说明

- 最终权限 = 用户 ACL ∩ Token scopes ∩ Token 笔记本资源授权，全部由服务端执行；restricted Token 即使被绕过 MCP 直接调用 REST API，也不能访问未授权笔记本。
- Token 会出现在客户端配置中，不要把包含 Token 的 `mcp.json` 提交到公开仓库。
- 每个 Agent 使用独立 Token，方便撤销和审计。

详细 Token 授权设计参见：[MCP Token 笔记本资源授权](./mcp-token-resource-scope.md)。

## 下一步

- [OpenAPI 接入指南](./api.md)
- [SDK 使用教程](./sdk.md)
