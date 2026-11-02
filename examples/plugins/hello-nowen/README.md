# Hello Nowen

Nowen Extension Platform 的最小示例插件（apiVersion 2，sandbox-js Runtime）。

> **先装再看**：本插件的编辑器命令**要先把插件包安装并启用才会出现**——
> 没安装/没启用时，斜杠菜单里看不到任何 Hello 相关入口，这不是 bug。
> 安装方式：管理员进入 插件 → 管理 → 「安装插件包」，选择本目录打包的
> `.nowen-plugin` 文件（或用开发者模式指向本目录），确认权限并启用。

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
   - 分组：`category: "示例"`——斜杠菜单里命令会归入「示例」分组而不是
     缺省的「插件」分组（`category` 是 1-20 字的自定义组名，同一组名的
     命令显示在同一分组下）
   - 执行：走本插件自己的 `hello` Action

   **装上之后怎么看效果**：安装并启用本插件 → 打开任意笔记进入编辑器 →
   在正文输入 `/`，斜杠菜单里会出现「示例」分组，包含「插入 Hello 问候」；
   或直接在编辑器里按 `Mod-Alt-H` 触发同一条命令。

## 校验

```bash
node backend/node_modules/tsx/dist/cli.mjs scripts/verify-plugin.mjs examples/plugins/hello-nowen
```
