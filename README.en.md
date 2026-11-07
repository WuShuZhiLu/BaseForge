<div align="center">
  <img src="./electron/icon.png" alt="BaseForge" width="96" />
  <h1>BaseForge</h1>
  <p>A self-hosted document platform built around knowledge bases</p>
  <p>
    <a href="./README.md">简体中文</a> ·
    <a href="./docs/README.md">Documentation</a> ·
    <a href="./docs/tutorials/README.md">Tutorials</a> ·
    <a href="./CHANGELOG.en.md">Changelog</a>
  </p>
</div>

<div align="center">

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose%20v2-2496ED?logo=docker&logoColor=white)](./docker-compose.yml)

</div>

## Overview

BaseForge is a self-hosted document platform that organizes content around knowledge bases and extends through a plugin system.

A knowledge base groups related documents into a single subject unit; the editor and block-based document engine form the foundation of the platform. Documents support Markdown, rich text, plain text, whiteboards, mind maps and lightweight spreadsheets. Rich text is organized as blocks, and whiteboards, mind maps and spreadsheets can be embedded into a document as reference blocks. Files on remote devices can be read and written directly over WebDAV or SMB.

AI agents can use BaseForge through the MCP Server, with knowledge bases as their retrieval source. The plugin system extends the platform with additional functionality.

BaseForge was forked from nowen note v1.4.16, merged the features of v1.5.1, and has since developed independently.

## Features

### Knowledge bases

Documents are organized in a mixed tree of knowledge bases and folders, with drag-and-drop ordering, favorites, tags, full-text search and bidirectional links. Permissions and sharing can apply to a whole knowledge base, or be set individually on a folder or document.

### Document formats

Six formats can be created, edited and read: Markdown, rich text, plain text, whiteboards, mind maps and lightweight spreadsheets. Rich text is organized as blocks, and whiteboards, mind maps and spreadsheets can be embedded into the body as reference blocks. Markdown and rich text can be converted into each other.

### Remote documents

Remote devices are mounted over WebDAV or SMB, and their files can be read, modified and written back in place. Read-only formats such as PDF and unsupported formats cannot be edited.

### Collaboration and data

- Real-time collaborative editing, directory-level permissions, share passwords and expiry, guest comments and block-level comments, version history.
- Import from Markdown, Word / DOCX, web pages, SiYuan and Obsidian; export a directory in multiple formats.
- Attachments stored on local disk, S3, Cloudflare R2 or MinIO, with automatic backups and ZIP archiving.
- Offline workspaces that sync incrementally when the connection is restored.

## Extensions

### Plugin system

Plugins are the platform's extension mechanism. Modules such as project management and a knowledge-base plaza are delivered as plugins. The contract is defined in [`contribution-contract.json`](./packages/nowen-plugin-sdk/contribution-contract.json) (`contractVersion: 6`), with the namespace `<pluginId>/<contributionId>` and 12 contribution types:

| Group | Contribution types |
| --- | --- |
| Commands and UI | `commands`, `menus`, `uiComponents`, `sidebarPanels`, `mainViewPanels`, `settings` |
| Editor | `editorCommands`, `noteThemes`, `noteTemplates` |
| Automation | `automationTemplates`, `promptPacks` |
| Integration | `inboundWebhooks` |

Plugins run in one of three runtimes: `declarative` renders its UI through the host, `sandbox-js` runs inside a restricted sandbox, and `node-action` runs as a separate child process. The host exposes `/api/plugins*` for installation, enablement and contribution lookup, `/api/plugin-executions` for execution records, and `/api/plugin-inbound` for inbound callbacks.

Development tools live in `packages/`: `nowen-plugin-sdk`, `nowen-plugin-cli`, the `create-nowen-plugin` scaffolder, and the `nowen-extension-registry` registry.

### MCP Server

`packages/baseforge-mcp` provides the MCP Server. AI agents such as Claude Code, Cursor and VS Code use BaseForge through MCP, with knowledge bases as their retrieval source; the accessible scope is determined by a Personal API Token. Available tools are grouped by purpose:

| Group | Tools |
| --- | --- |
| Knowledge bases and notes | `list_notebooks`, `create_notebook`, `list_notes`, `read_note`, `create_note`, `update_note`, `delete_note`, `search` |
| Block-level access | `get_block`, `search_blocks`, `create_block`, `update_block`, `delete_block`, `move_block` |
| References and links | `resolve_link`, `get_backlinks`, `get_block_backlinks` |
| Attachments and tags | `upload_attachment`, `list_attachments`, `attach_to_note`, `list_tags`, `manage_tags` |
| Remote files | `list_remote_sources`, `manage_remote_source`, `list_remote_files`, `read_remote_file`, `write_remote_file`, `manage_remote_file`, `list_remote_links`, `manage_remote_link` |
| Export and sharing | `export_notes`, `list_shares`, `create_share`, `update_share`, `delete_share` |
| Operations (unrestricted Token only) | `list_plugins`, `execute_plugin`, `list_webhooks`, `create_webhook`, `audit_stats`, `list_backups`, `create_backup` |

Tools are gated by Token scopes (including `remote_files:read/write`, `shares:read/write`, `tasks:read/write`); in-product AI Q&A and its MCP tools have been removed.

Block-level writes must carry the note version and an operation ID for concurrency checks and deduplication on retry. Installation steps are in the [MCP guide](./docs/tutorials/mcp.en.md) ([中文](./docs/tutorials/mcp.md)); package documentation is in [`packages/baseforge-mcp`](./packages/baseforge-mcp/README.md).

### HTTP API and tools

- After startup, the OpenAPI 3.0 description is available at `/api/openapi.json`.
- `packages/nowen-sdk` provides a TypeScript SDK, `nowen-cli` a command-line tool, and `nowen-clipper` a browser clipping extension.
- Webhooks and automation templates can be configured in the app and used together with the `inboundWebhooks` contribution type.

## Deployment

### Docker Compose

Docker Engine and Compose v2 are required. The image address is not hardcoded in the repository; provide it via `BASEFORGE_IMAGE_REPOSITORY` in `.env` (see [`.env.example`](./.env.example) for a sample value).

```bash
git clone https://git.betheone.cc.cd/wushuzhilu/BaseForge.git
cd BaseForge
cp .env.example .env          # make sure BASEFORGE_IMAGE_REPOSITORY is set
docker compose up -d
```

Then open `http://<server-ip>:3001`. The default administrator is `admin` with the password `admin123`; change it immediately after the first sign-in.

```bash
docker compose ps
docker compose logs -f --tail=200 baseforge
docker compose pull && docker compose up -d   # upgrade the image
```

### Data and configuration

Persistent data lives in `/app/data` inside the container, mounted from the `baseforge-data` volume by default:

```text
/app/data/
├── baseforge.db
├── attachments/
├── backups/
└── .jwt_secret
```

The image repository, tag and port come from `.env` and are interpolated by `docker-compose.yml`: `BASEFORGE_IMAGE_REPOSITORY` (**required**, e.g. `wushuzhilu/baseforge`), `BASEFORGE_IMAGE_TAG` (default `latest`), and `BASEFORGE_PORT` (default `3001`).

Common environment variables read by the application; see [`.env.example`](./.env.example) for the full template:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TZ` | `Asia/Shanghai` | Container time zone |
| `PUBLIC_WEB_ORIGIN` | empty | Reverse-proxy origin used when generating share links |
| `JWT_SECRET` | generated and persisted | Session signing |
| `CORS_ORIGINS` | built-in client origins | Additional allowed web origins |
| `ATTACHMENT_STORAGE` | `local` | Set to `s3` to use S3 / R2 / MinIO |
| `MAX_ATTACHMENT_SIZE_MB` | `100` | Maximum size of a single attachment |

### Running from source

```bash
npm install
npm run install:all
npm run dev
```

The frontend is served at `http://localhost:5173`. Build and frontend tests:

```bash
npm run build:all
(cd frontend && npm run test:run)
```

Technology stack: React 18, TypeScript 5, Vite 5, Tiptap 3, CodeMirror and Yjs on the frontend; Node.js 22+, Hono 4, SQLite (built-in `node:sqlite` with FTS5) and WebSocket on the backend; Electron 33 and Capacitor 8 for the client projects.

## Documentation and license

- [Documentation index](./docs/README.md) · [Tutorials](./docs/tutorials/README.md) · [Deployment guide](./docs/deployment.md)
- [MCP installation and usage](./docs/tutorials/mcp.en.md) · [Object storage for attachments](./docs/object-storage.md) · [Privacy policy](./docs/PRIVACY.md)
- [Issues](https://git.betheone.cc.cd/wushuzhilu/BaseForge/issues) · [Changelog](./CHANGELOG.en.md)

BaseForge is developed from [nowen note](https://github.com/cropflre/nowen-note) (GPL-3.0) and released under the [GNU General Public License v3.0](./LICENSE). Copyright of the upstream code remains with its original authors.
