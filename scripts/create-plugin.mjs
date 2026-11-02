#!/usr/bin/env node
/**
 * 生成一个最小可运行的 sandbox-js 插件骨架，写入 examples/plugins/<name>/。
 *
 * 用法：
 *   node scripts/create-plugin.mjs my-plugin
 *   node scripts/create-plugin.mjs acme.my-plugin          # 参数含点号时直接作为完整插件 ID
 *   node scripts/create-plugin.mjs my-plugin --publisher=acme
 *
 * 生成后立刻调用 scripts/verify-plugin.mjs（内部走 backend 的 validatePluginPackage）
 * 做一次真实校验，失败则返回非 0 退出码。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const PUBLISHER_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = argv.filter((item) => !item.startsWith("--"));
  const options = Object.fromEntries(
    argv
      .filter((item) => item.startsWith("--"))
      .map((item) => {
        const [key, ...rest] = item.replace(/^--/, "").split("=");
        return [key, rest.join("=")];
      }),
  );
  return { name: positional[0], options };
}

function manifestSource({ id, publisher, name }) {
  return `${JSON.stringify({
    id,
    publisher,
    name,
    description: `${name} —— 由 scripts/create-plugin.mjs 生成的骨架`,
    version: "0.1.0",
    apiVersion: 2,
    engines: { nowen: ">=1.5.0 <2.0.0" },
    runtime: "sandbox-js",
    main: "main.js",
    categories: ["productivity"],
    keywords: ["starter"],
    repository: "https://github.com/cropflre/nowen-note",
    license: "MIT",
    permissions: [],
    actions: [
      {
        id: "ping",
        name: "Ping",
        description: "回显一条消息，用于确认插件已正确加载",
        execution: "interactive",
        idempotent: true,
        retryable: true,
        input: { message: { type: "string", required: false, description: "要回显的文本" } },
      },
    ],
  }, null, 2)}\n`;
}

const MAIN_SOURCE = `// sandbox-js 入口：宿主在 QuickJS 沙箱里求值本文件，读取 globalThis.__nowenPluginModule。
// 不要用 import/export —— 宿主按脚本求值，需要打包成单文件 IIFE/脚本。
globalThis.__nowenPluginModule = {
  actions: {
    // Action 签名由宿主反序列化：{ input, nowen, execution }
    ping: async ({ input }) => {
      const message = typeof input?.message === "string" && input.message ? input.message : "hello nowen";
      return { ok: true, message };
    },
  },
};
`;

function readmeSource({ name, id }) {
  return `# ${name}

由 \`scripts/create-plugin.mjs\` 生成的 sandbox-js 最小插件：只有一个 \`ping\` Action，不申请任何权限。

- 插件 ID：\`${id}\`
- 运行时：\`sandbox-js\`（QuickJS 沙箱内执行，通过 \`nowen.*\` Host API 访问数据）
- 权限：无（因此启用时不需要授权确认）

## 校验

仓库根目录执行（走后端 \`validatePluginPackage\` 同一条校验链，第一个参数可以是目录或已打包的 ZIP）：

\`\`\`sh
node backend/node_modules/tsx/dist/cli.mjs scripts/verify-plugin.mjs examples/plugins/${name}
\`\`\`

## 打包与安装

\`\`\`sh
cd examples/plugins/${name}
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
\`\`\`

产物在 \`dist/\` 下（\`.nowen-plugin\` + \`.sha256\`），不要提交。

在「设置 → 插件」安装生成的插件包并启用，然后执行 Action \`ping\`：

\`\`\`json
{"message":"hi"}
\`\`\`

## 下一步

- 需要读写数据：在 \`manifest.json\` 的 \`permissions\` 里加 \`plugin-storage:read/write\` 等，再在代码中调用 \`await nowen.storage.get({ key })\`。
- 需要外网请求：加 \`external:fetch\` 权限，并用 \`permissionConfig.externalFetchHosts\` 声明精确域名（见 \`docs/plugins/SPEC.md\`）。
- 字段全集与约束见 \`docs/plugins/SPEC.md\`，安全模型见 \`docs/plugins/SECURITY.md\`。
`;
}

function main() {
  const { name: rawName, options } = parseArgs(process.argv.slice(2));
  if (!rawName) fail("用法: node scripts/create-plugin.mjs <plugin-name> [--publisher=acme]");

  const name = rawName.trim().toLowerCase();
  let id;
  let publisher;
  let directoryName;

  if (name.includes(".")) {
    id = name;
    publisher = name.slice(0, name.indexOf("."));
    directoryName = name;
  } else {
    publisher = (options.publisher || "nowenlab").trim().toLowerCase();
    id = `${publisher}.${name}`;
    directoryName = name;
  }

  if (!PLUGIN_ID_PATTERN.test(id) || id.length > 150) fail(`插件 ID 不合法: ${id}（需匹配 ${PLUGIN_ID_PATTERN}，长度 ≤150）`);
  if (!PUBLISHER_PATTERN.test(publisher)) fail(`publisher 不合法: ${publisher}`);
  if (!id.startsWith(`${publisher}.`)) fail(`插件 ID 必须位于 publisher 命名空间: ${publisher}.`);

  const target = path.join(repoRoot, "examples", "plugins", directoryName);
  if (fs.existsSync(target)) fail(`目录已存在，未覆盖: ${path.relative(repoRoot, target)}`);

  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "manifest.json"), manifestSource({ id, publisher, name: directoryName }), "utf8");
  fs.writeFileSync(path.join(target, "main.js"), MAIN_SOURCE, "utf8");
  fs.writeFileSync(path.join(target, "README.md"), readmeSource({ name: directoryName, id }), "utf8");

  const relativeTarget = path.relative(repoRoot, target).split(path.sep).join("/");
  console.log(`✓ 已生成 ${relativeTarget}`);
  for (const file of ["manifest.json", "main.js", "README.md"]) console.log(`  - ${relativeTarget}/${file}`);

  const tsxCli = path.join(repoRoot, "backend", "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    console.warn("! 未找到 backend/node_modules/tsx，跳过自动校验；请安装后端依赖后手动校验");
    return;
  }
  const command = [tsxCli, path.join(repoRoot, "scripts", "verify-plugin.mjs"), relativeTarget];
  console.log(`\n▶ 校验: node ${command.map((item) => path.relative(repoRoot, item).split(path.sep).join("/")).join(" ")}`);
  const result = spawnSync(process.execPath, command, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) {
    fail("校验未通过，请按上面的错误修正 manifest.json / main.js");
  }
  console.log("\n✓ 校验通过。安装示例见 README.md。");
}

main();
