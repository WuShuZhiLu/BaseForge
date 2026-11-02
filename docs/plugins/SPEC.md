# Nowen 插件规范（SPEC）

> 与代码同步于提交 `28634416c`（分支 `feat/space-and-plugins`）。
> 该提交已包含 `editorCommands`（`cb93ad77f`）与"白名单仅精确域名"（`28634416c`）两处行为变更。
> 本文所有字段名、正则、限额均取自 `backend/src/plugins/manifest.ts`、`packageValidator.ts`、`types.ts`、
> `secureExternalFetch.ts`、`pluginRateLimiter.ts` 与 `packages/nowen-plugin-sdk/host-api-contract.json`，
> 改代码必须同步改本文。

---

## 1. 运行模型概览

| 概念 | 取值 | 说明 |
| --- | --- | --- |
| `apiVersion` | `1` / `2` | 决定用哪套 zod schema；其他值直接报 `不支持 Plugin API V<value>` |
| `runtime` | `node-action` | 独立 Node 子进程执行 `main`（`fork` + `--max-old-space-size=128`），入口为 ESM |
| | `sandbox-js` | QuickJS 沙箱内求值 `main`（单文件脚本，非 ESM）；V2 起可用 |
| | `declarative` | 零代码，仅声明 `contributes`；V2 起可用，需 V2.1 门禁 |
| `engines.nowen` | 语义化版本范围字符串 | 宿主版本不满足则安装/加载失败 |

### 1.1 版本门禁（fail-closed）

代码内 `NOWEN_VERSION = "1.5.0"`（`types.ts`）。`parsePluginManifest()` 依次检查：

| 条件 | 失败错误 |
| --- | --- |
| `runtime=declarative` 但 `NOWEN_EXTENSIONS_V21` 未开启 | `PLUGIN_V21_FEATURE_DISABLED`（"声明式 Extension 当前未启用"） |
| `runtime=declarative` 且 `engines.nowen` 不满足 `>=1.6.0` | `PLUGIN_NOWEN_INCOMPATIBLE` |
| 声明了 `contributes.noteThemes` 但 `NOWEN_EXTENSIONS_V21` 未开启 | `PLUGIN_V21_FEATURE_DISABLED` |
| 声明了 `contributes.noteThemes` 且不满足 `>=1.6.0` | `PLUGIN_NOWEN_INCOMPATIBLE` |
| 声明了 `contributes.uiComponents` 但 `NOWEN_UI_EXTENSIONS` 未开启 | `PLUGIN_UI_FEATURE_DISABLED` |
| 声明了 `contributes.uiComponents` 且不满足 `>=1.6.0` | `PLUGIN_NOWEN_INCOMPATIBLE` |
| `engines.nowen` 不匹配当前宿主版本（默认 `1.5.0`） | `插件要求 BaseForge <range>，当前版本为 <version>` |

`engines.nowen` 支持的运算符：`>=` `>` `<=` `<` `=` `^` `~`，多个条件用空格表示 AND（如 `>=1.5.0 <2.0.0`）。
不支持 `||`、`x`/`*` 通配、hyphen 区间。解析见 `nowenVersionSatisfies()`。

### 1.2 目录与示例的当前状态

`examples/plugins/` 下多份示例的 `engines.nowen` 高于代码内 `NOWEN_VERSION=1.5.0`，在默认参数下无法通过包校验。用
`scripts/verify-plugin.mjs --nowen-version=...` 显式指定宿主版本（见 §8）。

---

## 2. 插件包（ZIP）结构

安装入口 `validatePluginPackage(bytes)`（`packageValidator.ts`）：

```
my-plugin-1.0.0.zip
├── manifest.json          ← 必须在 ZIP 根目录，≤128KB，合法 JSON
├── main.js | main.mjs     ← executable 插件必填，必须是已构建的 JS（不校验内容，只校验后缀与存在性）
├── icon.png               ← manifest.icon 指向的文件必须存在于包内
├── screenshots/*.png      ← manifest.screenshots 每一项都必须存在
├── templates/*.json       ← contributes.automationTemplates[].file 必须存在
└── README.md              ← 可选，无特殊语义
```

要点：

- 包里**不能有**任何"安装期可执行"的东西。ZIP 解开后不跑 `npm install`，也不加载任何二进制。
- `manifest.main` 必须是相对路径，不允许绝对路径或以 `/` 开头，不允许出现 `..` 段（`main 必须位于插件目录内`）。
- 条目名会做路径归一化：反斜杠转 `/`、拒绝绝对路径、拒绝盘符（`C:`）、拒绝 `..` 段。
- 所有非 ASCII 文件名按 UTF-8 处理，不做重命名。

### 2.1 拒收清单（`isForbidden` / 流式校验）

