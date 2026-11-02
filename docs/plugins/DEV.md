# Nowen 插件开发指南（DEV）

> 与代码同步于提交 `28634416c`（分支 `feat/space-and-plugins`）。
> 规范细节见 [SPEC.md](./SPEC.md)，安全边界见 [SECURITY.md](./SECURITY.md)。

环境要求：Node ≥ 20（后端开发本身要求 ≥ 22.5），仓库已 `npm install`（`backend/node_modules` 里要有 `tsx`、`jszip`）。

---

## 1. 五分钟跑通

```sh
# 1) 生成骨架：examples/plugins/my-plugin/{manifest.json,main.js,README.md}
node scripts/create-plugin.mjs my-plugin

# 2) 用后端真实校验链验证（脚手架已自动跑过一次，可随时重跑）
node backend/node_modules/tsx/dist/cli.mjs scripts/verify-plugin.mjs examples/plugins/my-plugin

# 3) 打成可安装 ZIP（产物在 dist/，不要提交）
cd examples/plugins/my-plugin
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
# 也可以直接校验产物本身（仍在 my-plugin 目录下）
node ../../../backend/node_modules/tsx/dist/cli.mjs ../../../scripts/verify-plugin.mjs dist/nowenlab.my-plugin-0.1.0.nowen-plugin

# 4) 「设置 → 插件」安装 ZIP → 授权（无权限则跳过）→ 启用 → 执行 Action ping
```

`verify-plugin.mjs` 的第一个参数可以是**目录**，也可以是已打好的 **`.nowen-plugin` / `.zip` 文件**；
两者最终都走 `validatePluginPackage()`。

`verify-plugin.mjs` 不是另写一套规则：它把目录打成内存 ZIP，直接调用
`backend/src/plugins/packageValidator.ts` 的 `validatePluginPackage()`，与安装器走的完全是同一条链（ZIP 结构、
禁止文件、manifest zod schema、入口与资源存在性、包限额、sha256）。

可选参数：

| 参数 | 用途 |
| --- | --- |
| `--nowen-version=1.6.0` | 覆盖宿主版本（默认取 `types.ts` 的 `NOWEN_VERSION`，当前 `1.5.0`）。校验 `engines.nowen` 更高的示例时必须用 |
| `--extensions-v21` | 打开 `extensionsV21` / `uiExtensions` 门禁，用于声明式插件或 `noteThemes`/`uiComponents` 贡献 |

---

## 2. 逐文件拆解一个现成示例：`examples/plugins/task-digest`

这是仓库里最完整的可执行示例（sandbox-js + 一个 Action + 一份 README），适合当模板读。

```
examples/plugins/task-digest/
├── manifest.json   声明式契约：ID、版本、运行时、权限、Action 入参
├── index.js        唯一代码文件：globalThis.__nowenPluginModule 里挂 actions
└── README.md       面向使用者的安装/授权/输入说明
```

### 2.1 `manifest.json`

```json
{
  "id": "nowenlab.task-digest",
  "name": "Task Digest 每日任务简报",
  "description": "Personal daily task summary plugin. ...",
  "version": "1.0.0",
  "apiVersion": 2,
  "publisher": "nowenlab",
  "engines": { "nowen": ">=1.5.1 <2.0.0" },
  "categories": ["productivity"],
  "repository": "https://github.com/cropflre/nowen-note",
  "license": "AGPL-3.0",
  "runtime": "sandbox-js",
  "main": "index.js",
  "permissions": ["tasks:read"],
  "actions": [
    {
      "id": "summary",
      "name": "今日任务简报",
      "execution": "interactive",
      "retryable": false,
      "input": {
        "mode": { "type": "string", "required": false },
        "timezoneOffsetMinutes": { "type": "number", "required": false }
      }
    }
  ]
}
```

逐字段说明（为什么这么填，而不是"能填什么"）：

