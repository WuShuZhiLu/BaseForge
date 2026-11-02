# Hello Nowen

Nowen Extension Platform 的最小示例插件（apiVersion 2，sandbox-js Runtime）。

它同时演示三件事：

1. **最小 Action**：声明一个 `hello` Action，执行后返回一条问候语。
2. **外网白名单声明**：`permissions` 里有 `external:fetch`，并用
   `permissionConfig.externalFetchHosts` 声明精确域名 `api.example.com`。
   本地安装这个包时，安装确认界面会展示「将访问以下域名：api.example.com」的
   域名清单；插件详情页的权限区也会展示同一份清单（域名超过 6 个时折叠为
   「还有 N 个」，点开展开）。示例本身不发起真实外网请求。
3. **编辑器命令（editorCommands）**：声明了一条编辑器命令
   `nowen.hello.insert-greeting`（标题「插入 Hello 问候」）：

   - 快捷键：`Mod-Alt-H`（macOS 为 `Cmd-Alt-H`，Windows/Linux 为 `Ctrl-Alt-H`）
   - 触发条件：`editorFocused`（编辑器获得焦点时）
   - 执行：走本插件自己的 `hello` Action

   **装上之后怎么看效果**：安装并启用本插件 → 打开任意笔记进入编辑器 →
   在正文输入 `/`，斜杠菜单里会出现「插件」分组，包含「插入 Hello 问候」；
   或直接在编辑器里按 `Mod-Alt-H` 触发同一条命令。

## 校验

```bash
node backend/node_modules/tsx/dist/cli.mjs scripts/verify-plugin.mjs examples/plugins/hello-nowen
```