| 类别 | 规则 | 错误样例 |
| --- | --- | --- |
| 依赖目录 | 路径中含 `node_modules` 段 | `插件包包含禁止文件: node_modules/x.js` |
| 原生模块 | 后缀 `.node` | 同上 |
| 安装脚本 | 文件名为 `install.js` / `preinstall` / `postinstall` | 同上 |
| 锁文件 | 文件名为 `package-lock.json` | 同上 |
| 可执行/脚本 | 后缀 `.exe` `.dll` `.so` `.dylib` `.bat` `.cmd` `.ps1` `.sh` `.com` `.msi` | 同上 |
| 符号链接 | ZIP 条目是 SymbolicLink，或 unix mode 高 16 位为 `0o120000` | `插件包禁止符号链接: <name>` |
| 声明式插件内的代码 | 声明式插件的包内出现 `.mjs` `.cjs` `.js` `.wasm` | `PLUGIN_CONTRIBUTION_INVALID` |

### 2.2 包限额（`PACKAGE_LIMITS`）

| 项 | 上限 | 触发错误 |
| --- | --- | --- |
| 压缩后大小 | 20 MiB（且必须 > 0） | `插件包必须大于 0 且不超过 20MB` |
| 解压后总大小 | 50 MiB | `插件解压后超过 50MB` |
| 单条目解压大小 | 50 MiB | `插件 ZIP 条目超过 50MB` |
| 文件数 | 500（且 ≥1） | `插件包文件数量必须在 1-500 之间` |
| `manifest.json` | 128 KiB | `manifest.json 超过 128KB` |
| 压缩比 | 单条目 >1 MiB 且 解压/压缩 > 200 | `插件 ZIP 压缩比异常: <name>` |
| Action 入参 | 256 KiB | `PLUGIN_INPUT_TOO_LARGE` |
| Action 出参 | 1 MiB | `PLUGIN_OUTPUT_TOO_LARGE` |

包完整性：安装时记录 `sha256(zip bytes)` 到注册表，并写入 `.nowen-package.json`（`id`/`version`/`checksum`）。
同一 `id@version` 坐标对应不同内容会被拒（`PLUGIN_VERSION_COORDINATE_CONFLICT`）。

---

## 3. Manifest V1 全字段表（`apiVersion: 1`，`runtime: node-action`）

schema 为 `.strict()`：表外字段一律报错。

| 字段 | 类型 | 必填 | 取值/约束 | 示例 |
| --- | --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z0-9]+(?:[.-][a-z0-9]+)+$`，≤150（至少一个分隔点） | `com.nowen.hello` |
| `name` | string | 是 | 1–100 | `Hello Nowen` |
| `description` | string | 否 | ≤1000，默认 `""` | `最小示例` |
| `version` | string | 是 | `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$` | `1.0.0` |
| `apiVersion` | number | 是 | 字面量 `1` | `1` |
| `engines.nowen` | string | 是 | 1–100，版本范围 | `>=1.5.0 <2.0.0` |
| `runtime` | string | 是 | 字面量 `node-action` | `node-action` |
| `main` | string | 是 | 1–300，相对路径，不允许绝对路径/`..` | `dist/index.mjs` |
| `author.name` | string | 否* | 1–100（`author` 存在时必填） | `Nowen` |
| `author.url` | string | 否 | URL | `https://example.com` |
| `category` | string | 否 | 1–50 | `productivity` |
| `keywords` | string[] | 否 | 每项 1–50，最多 20 | `["demo"]` |
| `repository` | string | 否 | URL | `https://github.com/x/y` |
| `homepage` | string | 否 | URL | `https://example.com` |
| `license` | string | 否 | 1–100 | `MIT` |
| `icon` | string | 否 | 1–300，包内必须存在 | `icon.png` |
| `screenshots` | string[] | 否 | 每项 1–300，最多 10，包内必须存在 | `["s1.png"]` |
| `connections[].id` | string | 是 | `^[a-z][a-z0-9-]{0,63}$`，数组内唯一 | `openai` |
| `connections[].name` | string | 是 | 1–100 | `OpenAI` |
| `connections[].type` | string | 是 | `bearer` / `api-key-header` / `basic` | `bearer` |
| `connections[].headerName` | string | 否 | 1–100；`api-key-header` 时不得为 `authorization`/`cookie`/`proxy-authorization` | `X-API-Key` |
| `connections[].description` | string | 否 | ≤500 | — |
| `output` | object | 否 | 任意键值 | `{"type":"object"}` |
| `permissions` | string[] | 否 | `PLUGIN_PERMISSIONS` 枚举，最多 32，默认 `[]` | `["tasks:read"]` |
| `permissionConfig.externalFetchHosts` | string[] | 否 | 最多 50，每项 1–253，域名规则见 §7 | `["api.example.com"]` |
| `actions` | array | 是 | 1–50 条，`id` 唯一 | 见 §3.1 |
| `events` | string[] | 否 | 每项 1–100，最多 50 | `["note.created"]` |
| `eventHandlers[].event` | string | 是 | 1–100 | `note.created` |
| `eventHandlers[].action` | string | 是 | 1–64，必须在 `actions` 中存在 | `onNote` |

额外跨字段约束：

- 声明了 `connections` 必须同时申请 `secrets:use`（`声明 connections 必须请求 secrets:use`）。
- `actions[].id` 与 `connections[].id` 各自不允许重复。

### 3.1 `actions[]` 字段表（V1/V2 共用）