| 字段 | 这里的值 | 为什么 |
| --- | --- | --- |
| `id` | `nowenlab.task-digest` | V2 强制 `<publisher>.` 前缀，否则报"插件 ID 必须位于 Publisher namespace"；ID 一旦发布不可改（升级沿用） |
| `publisher` | `nowenlab` | 与 ID 前缀一致；正则要求 2–64 字符、`[a-z0-9-]` |
| `version` | `1.0.0` | 三段式；`id@version` 坐标与包 sha256 绑定，同坐标不同内容会被拒 |
| `apiVersion` | `2` | 决定 schema。填 1 就只能 `node-action` 且没有 `categories`/`publisher` 这些字段 |
| `engines.nowen` | `>=1.5.1 <2.0.0` | 只用 `>=1.5.1` 里的能力；上界 `<2.0.0` 防止大版本破坏 |
| `categories` | `["productivity"]` | V2 必填（1–10 项） |
| `repository` / `license` | 仓库地址 / `AGPL-3.0` | V2 两者都必填；缺失时 CLI 的 `validate` 直接失败 |
| `runtime` | `sandbox-js` | 示例只读任务、只做聚合，用真沙箱即可；`main` 必须 `.js` |
| `main` | `index.js` | 相对路径；`sandbox-js` 会被当作脚本求值，不是 ESM |
| `permissions` | `["tasks:read"]` | 最小权限：只读任务。声明即需用户授权，且**全部**声明项都要授予才能启用 |
| `actions[0].id` | `summary` | 与代码里 `actions.summary` 的键必须一致，否则 preflight 报 `PLUGIN_ACTION_MISMATCH` |
| `actions[0].execution` | `interactive` | 手动触发，超时 10s；改 `background` 有 30s，但需要用户从后台任务入口触发 |
| `actions[0].input` | 两个可选字段 | 入参在运行前用 `validateActionInput` 校验：未知 key、类型不符、缺必填都会被拒 |

> 注意：这份示例的 `engines.nowen` 是 `>=1.5.1`，而代码内 `NOWEN_VERSION` 是 `1.5.0`，所以默认参数下
> `verify-plugin.mjs` 会报 `插件要求 BaseForge >=1.5.1 <2.0.0，当前版本为 1.5.0`。这不是写错，是版本常量尚未推进
> （见 SPEC §9）。校验时加 `--nowen-version=1.5.1`。

### 2.2 `index.js`

```js
// 1. 采集：分页拉全个人任务，自带硬上限防打满
async function collectPersonalTasks(nowen) {
  const tasks = [];
  for (let offset = 0; offset < 50000; offset += 100) {
    const page = await nowen.tasks.list({ scope: "personal", limit: 100, offset });
    if (!Array.isArray(page)) throw new Error("Task Host API returned an invalid page");
    tasks.push(...page);
    if (page.length < 100) break;
    if (offset === 49900) throw new Error("Too many tasks for the daily summary");
  }
  return tasks;
}
```

要点：

- `nowen` 是宿主注入的**能力对象**，不是 `fetch` 或 `fs`。这里能调到 `nowen.tasks.list` 的唯一原因是 manifest 申请了
  `tasks:read`，否则 broker 抛 `PLUGIN_PERMISSION_DENIED`。
- 分页要自己写终止条件：Host API 的 `list` 有内部 `LIMIT`，返回不足 `limit` 就是最后一页。
- 循环上限 50000 是**给自己设的 DoS 保护**——`node-action` 会被 10s/30s 超时杀，沙箱还有 Host 调用 1000 次上限，
  显式抛错比被超时中断更容易排查。

```js
// 2. 纯函数：把"今天"的判定与格式化隔离出来，便于单测
function dayString(value) { return String(value || "").slice(0, 10); }
function runForDay(tasks, today, mode, shiftMs) { /* 统计 + 只回传前 20 条 */ }
```

- 时间一律按"本地日"处理：`today = new Date(Date.now() + shiftMs).toISOString().slice(0, 10)`，`shiftMs` 是分钟偏移。
  示例只在沙箱里拿到 `Date`，没有 `Intl`/时区数据库，所以用固定分钟偏移而不是 IANA 时区名。
- 返回结构刻意做小：`tasks: active.slice(0, 20)`。返回体超过 1 MiB 会被 `PLUGIN_OUTPUT_TOO_LARGE` 拒掉，
  而且大对象要跨父/子进程序列化。

