<div align="center">
  <img src="./electron/icon.png" alt="BaseForge" width="96" />
  <h1>BaseForge</h1>
  <p>以知识库为核心的可自托管文档平台</p>
  <p>
    <a href="./README.en.md">English</a> ·
    <a href="./docs/README.md">文档</a> ·
    <a href="./docs/tutorials/README.md">教程</a> ·
    <a href="./CHANGELOG.md">更新日志</a>
  </p>
</div>

<div align="center">

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose%20v2-2496ED?logo=docker&logoColor=white)](./docker-compose.yml)

</div>

## 简介

BaseForge 是可自托管的文档平台，以知识库为核心组织内容，并通过插件机制扩展能力。

知识库把相关文档集合为一个个主题单元，编辑器与块文档能力构成平台的基石。文档支持 Markdown、富文本、纯文本、画板、思维导图与轻量表格；富文本以块为单位，画板、导图与表格可作为引用块嵌入正文；可通过 WebDAV、SMB 等方式直接读写远程设备的文件。

AI agent 可以通过 MCP Server 使用 BaseForge，将知识库作为检索来源。
插件机制 可自由拓展，丰富平台功能。

BaseForge 基于 nowen note v1.4.16 分叉，合并v1.5.1功能，后彻底独立。

## 功能

### 知识库

知识树与文件夹混合组织文档，支持拖拽排序、收藏、标签、全文搜索与双向链接。权限与分享可作用于整个知识库，也可单独设置到文件夹或文档。

### 文档格式

支持 Markdown、富文本、纯文本、画板、思维导图与轻量表格六种格式的创建、编辑与阅读。富文本以块为组织单位，画板、思维导图与表格可作为引用块嵌入正文；Markdown 与富文本可相互转换。

### 远程文档

通过 WebDAV、SMB 接入远程设备，读取、修改并写回原文件。PDF 等只读格式和不受支持的格式不在可编辑范围内。

### 协作与数据

- 多人实时协同编辑，支持目录级权限、分享密码与有效期、访客评论与块级评论、版本历史。
- 导入 Markdown、Word / DOCX、网页、思源与 Obsidian 内容，可按目录导出多种格式。
- 附件存放于本地磁盘、S3、Cloudflare R2 或 MinIO，支持自动备份与 ZIP 归档。
- 支持离线工作区，联网后按增量同步。

## 扩展

### 插件机制

插件是平台的扩展方式，项目管理、知识库广场等模块以插件形式接入。契约文件为 [`contribution-contract.json`](./packages/nowen-plugin-sdk/contribution-contract.json)（`contractVersion: 6`），命名空间 `<pluginId>/<contributionId>`，共 12 类贡献点：

| 分组 | 贡献点 |
| --- | --- |
| 命令与界面 | `commands`、`menus`、`uiComponents`、`sidebarPanels`、`mainViewPanels`、`settings` |
| 编辑器 | `editorCommands`、`noteThemes`、`noteTemplates` |
| 自动化 | `automationTemplates`、`promptPacks` |
| 集成 | `inboundWebhooks` |

插件按三种运行时执行：`declarative` 由宿主渲染界面，`sandbox-js` 在受限沙箱内运行，`node-action` 以独立子进程运行。宿主提供的接口为 `/api/plugins*`（安装、启停与贡献点查询）、`/api/plugin-executions`（执行记录）和 `/api/plugin-inbound`（入站回调）。

开发工具位于 `packages/`，包括 `nowen-plugin-sdk`、`nowen-plugin-cli`、`create-nowen-plugin` 脚手架与 `nowen-extension-registry` 注册表。

### MCP Server

`packages/nowen-mcp` 提供 MCP Server。AI agent（Claude Code、Cursor、VS Code 等）通过 MCP 使用 BaseForge，将知识库作为检索来源，可访问范围由 Personal API Token 决定。可用工具按用途分组：