| 字段 | 类型 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z][a-z0-9-]{0,63}$`，数组内唯一 | Action 标识 |
| `name` | string | 是 | 1–100 | 展示名 |
| `description` | string | 否 | ≤500 | — |
| `execution` | string | 否 | `interactive`（默认）/ `background` | `background` 超时 30s，`interactive` 10s |
| `idempotent` | boolean | 否 | — | 语义标记 |
| `retryable` | boolean | 否 | — | 语义标记 |
| `input` | object | 否 | 默认 `{}`；key 到字段定义的映射 | 见下表 |

`input.<key>` 字段定义（`.strict()`）：

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `type` | string | 是 | `string` / `number` / `boolean` / `object` / `array` |
| `required` | boolean | 否 | 缺省参数校验时是否必须 |
| `description` | string | 否 | ≤500 |
| `enum` | array | 否 | 最多 100，元素 string/number/boolean |
| `default` | any | 否 | 任意（仅声明，运行时不自动填充） |

运行时入参校验（`validateActionInput`）：未知参数报 `未知参数: <key>`；类型不符报 `参数 <key> 应为 <type>`；
`enum` 不符报 `参数 <key> 不在允许范围内`；缺必填报 `缺少必填参数: <key>`。

---

## 4. Manifest V2 全字段表（`apiVersion: 2`）

V2 是两个 schema 的联合：**executable**（`sandbox-js` | `node-action`）与 **declarative**。两者共享基础字段。

### 4.1 基础字段（两种 V2 都适用）

| 字段 | 类型 | 必填 | 取值/约束 | 示例 |
| --- | --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z0-9]+(?:[.-][a-z0-9]+)+$`，≤150，**必须以 `<publisher>.` 开头** | `nowenlab.task-digest` |
| `publisher` | string | 是 | `^[a-z0-9][a-z0-9-]{1,63}$`（2–64 字符） | `nowenlab` |
| `name` | string | 是 | 1–100 | `每日任务简报` |
| `description` | string | 否 | ≤1000，默认 `""` | — |
| `version` | string | 是 | `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$` | `1.0.0` |
| `apiVersion` | number | 是 | 字面量 `2` | `2` |
| `engines.nowen` | string | 是 | 1–100 | `>=1.5.0 <2.0.0` |
| `categories` | string[] | 是 | 1–10 项，每项 1–50 | `["productivity"]` |
| `keywords` | string[] | 否 | 最多 20，每项 1–50 | `["tasks"]` |
| `repository` | string | **是**（V2 必填） | URL | `https://github.com/cropflre/nowen-note` |
| `homepage` | string | 否 | URL | — |
| `license` | string | **是**（V2 必填） | 1–100 | `MIT` |
| `icon` | string | 否 | 1–300，包内必须存在 | `icon.png` |
| `screenshots` | string[] | 否 | 最多 10，每项 1–300 | — |
| `platforms` | string[] | 否 | 1–2 项：`server` / `desktop-full` | `["server"]` |
| `runtimePlatform` | string[] | 否 | 同上 | `["desktop-full"]` |
| `uiPlatform` | string[] | 否 | 最多 4 项：`web` / `desktop` / `android` / `ios` | `["web","desktop"]` |
| `output` | object | 否 | 任意键值 | — |
| `permissionConfig.externalFetchHosts` | string[] | 否 | 最多 50，每项 1–253，规则见 §7 | `["api.example.com"]` |
| `extensionDependencies` | object | 否 | 插件 ID → 版本范围，最多每项 1–100 字符 | `{"nowenlab.core":">=1.0.0"}` |

> `platforms` / `runtimePlatform` / `uiPlatform` / `extensionDependencies` 为 V2 新增，V1 不允许出现（strict）。

### 4.2 Executable（`runtime: sandbox-js` | `node-action`）

| 字段 | 类型 | 必填 | 取值 | 备注 |
| --- | --- | --- | --- | --- |
| `runtime` | string | 是 | `sandbox-js` / `node-action` | `sandbox-js` 的 `main` 必须以 `.js` 结尾（IIFE/脚本单文件） |
| `main` | string | 是 | 1–300，相对路径 | 不允许绝对路径/`..` |
| `connections` | array | 否 | 最多 20，字段同 §3 | 声明即须申请 `secrets:use` |
| `permissions` | string[] | 否 | `PLUGIN_PERMISSIONS` 枚举，最多 32，默认 `[]`；必须是 V2 支持集（§6） | — |
| `actions` | array | 是 | 1–50，`id` 唯一，字段同 §3.1 | — |
| `events` | string[] | 否 | 最多 50，每项 1–100 | — |
| `eventHandlers` | array | 否 | 最多 50，`action` 必须存在于 `actions` | — |
| `contributes` | object | 否 | 见 §5（executable 允许全集） | — |

### 4.3 Declarative（`runtime: declarative`）

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `runtime` | string | 是 | 字面量 `declarative` |
| `permissions` | array | 否 | 最多 **0** 项，只能 `[]` |
| `contributes` | object | 是 | 静态贡献子集，见 §5；至少一项非空 |
| `main` / `connections` / `actions` / `events` / `eventHandlers` | — | 禁止出现 | strict 校验直接报"unrecognized key" |