```js
// 3. 导出：sandbox-js 的唯一契约
globalThis.__nowenPluginModule = {
  actions: {
    summary: async ({ input, nowen }) => { /* ... */ },
  },
};
```

- **必须是 `globalThis.__nowenPluginModule`**。沙箱求值后会检查这个全局量，缺失即
  `sandbox bundle must define globalThis.__nowenPluginModule`。
- 不要写 `import`/`export`：沙箱把文件当脚本求值。需要多文件时先打包成单文件 IIFE。
- Action 签名固定为 `({ input, nowen, execution })`，返回值必须可 JSON 序列化。
- 入参在这里**再兜一次底**：`mode` 不是 `evening` 就按 `morning`，偏移量非整数或超过 ±840 就退回 480。
  manifest 的 `input` 只校验类型，不校验取值范围。

### 2.3 `README.md`

示例 README 承担三件事，建议照抄结构：

1. **能力声明**：只申请 `tasks:read`、不改任务、不碰 Webhook 凭据（让人敢装）。
2. **安装与输入示例**：`pack` 命令 + 一段可直接粘贴的 JSON 入参。
3. **设计边界**：什么不做（不读共享工作区、不内置第三方报文转换）、时区怎么处理、源码包不等于已签名市场包。

---

## 3. 两种可执行运行时的差异

| 维度 | `sandbox-js` | `node-action` |
| --- | --- | --- |
| 入口形态 | 脚本，挂 `globalThis.__nowenPluginModule`（或 `{ default: {...} }`） | ESM 模块，`export default { actions }` |
| 扩展名 | `main` 必须以 `.js` 结尾 | `.js` / `.mjs` |
| 运行时能力 | QuickJS + `nowen` 桥，无 `fs`/`net`/`process` | 完整 Node（可 `import` 任意内置模块） |
| Action 签名 | `({ input, nowen, execution }) => Promise<JSON>` | 同上；另支持 `activate({ nowen })` / `deactivate()` 生命周期 |
| 内存/超时 | 沙箱 IPC 限额 + 10s/30s | `--max-old-space-size=128` + 10s/30s |
| 适用 | 绝大多数读写类插件（**推荐**） | 需要本地文件/原生依赖/长连接的插件（信任成本高） |

`node-action` 允许的老式入口：`export default { execute(ctx, input) }`（`ctx` 含 `userId`/`workspaceId`/`log`）仍被
`runner-child.mjs` 兼容，但新插件请用 `actions`。

---

## 4. Host API 速查（按权限）

| 权限 | 可调方法 |
| --- | --- |
| 无 | `runtime.capabilities`、`settings.get` |
| `notes:read` / `notes:write` | `notes.get` `notes.list` / `notes.create` `notes.update` |
| `notebooks:read` / `notebooks:write` | `notebooks.get` `notebooks.list` / `notebooks.create` |
| `tags:read` / `tags:write` | `tags.list` / `tags.create` `tags.addToNote` `tags.removeFromNote` |
| `tasks:read` / `tasks:write` | `tasks.get` `tasks.list` / `tasks.create` `tasks.update` |
| `attachments:read` | `attachments.get` `attachments.list` |
| `diary:read` / `diary:write` | `diary.get` `diary.list` / `diary.create` |
| `mindmaps:read` / `mindmaps:write` | `mindmaps.get` `mindmaps.list` / `mindmaps.create` `mindmaps.update` |
| `plugin-storage:read` / `:write` | `storage.get` / `storage.set` `storage.delete` |
| `external:fetch` | `external.fetch`（需 `permissionConfig.externalFetchHosts`） |
| `secrets:use` | `secrets.digest` `secrets.crypt`，以及 `external.fetch({ connection })` |
| `capture:write` | `capture.importUrl` |

单次 Host 调用入参 ≤256 KiB、回参 ≤1 MiB，超限分别报 `HOST_ARGS_TOO_LARGE` / `HOST_RESULT_TOO_LARGE`。

沙箱里额外可用 `nowen.progress({ current, total, message })`（每次执行最多 100 条、文案 ≤500 字符）。

---

## 5. 声明式插件（零代码）