| 分组 | 工具 |
| --- | --- |
| 知识库与笔记 | `list_notebooks`、`create_notebook`、`list_notes`、`read_note`、`create_note`、`update_note`、`delete_note`、`search`、`knowledge_stats` |
| 块级读写 | `get_block`、`search_blocks`、`create_block`、`update_block`、`delete_block`、`move_block` |
| 引用与链接 | `resolve_link`、`get_backlinks`、`get_block_backlinks` |
| 附件与标签 | `upload_attachment`、`list_attachments`、`attach_to_note`、`list_tags`、`manage_tags` |
| 运维 | `list_plugins`、`execute_plugin`、`list_webhooks`、`create_webhook`、`audit_stats`、`list_backups`、`create_backup` |

块级写操作需要携带笔记版本与操作 ID，用于并发校验与重试去重。安装步骤见 [MCP 教程](./docs/tutorials/mcp.md)（[English](./docs/tutorials/mcp.en.md)），包说明见 [`packages/nowen-mcp`](./packages/nowen-mcp/README.md)。

### HTTP API 与工具

- 服务启动后访问 `/api/openapi.json` 获取 OpenAPI 3.0 描述。
- `packages/nowen-sdk` 提供 TypeScript SDK；`nowen-cli` 为命令行工具；`nowen-clipper` 为浏览器剪藏扩展。
- 应用内可配置 Webhook 与自动化模板，与 `inboundWebhooks` 贡献点配合使用。

## 部署

### Docker Compose

需要 Docker Engine 与 Compose v2。镜像在内网镜像仓库 `docker.betheone.cc.cd`，不公开发布；内网可直接拉取，仓库要求认证时先执行 `docker login docker.betheone.cc.cd`。

```bash
git clone https://git.betheone.cc.cd/wushuzhilu/BaseForge.git
cd BaseForge
docker compose up -d
```

启动后访问 `http://<服务器IP>:3001`。默认管理员账号为 `admin`，密码 `admin123`，首次登录后立即修改。

```bash
docker compose ps
docker compose logs -f --tail=200 baseforge
docker compose pull && docker compose up -d   # 升级镜像
```

### 数据与配置

持久化目录为容器内 `/app/data`，默认挂载 `baseforge-data` 卷：

```text
/app/data/
├── baseforge.db
├── attachments/
├── backups/
└── .jwt_secret
```

镜像地址、标签与端口由 `.env` 提供，供 `docker-compose.yml` 插值：`BASEFORGE_IMAGE_REPOSITORY`（默认 `docker.betheone.cc.cd/baseforge`）、`BASEFORGE_IMAGE_TAG`（默认 `latest`）、`BASEFORGE_PORT`（默认 `3001`）。

应用读取的常用环境变量，完整模板见 [`.env.example`](./.env.example)：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TZ` | `Asia/Shanghai` | 容器时区 |
| `PUBLIC_WEB_ORIGIN` | 空 | 反向代理域名，用于生成分享链接 |
| `JWT_SECRET` | 自动生成并持久化 | 会话签名 |
| `CORS_ORIGINS` | 内置客户端来源 | 额外允许的网页来源 |
| `ATTACHMENT_STORAGE` | `local` | 设为 `s3` 后使用 S3 / R2 / MinIO |
| `MAX_ATTACHMENT_SIZE_MB` | `100` | 单个附件大小上限 |

### 源码运行

```bash
npm install
npm run install:all
npm run dev
```

前端访问 `http://localhost:5173`。构建与前端测试：

```bash
npm run build:all
(cd frontend && npm run test:run)
```

技术栈：前端 React 18、TypeScript 5、Vite 5、Tiptap 3、CodeMirror、Yjs；后端 Node.js 22+、Hono 4、SQLite（内置 `node:sqlite`，启用 FTS5）与 WebSocket；客户端工程为 Electron 33 与 Capacitor 8。

## 文档与许可

- [文档索引](./docs/README.md) · [教程中心](./docs/tutorials/README.md) · [部署指南](./docs/deployment.md)
- [MCP 安装与使用](./docs/tutorials/mcp.md) · [附件对象存储](./docs/object-storage.md) · [隐私策略](./docs/PRIVACY.md)
- [Issues](https://git.betheone.cc.cd/wushuzhilu/BaseForge/issues) · [更新日志](./CHANGELOG.md)

BaseForge 基于 [nowen note](https://github.com/cropflre/nowen-note)（GPL-3.0）二次开发，遵循 [GNU General Public License v3.0](./LICENSE) 发布，上游代码版权归原作者所有。