额外约束：`permissionConfig` 不允许声明（`声明式插件不能声明权限配置`）；`settings[].secret` 不允许为 `true`。

---

## 5. V2 `contributes` 字段表

| 字段 | 是否可声明 | 最多条目 | 契约 `since`（`contribution-contract.json`） |
| --- | --- | --- | --- |
| `inboundWebhooks` | executable | 10 | 2.0 |
| `commands` | executable | 100 | 2.0 |
| `menus` | executable | 100 | 2.0 |
| `settings` | executable + declarative | 100 | 2.0 |
| `automationTemplates` | executable + declarative | 50 | 2.0 |
| `noteThemes` | executable + declarative | 20 | 2.1（门禁） |
| `noteTemplates` | executable + declarative | 100 | 2.1 |
| `promptPacks` | executable + declarative | 100 | 2.1 |
| `uiComponents` | executable + declarative | 50 | 2.1（UI 门禁） |
| `editorCommands` | executable | 50 | 2.3 |
| `sidebarPanels` | executable + declarative | 10 | 2.2 |
| `mainViewPanels` | executable + declarative | 5 | 未列入契约 JSON（见 §9） |

运行时门禁差异：`uiComponents` 在**安装期**就要求 `NOWEN_UI_EXTENSIONS`；`sidebarPanels` / `mainViewPanels`
安装期只做 schema 校验，但 `pluginService.contributions()` 在 `uiExtensions` 关闭时会**静默丢弃**这三个字段，
不会把它们下发给前端。研发期请直接开 `NOWEN_EXTENSIONS_V21` + `NOWEN_UI_EXTENSIONS`。

### 5.1 `inboundWebhooks[]`

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `id` | string | 是 | `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`，数组内唯一 |
| `path` | string | 是 | 同上正则，数组内唯一 |
| `action` | string | 是 | 必须是已声明的 Action |
| `methods` | string[] | 是 | 1–2 项，`GET`/`POST`，不重复 |
| `maxBodyBytes` | number | 是 | 整数 1–262144 |
| `backgroundAction` | string | 否 | 必须指向 `execution: "background"` 的 Action |

调用路径形如 `/api/plugin-inbound/<pluginId>/<path>/<token>`，`token` 是绑定用户 `tokenVersion` 的 32 字节随机令牌（仅存 sha256），用户被禁用或 `tokenVersion` 变更即失效。

### 5.2 `commands[]` / `menus[]`

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `commands[].id` | string | 是 | `^[a-z0-9]+(?:[.-][a-z0-9]+)+$` |
| `commands[].title` | string | 是 | 1–100 |
| `commands[].action` | string | 是 | 必须是已声明 Action |
| `commands[].category` | string | 否 | ≤50 |
| `menus[].location` | string | 是 | `commandPalette` / `note.contextMenu` / `notebook.contextMenu` / `editor.toolbar.actions` / `attachment.contextMenu` / `task.contextMenu` / `settings.plugin` / `automation.template` |
| `menus[].command` | string | 是 | 1–150，必须是已声明 command id |

### 5.3 `settings[]`

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `key` | string | 是 | `^[a-z][a-z0-9_.-]{0,63}$` |
| `title` | string | 是 | 1–100 |
| `type` | string | 是 | `string` / `number` / `boolean` / `select` |
| `description` | string | 否 | ≤500 |
| `options` | array | 否 | 最多 100，元素 string/number |
| `default` | string\|number\|boolean | 否 | — |
| `secret` | boolean | 否 | 声明式插件禁止 `true` |

### 5.4 `automationTemplates[]`

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z][a-z0-9-]{0,63}$` |
| `title` | string | 是 | 1–100 |
| `file` | string | 是 | 1–300，包内必须存在 |
| `description` | string | 否 | ≤500 |

### 5.5 `noteThemes[]`（`since 2.1`，需 V2.1 门禁 + `engines.nowen >=1.6.0`）

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z][a-z0-9-]{0,63}$`，数组内唯一 |
| `name` | string | 是 | 1–100 |
| `description` | string | 否 | ≤500 |
| `base` | string | 否 | 字面量 `nowen.default`（默认） |
| `modes.light` | object | 是 | token 集合，不能为空 |
| `modes.dark` | object | 否 | token 集合，不能为空 |

token 规则：颜色 token（`surface` `text` `heading` `muted` `border` `accent` `accentHover`
`inlineCodeBackground` `inlineCodeText` `preBackground` `preText` `quoteBorder` `quoteText` `softBackground`
`tableStripe` `markBackground` `selection`）必须是 `#RRGGBB` 或 `#RRGGBBAA`；
`contentMaxWidth` 必须是 `480px`–`1200px`；`lineHeight` 必须是 1.2–2.2 的无单位数值。未知 token 报错（strict）。