`runtime: "declarative"` 的插件不写任何代码，只在 `contributes` 里给静态数据。以 `examples/plugins/productivity-pack`
为例（`noteTemplates` + `promptPacks`）：

```json
{
  "runtime": "declarative",
  "permissions": [],
  "contributes": {
    "noteTemplates": [{
      "id": "meeting-notes", "name": "会议纪要", "contentFormat": "markdown",
      "body": "# {{title}}\n\n## 目标\n\n{{goal}}\n",
      "variables": [
        { "id": "title", "label": "会议主题", "type": "string", "required": true },
        { "id": "goal", "label": "会议目标", "type": "string", "default": "" }
      ],
      "suggestedTags": ["会议"], "documentTypes": ["markdown"]
    }]
  }
}
```

硬约束：

- `permissions` 必须为 `[]`；不能有 `permissionConfig`；不能有 `secret` 设置项。
- 包内**不能有** `.js`/`.mjs`/`.cjs`/`.wasm`（否则 `PLUGIN_CONTRIBUTION_INVALID`）。
- 至少提供一个静态贡献（否则"声明式插件必须至少提供一个静态 Contribution"）。
- 需要 `engines.nowen >=1.6.0` **且** `NOWEN_EXTENSIONS_V21` 开启，否则装不上
  （`PLUGIN_V21_FEATURE_DISABLED` / `PLUGIN_NOWEN_INCOMPATIBLE`）。
- `body` 与 `prompt` 会被内容检查：禁止 `<script`/`<iframe`/`<object`/`javascript:`/`data:text/html`。
  正文 ≤256 KiB、prompt ≤64 KiB。

校验这类插件必须带门禁参数：

```sh
node backend/node_modules/tsx/dist/cli.mjs scripts/verify-plugin.mjs examples/plugins/productivity-pack \
  --extensions-v21 --nowen-version=1.6.0
```

---

## 5.1 编辑器命令（斜杠菜单 + 快捷键）

executable 插件可以把自己的 Action 挂到编辑器斜杠菜单上，并绑定快捷键（`since 2.3`，字段与校验规则见
SPEC §5.11）：

```json
{
  "contributes": {
    "editorCommands": [{
      "id": "nowenlab.my-plugin.insert-stamp",
      "title": "插入时间戳",
      "keywords": ["时间", "stamp"],
      "keybinding": "Mod-Alt-K",
      "when": "editorFocused",
      "action": "ping"
    }]
  }
}
```

四个最容易踩的点：

1. **`id` 必须是 `<pluginId>.<localId>`**（例：`nowenlab.my-plugin.insert-stamp`，不是 `insert-stamp`），
   `localId` 部分匹配 `^[a-z][a-z0-9-]{0,63}$`。
2. **修饰键大小写敏感**：`Mod-Alt-K` 合法，`mod-alt-k` 会在安装期被拒（`快捷键修饰键只支持 Mod / Alt / Shift`）；
   主按键大小写无所谓。含 `Mod` 时不能用 `A/C/V/X/Z`（基础快捷键）和 `R/W/Q`（系统保留）。
3. **`Action` 收不到 `noteId` 是因为没声明**：宿主只注入该 Action `input` 里显式声明过的字段，目前最多带
   `noteId`。要拿当前笔记 id，就在 `actions[].input` 里加 `"noteId": {"type":"string"}`。
4. **斜杠菜单目前只在 Tiptap 编辑器**；Markdown 编辑器的斜杠菜单未接入插件命令，但快捷键对所有编辑器通用。

`when` 不写等同于 `editorFocused`（只在编辑器区域抢键，不会在侧栏输入框里触发）；写 `noteOpen` 则只要求当前有
打开的笔记。

---

## 6. 权限申请与调试

### 6.1 加权限的正确姿势

1. 只加真正用到的权限；`permissions` 里每一项都会出现在安装确认页。
2. 加 `external:fetch` 时必须同时写 `permissionConfig.externalFetchHosts`，否则每次请求都被拒（白名单为空）。
   **只写精确域名**：`*.example.com` 在**安装期**就被拒（`不支持通配符，请逐个填写精确域名`），
   `api.example.com:8443` 也会被拒（声明期不接受端口）。运行期同样是精确匹配，别指望通配（见 SPEC §7）。