### 5.6 `noteTemplates[]`（`since 2.1`）

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z][a-z0-9-]{0,63}$`，数组内唯一 |
| `name` | string | 是 | 1–100 |
| `description` | string | 否 | ≤500 |
| `contentFormat` | string | 是 | `markdown` / `tiptap-json`（后者 `body` 必须是合法 JSON） |
| `body` | string | 是 | 非空，UTF-8 ≤256 KiB；禁止 `<script` `<iframe` `<object`、`javascript:`、`data:text/html` |
| `variables[]` | array | 否 | 最多 50；元素 `{id,label?,type,required?,default?}`，`id` 匹配 `^[a-z][a-z0-9_-]{0,63}$`，`default` 类型必须与 `type` 一致，`id` 不重复 |
| `suggestedTags` | string[] | 否 | 最多 20，每项 1–64 |
| `documentTypes` | string[] | 否 | 1–2 项：`note` / `markdown` |

### 5.7 `promptPacks[]`（`since 2.1`）

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z][a-z0-9-]{0,63}$`，数组内唯一 |
| `name` | string | 是 | 1–100 |
| `description` | string | 否 | ≤500 |
| `prompt` | string | 是 | 非空，≤64 KiB；内容安全规则同 `noteTemplates.body` |
| `inputs[]` | array | 否 | 最多 50，字段同 `variables[]`，`id` 不重复 |
| `context` | string[] | 否 | 最多 4 项：`title` / `note` / `selection` / `tags` |
| `outputMode` | string | 否 | `text` / `markdown`（默认）/ `replace-selection` / `append` |
| `uiPlatform` | string[] | 否 | 最多 4 项：`web`/`desktop`/`android`/`ios` |

### 5.8 `uiComponents[]`（`since 2.1`，需 `NOWEN_UI_EXTENSIONS`）

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z][a-z0-9-]{0,63}$`，数组内唯一 |
| `kind` | string | 是 | 字面量 `action` |
| `label` | string | 是 | 1–100 |
| `description` | string | 否 | ≤500 |
| `icon` | string | 是 | `home`/`star`/`files`/`diary`/`tasks`/`mindmap`/`ai`/`shares`/`settings` |
| `allowedSlots` | string[] | 是 | 恰好 1 项，当前仅 `floating-layer` |
| `defaultPlacement.slot` | string | 否 | 必须在 `allowedSlots` 内 |
| `defaultPlacement.order` | number | 否 | 整数 0–999 |
| `action.type` | string | 是 | 字面量 `navigation.open` |
| `action.target` | string | 是 | `all`/`favorites`/`files`/`diary`/`tasks`/`mindmaps`/`ai-chat`/`shares`/`settings` |
| `uiPlatform` | string[] | 否 | 1–4 项：`web`/`desktop`/`android`/`ios` |

### 5.9 `sidebarPanels[]`（`since 2.2`）

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z][a-z0-9-]{0,63}$`，数组内唯一 |
| `title` | string | 是 | 1–100 |
| `icon` | string | 是 | 同 §5.8 icon 枚举 |
| `kind` | string | 是 | `builtin` / `static-card` |
| `builtinId` | string | 条件 | `kind=builtin` 必填（≤64） |
| `cards[]` | array | 条件 | `kind=static-card` 必须 ≥1 张；`builtin` 不允许出现 |
| `cards[].id` | string | 是 | `^[a-z][a-z0-9-]{0,63}$` |
| `cards[].title` | string | 是 | 1–120 |
| `cards[].description` | string | 否 | ≤500 |
| `cards[].link.label` | string | 是（link 存在时） | 1–50 |
| `cards[].link.target` | string | 是（link 存在时） | 同 §5.8 `action.target` |
| `defaultOpen` | boolean | 否 | 启用插件时是否默认挂载 |
| `uiPlatform` | string[] | 否 | 1–4 项 |

### 5.10 `mainViewPanels[]`

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z][a-z0-9-]{0,63}$`，数组内唯一 |
| `title` | string | 是 | 1–100 |
| `icon` | string | 是 | 同上 |
| `builtinId` | string | 是 | 目前仅 `tasks` / `diary` |
| `uiPlatform` | string[] | 否 | 1–4 项 |

### 5.11 `editorCommands[]`（`since 2.3`，仅 executable）

出现在编辑器斜杠菜单、可绑定快捷键，执行时调用本插件已声明的 Action。

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z0-9]+(?:[.-][a-z0-9]+)+$`，≤200，数组内唯一；且必须形如 `${pluginId}.<动作>`，动作部分匹配 `^[a-z][a-z0-9-]{0,63}$` |
| `title` | string | 是 | 1–100 |
| `keywords` | string[] | 否 | 最多 10，每项 1–50 |
| `keybinding` | string | 否 | 1–50，格式 `修饰键-..-主按键`，见下 |
| `when` | string | 否 | `editorFocused` / `noteOpen` |
| `action` | string | 是 | 1–64，必须是已声明的 Action id |

`keybinding` 静态校验（`validateKeybinding`，错误文案即校验结果）：

- 令牌数 2–4：`修饰键...-主按键`；主按键只能是**单个字母或数字**。
- 修饰键只允许 `Mod` / `Alt` / `Shift`，不可重复，**必须包含 `Mod` 或 `Alt`**（避免抢占普通输入与 IME）。
- 含 `Mod` 时禁止 `A/C/V/X/Z`（复制/粘贴/剪切/全选/撤销）与 `R/W/Q`（浏览器/系统保留）。
- 同一插件内快捷键（忽略大小写）不可重复；`editorCommands` 仅在 executable 的 `contributes` 中允许。

#### 运行时语义（宿主行为，不在 manifest schema 内）

源码：`frontend/src/lib/pluginEditorCommands.ts`、`frontend/src/components/PluginEditorCommandBridge.tsx`。

| 语义 | 行为 |
| --- | --- |
| `when` 缺省 | 按 `editorFocused` 处理，不会在普通输入框/侧栏抢键。`editorFocused` 的判定是：事件目标 `isContentEditable`，或 `closest(".ProseMirror, .cm-editor, [data-editor-root]")` 命中。`noteOpen` 只要求当前有打开的笔记（`!!noteId`），不要求焦点 |
| `Mod` 语义 | macOS → `metaKey`（⌘），其他平台 → `ctrlKey`；`Alt`→`altKey`、`Shift`→`shiftKey` 严格相等匹配 |
| 大小写 | **主按键**大小写不敏感（解析时统一转大写，`Mod-Alt-k` ≡ `Mod-Alt-K`）；**修饰键必须精确写 `Mod`/`Alt`/`Shift`**，`mod-alt-k` 在**安装期**就被后端拒（`快捷键修饰键只支持 Mod / Alt / Shift`）。若历史记录绕过安装校验，前端解析同样失败并**静默不注册快捷键**（命令仍出现在斜杠菜单） |
| 展示形式 | 平台化渲染，如 `Ctrl+Alt+K` / `⌘⌥K` |
| 按键拦截 | `PluginEditorCommandBridge` 在捕获阶段监听，命中且 `when` 成立时 `preventDefault()`，再经既有插件 Action 通道执行 |
| 执行入参 | 只传该 Action `input` **显式声明过**的字段；目前最多带 `noteId`，且仅当声明了 `noteId` 才带，否则传 `{}`。未声明的字段永不注入（否则 `validateActionInput` 会以"未知参数"拒绝） |
| 注册表刷新 | 每次拉取 `/plugins/contributions` 全量替换；插件停用/卸载后命令随之注销，不残留快捷键 |
| 支持范围 | 斜杠菜单目前只接了 Tiptap（`getDefaultSlashCommands`）；Markdown 编辑器的 `MarkdownSlashMenu` 尚未接入插件命令，但**快捷键对所有编辑器通用**（`.cm-editor` 也在焦点判定内） |

前端会按与后端一致的正则**再校验一次**，不通过的条目（id 前缀不匹配、`title` 超长、`keywords` 元素超 50 字符等）
不会注册、也不会报错——排障时先确认命令是否真的注册上了。修饰键大小写的错误更早：安装期就会被拒。


---

## 6. 权限清单

所有权限声明在 `permissions[]` 中，**授予语义**：安装后写入 `plugin_permissions` 且 `granted=0`；
用户必须对**全部声明权限**逐项确认（`replaceGrants`），否则 `enable()` 报
`必须先确认并授予插件声明的全部权限`。不能授予 manifest 未声明的权限（`不能授予 Manifest 未声明的权限`）。

| 权限 | 能做什么 | 风险级（契约 `risk`） | 是否需授权 | 对应 Host API 方法 | V2 是否支持 |
| --- | --- | --- | --- | --- | --- |
| `notes:read` | 读取当前用户可见的笔记 | data-read | 是 | `notes.get` `notes.list` | 是 |
| `notes:write` | 以当前用户身份创建/更新笔记 | data-write | 是 | `notes.create` `notes.update` | 是 |
| `notebooks:read` | 读取笔记本元数据 | data-read | 是 | `notebooks.get` `notebooks.list` | 是 |
| `notebooks:write` | 创建/修改笔记本结构 | data-write | 是 | `notebooks.create` | 是 |
| `tags:read` | 读取标签 | data-read | 是 | `tags.list` | 是 |
| `tags:write` | 创建标签、增删笔记标签关系 | data-write | 是 | `tags.create` `tags.addToNote` `tags.removeFromNote` | 是 |
| `tasks:read` | 读取当前用户任务 | data-read | 是 | `tasks.get` `tasks.list` | 是 |
| `tasks:write` | 创建/更新任务 | data-write | 是 | `tasks.create` `tasks.update` | 是 |
| `attachments:read` | 读取附件元数据 | data-read | 是 | `attachments.get` `attachments.list` | 是 |
| `attachments:write` | 写入附件（V1 only） | —（契约未登记） | 是 | 无对应方法 | **否**（V2 直接拒：`Plugin API V2 不支持 attachments:write`） |
| `diary:read` | 读取日记 | sensitive-read | 是 | `diary.get` `diary.list` | 是 |
| `diary:write` | 创建日记 | sensitive-write | 是 | `diary.create` | 是 |
| `mindmaps:read` | 读取思维导图 | data-read | 是 | `mindmaps.get` `mindmaps.list` | 是 |
| `mindmaps:write` | 创建/更新思维导图 | data-write | 是 | `mindmaps.create` `mindmaps.update` | 是 |
| `plugin-storage:read` | 读本插件作用域存储（按 user/workspace 隔离；key ≤200B，value ≤256KB） | extension-storage | 是 | `storage.get` | 是 |
| `plugin-storage:write` | 写/删本插件作用域存储（单值 ≤256KB） | extension-storage | 是 | `storage.set` `storage.delete` | 是 |
| `external:fetch` | 由宿主代理向白名单域名发起 HTTPS 请求 | network | 是（且必须配 `permissionConfig.externalFetchHosts`） | `external.fetch` | 是 |
| `secrets:use` | 用已声明的 Connection 凭据签名/注入请求头 | secret-use | 是 | `secrets.digest` `secrets.crypt`；`external.fetch` 的 `connection` 参数 | 是（组合权限） |
| `capture:write` | 抓取公开 HTTPS 文章与图片入库 | data-write | 是 | `capture.importUrl` | 是 |