3. 加 `connections` 时必须同时申请 `secrets:use`，否则 manifest 校验直接报"声明 connections 必须请求 secrets:use"。
4. 已发布插件新增权限时，更新检查会算出 `permissionDiff.added` / `addedHosts`，用户需要重新确认；
   不要指望"更新静默继承授权"——`initialize()` 会把 `granted` 重置为 0。

### 6.2 常见错误码

| 错误码 | 触发点 | 处理 |
| --- | --- | --- |
| `PLUGIN_PERMISSION_DENIED` | Host 调用时权限未授予 | 让用户在插件页确认授权（必须授予全部声明权限） |
| `PLUGIN_ACTION_MISMATCH` | preflight 时 manifest 里的 action 没实现 | `actions` 对象的键要与 `actions[].id` 完全一致 |
| `PLUGIN_PREFLIGHT_FAILED` | 入口加载失败（语法错误、缺 `globalThis.__nowenPluginModule`） | 用 `verify-plugin` + `nowen-plugin doctor` 复查 |
| `PLUGIN_TIMEOUT` | 超 10s/30s | 拆小任务或改 `background` |
| `PLUGIN_MEMORY_LIMIT` | 进程 OOM | 别把全库读进内存，分页处理 |
| `PLUGIN_INPUT_TOO_LARGE` / `PLUGIN_OUTPUT_TOO_LARGE` | 入参 >256 KiB / 出参 >1 MiB | 只回传摘要 |
| `PLUGIN_NOT_ENABLED` | 未启用就调 Action | 先启用 |
| `PLUGIN_NOWEN_INCOMPATIBLE` | `engines.nowen` 不匹配 | 改范围或升级宿主 |
| `PLUGIN_V21_FEATURE_DISABLED` | 声明式/主题/UI 贡献在门禁关闭时安装 | 需要开 `NOWEN_EXTENSIONS_V21`（及 `NOWEN_UI_EXTENSIONS`） |
| `PLUGIN_RATE_LIMITED` | 外网 60/min、600/h、并发 4 超限 | 退避重试 |
| `EXTERNAL_FETCH_DENIED` | 域名不在白名单 / 解析到内网 / 白名单含 `*` | 检查 `externalFetchHosts` |
| `HOST_METHOD_NOT_FOUND` / `HOST_METHOD_UNSUPPORTED` | 调了不存在或当前 runtime/apiVersion 不支持的方法 | 对照 §4 表 |

### 6.3 本地调试

- **开发目录**：Desktop 嵌入式后端/开发环境下可加载 `plugins-dev` 目录，`source='dev'`、`trustLevel='developer'`。
  进程重启后一律回到 `quarantined` 且清空授权——这是设计如此，不是 bug。
- **日志**：插件 `console.log`/`console.error` 会进执行日志尾（500 行 / 64 KiB），写入前会把
  `authorization/cookie/token/secret/password/api-key` 这类 `key=value` 形式替换为 `[REDACTED]`。
- **CLI**：`nowen-plugin validate` 只做轻量检查（正则 + 必填字段），**不等于**安装校验；
  最终以 `verify-plugin.mjs` / 安装器为准。

---

## 7. 仓库约定

| 路径 | 作用 |
| --- | --- |
| `docs/plugins/SPEC.md` | 字段与限额的唯一事实来源 |
| `docs/plugins/SECURITY.md` | 隔离/授权/威胁模型 |
| `docs/plugins/DEV.md` | 本文 |
| `examples/plugins/*` | 可运行示例；新增示例优先用脚手架生成 |
| `scripts/create-plugin.mjs` | 生成骨架 + 自动校验 |
| `scripts/verify-plugin.mjs` | 复用 `validatePluginPackage` 的目录校验器（需 tsx） |
| `packages/nowen-plugin-cli` | `validate` / `doctor` / `pack` 命令 |
| `packages/nowen-plugin-sdk` | `host-api-contract.json`、`contribution-contract.json`、`error-code-contract.json` |