无权限门槛的方法：`runtime.capabilities`、`settings.get`。

`plugin-storage` 的隔离键：`(pluginId, scopeType, scopeId, key)`，`scopeType` 由 broker 依执行上下文决定
（用户级/工作区级），插件无法跨插件或跨用户读取他人数据。

---

## 7. 外网白名单（`permissionConfig.externalFetchHosts`）

**只写精确域名**：声明期禁通配符、禁端口；运行期按 `host:port` 精确匹配（默认 443）。两侧语义一致，
不会出现"装得上、跑不通"。

### 7.1 声明期校验（安装/升级/市场安装，`validateExternalHost`）

| 情形 | 结果 |
| --- | --- |
| `example.com` / `api.example.com` | 通过 |
| `*.example.com` | **拒**：`不支持通配符，请逐个填写精确域名` |
| `api.example.com:8443` | **拒**：`不能使用 IP 字面量，请填写域名`（含 `:` 一律按 IP 字面量处理，声明期不接受端口） |
| `127.0.0.1` / `8.8.8.8` | 拒：`不能使用 IP 字面量，请填写域名` |
| 含 `:` 的 IPv6 字面量 | 同上 |
| `localhost` | 拒：`不能使用内网/本机域名` |
| `.local` `.internal` `.localdomain` `.localhost` `.lan` `.home.arpa` 后缀 | 同上 |
| `127.0.0.1.nip.io`（合法域名但解析到内网） | **声明期通过**，运行时被 CIDR 拦截（§7.2） |
| 空串 / 超 253 字符 / 非法字符（`_`、空格、CIDR 写法 `10.0.0.0/8`） | 拒：`域名格式不合法（请填写类似 api.example.com 的精确域名）` |
| 数组超过 50 项 | schema 拒绝 |

域名正则：`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$`（大小写不敏感，存储时转小写）。

> 发布侧提醒：`packages/nowen-extension-registry/src/security/manifestV2.ts` 目前只校验
> `externalFetchHosts` 是 `string[]`（长度 ≤50、每项 ≤253），**不校验域名格式**。所以注册表可能在发布时收下一份含
> 通配符的 manifest，但用户端 `parsePluginManifest` 安装时会拒。对外表述请用"用户端安装时拒绝"。

### 7.2 运行期校验（`secureExternalFetch`，每次请求）

| 检查 | 规则 |
| --- | --- |
| URL | 仅 `https:`；不允许 `user:pass@`、不允许 `#fragment`、不允许反斜杠、不允许控制字符/零宽字符 |
| 白名单匹配 | 按 `host:port` 精确匹配（缺省端口 443）；条目可写 `api.example.com` / `api.example.com:8443` / `[2001:db8::1]:443`。带端口只是防御性兼容实现，**对外契约仍是"仅 443 的精确域名"**，manifest 无法声明端口 |
| 通配 | 条目含 `*` 视为**非法配置**并 fail-closed：`allowedHosts.map(normalizeAllowedHost)` 阶段抛 `EXTERNAL_FETCH_DENIED`（"白名单包含无效主机"），本次 `external.fetch` 整体拒绝，不会降级为通配放行（库里的历史 wildcard 配置同样不会被解释成"允许所有子域"） |
| DNS | 自行 `resolveCname`（≤16 层、每层必须唯一别名、必须无环）+ `resolve4`/`resolve6`，解析结果**全部**必须是公网地址，否则拒 |
| IP 固定 | 解析出的地址通过自定义 `lookup` 固定给本次连接，避免二次解析（DNS rebinding） |
| 非公网判定 | IPv4 拒绝 0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.0.0/24、192.0.2/24、192.31.196/24、192.52.193/24、192.88.99/24、192.168/16、192.175.48/24、198.18/15、198.51.100/24、203.0.113/24、224/4、240/4；IPv6 采用"正向白名单"（仅 IANA 已分配全球单播段），并额外拒绝 2001::/23、2001:db8::/32、2002::/16、3fff::/20，以及 IPv4-mapped 地址按内嵌 IPv4 判定 |
| 重定向 | 每跳都重新走白名单 + DNS + CIDR 校验；`301/302/303/307/308`；最多 5 跳；跨源重定向会剥离 `Authorization`/`Cookie`/`Proxy-Authorization` |
| 超时 | 整条链路共享 10s deadline |
| 响应体 | ≤2 MiB（有 `Content-Length` 先判，无则边读边计） |
| 请求头 | 插件输入不能设 `Host`、`Content-Length`、`Connection`、`Transfer-Encoding`、`TE`、`Upgrade`、`proxy-*`、`x-forwarded-*`、`forwarded`、`x-real-ip`、`cf-connecting-ip` 等（静默丢弃）；`authorization`/`cookie`/`proxy-authorization` 只能由 broker 经 `trustedHeaders` 注入 |
| 方法 | 拒绝 `CONNECT`、`TRACE`；方法名需符合 token 语法且 ≤32 字符 |
| 输出 | 只回传 `status`、`ok`、`content-type`、UTF-8 `body`（不暴露响应头全集） |

错误码：`EXTERNAL_FETCH_INVALID_URL`、`EXTERNAL_FETCH_DENIED`、`EXTERNAL_FETCH_DNS_ERROR`、
`EXTERNAL_FETCH_NETWORK_ERROR`、`EXTERNAL_FETCH_TIMEOUT`、`EXTERNAL_FETCH_INVALID_REDIRECT`、
`EXTERNAL_FETCH_REDIRECT_LIMIT`、`EXTERNAL_FETCH_RESPONSE_TOO_LARGE`。

`capture.importUrl`（`capture:write`）走独立链路（`services/article-import.ts` 的 `fetchCapture`，同样是固定公网地址的传输层，
正文 2 MiB / 10s、最多 10 张配图各 3s），**不读** `externalFetchHosts`，但会校验目标笔记本写权限。

---

## 8. 校验与打包命令

> `examples/plugins/my-plugin` 是脚手架的**生成产物**，仓库里默认没有这个目录；先跑下面第 4 条命令生成，
> 再执行其余命令。校验器可以指向任意插件目录，也可以指向已打包的插件包。

```sh
# 生成骨架（内部会自动跑一次下面的校验）
node scripts/create-plugin.mjs my-plugin

# 用后端真实校验链验证目录（manifest zod → ZIP 规则 → 资源存在性 → 限额 → sha256）
node backend/node_modules/tsx/dist/cli.mjs scripts/verify-plugin.mjs examples/plugins/my-plugin

# 也可以直接校验已打包的插件包（安装器真实输入）
node backend/node_modules/tsx/dist/cli.mjs scripts/verify-plugin.mjs \
  examples/plugins/my-plugin/dist/nowenlab.my-plugin-0.1.0.nowen-plugin

# 声明式/受门禁贡献需要指定宿主版本并开门禁
node backend/node_modules/tsx/dist/cli.mjs scripts/verify-plugin.mjs examples/plugins/floating-dock \
  --extensions-v21 --nowen-version=1.6.0

# 打包成可安装 ZIP
cd examples/plugins/my-plugin && node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
```

---

## 9. 已知边界与不一致点（只记录，未修改代码）

1. **白名单两侧语义已对齐，但发布侧没对齐。** 声明期与运行期都只接受精确域名：`*.example.com` 在安装期即报
   `不支持通配符，请逐个填写精确域名`，运行期遇到库里的历史 wildcard 配置也 fail-closed。
   残留缺口在**注册表侧**：`packages/nowen-extension-registry/src/security/manifestV2.ts` 只校验
   `externalFetchHosts` 是 `string[]`、不校验域名格式，因此"发布时就会拦"这件事目前还不成立，只能保证
   "用户端安装时拒绝"。
2. **宿主版本常量落后于示例。** `types.ts` 的 `NOWEN_VERSION = "1.5.0"`，而 `examples/plugins/task-digest`
   要求 `>=1.5.1`、`productivity-pack`/`floating-dock` 要求 `>=1.6.0`，默认参数下这些示例无法通过包校验。
3. **贡献契约与 manifest schema 不同步。** `contribution-contract.json` 声明了 `activityBadges`（since 2.2，
   declarative），但 `manifest.ts` 无该字段（strict schema 会报未知键）；反向地，`mainViewPanels` 在 schema 中存在
   但契约 JSON 未列出。
4. **端口：声明期禁、运行期保留。** manifest 里写 `api.example.com:8443` 会被拒（含 `:` 按 IP 字面量处理），
   对外契约就是"仅 443 的精确域名"；运行期 `host:port` 匹配逻辑保留，只作为遗留/未来配置的防御性实现。
5. **`attachments:write` 处于半废弃状态。** 它在 `PLUGIN_PERMISSIONS` 与 V1 白名单中，但不在
   `host-api-contract.json` 的权限表、也没有对应 Host API 方法，V2 manifest 直接拒。
6. **`sidebarPanels` 的运行时期望与 schema 不一致。** 契约 JSON（工作区 `contractVersion: 6`）把它限定为
   `runtimes: ["declarative"]`，但 manifest schema 对 executable 也放行，`pluginService.contributions()` 也不按
   runtime 过滤，只按 `uiExtensions` 开关过滤。
