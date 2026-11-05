/**
 * McpSettings 纯文本契约测试。
 *
 * 刻意不 import、不渲染组件：只把组件源码当文本读取，逐项核对面板里出现的
 * 包名、命令、路径、环境变量、tools 名称与令牌字段都能在真实文档 / 代码中找到，
 * 并断言面板没有引入禁用词、伪造的连接状态字段或跨模块耦合。
 *
 * 运行：node node_modules/vitest/vitest.mjs run src/components/settings/__tests__/McpSettings.test.tsx
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "..");
const COMPONENT_PATH = resolve(process.cwd(), "src/components/settings/McpSettings.tsx");

/** 只读事实源：team 指定的第 1～4 项真实代码与文档。 */
const FACT_FILES = [
  "packages/nowen-mcp/package.json",
  "packages/nowen-mcp/README.md",
  "packages/nowen-mcp/bin/nowen-mcp.mjs",
  "packages/nowen-mcp/bin/runtime-diagnostics.mjs",
  "packages/nowen-mcp/src/index.ts",
  "packages/nowen-mcp/src/scoped-entry.ts",
  "packages/nowen-mcp/src/scope-policy.ts",
  "packages/nowen-mcp/src/knowledge-scope-tool.ts",
  "packages/nowen-mcp/src/api-client.ts",
  "docs/tutorials/mcp.md",
  "docs/tutorials/mcp-token-resource-scope.md",
  "frontend/src/components/TokenManagement.tsx",
  "backend/src/routes/tokens.ts",
];

const componentSource = readFileSync(COMPONENT_PATH, "utf8");
const allFacts = FACT_FILES.map((file) => readFileSync(resolve(REPO_ROOT, file), "utf8")).join("\n");

/** 面板应当包含、且必须能在事实源逐行找到依据的关键项。 */
const REQUIRED_FACTS = [
  // 包名、构建产物与稳定启动器
  "nowen-mcp",
  "packages/nowen-mcp",
  "dist/scoped-entry.js",
  "bin/nowen-mcp.mjs",
  // 客户端配置字段与路径
  "mcpServers",
  "servers",
  ".vscode/mcp.json",
  ".cursor/mcp.json",
  "nowen-note",
  "stdio",
  "nkn_xxx",
  // 命令与运行环境
  "npm install",
  "npm run build",
  "Node.js 20+",
  "Ctrl+C",
  // 环境变量
  "NOWEN_URL",
  "NOWEN_API_TOKEN",
  "NOWEN_USERNAME",
  "NOWEN_PASSWORD",
  "NOWEN_MCP_HEARTBEAT_MS",
  "ALLOWED_NOTEBOOK_IDS",
  "MCP_ACCESS_MODE",
  "MCP_INCLUDE_DESCENDANTS",
  "http://localhost:3001",
  "http://192.168.1.20:3001",
  "read-only",
  "read-write",
  // 令牌能力
  "scopes",
  "notes:read",
  "notes:write",
  "restricted",
  "unrestricted",
  "fail-closed",
  // 常用 tools（docs/tutorials/mcp.md「可用工具」+ packages/nowen-mcp/src/index.ts）
  "nowen_list_notebooks",
  "nowen_create_notebook",
  "nowen_list_notes",
  "nowen_read_note",
  "nowen_create_note",
  "nowen_update_note",
  "nowen_delete_note",
  "nowen_search",
  "nowen_upload_attachment",
  "nowen_list_attachments",
  "nowen_attach_to_note",
  "nowen_list_tags",
  "nowen_manage_tags",
  "nowen_ai_process",
  "nowen_knowledge_stats",
];

/** 面板禁止出现：禁用词、伪造的连接状态字段、不存在的安装方式、跨模块耦合。 */
const FORBIDDEN_STRINGS = [
  "语雀",
  "测试连接",
  "连接状态",
  "testConnection",
  "connectionStatus",
  "connectStatus",
  "isConnected",
  "mcpStatus",
  "serverStatus",
  "isRunning",
  "isEnabled",
  "启用 MCP",
  "停用 MCP",
  "npx nowen-mcp",
  "一键 DXT",
  "SettingsModal",
  "dispatchEvent",
  "CustomEvent",
  "addEventListener",
  "useState",
  "useEffect",
  "useReducer",
  "useRef",
  "useMemo",
  "useCallback",
  "useTranslation",
  "localStorage",
  "sessionStorage",
  "axios",
];

const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}]/u;

describe("McpSettings 纯文本契约", () => {
  it("导出无 props 的默认函数组件", () => {
    expect(componentSource).toMatch(/export\s+default\s+function\s+McpSettings\s*\(\s*\)/);
  });

  it("写进面板的每一项包名 / 命令 / 路径 / 字段 / tools 都能在真实事实源中找到", () => {
    for (const fact of REQUIRED_FACTS) {
      expect(componentSource, `面板缺少真实能力项：${fact}`).toContain(fact);
      expect(allFacts, `面板中的 ${fact} 在真实文档 / 代码中找不到依据`).toContain(fact);
    }
  });

  it("面板里出现的每个技术标识符都必须能在真实文档 / 代码中找到（防止编造）", () => {
    const tokens = new Set<string>();
    const patterns = [
      /\bNOWEN_[A-Z0-9_]+\b/g,
      /\b(?:ALLOWED_NOTEBOOK_IDS|MCP_ACCESS_MODE|MCP_INCLUDE_DESCENDANTS)\b/g,
      /\bnowen_[a-z0-9_]+\b/g,
      /\bnkn_[A-Za-z0-9_x]*\b/g,
    ];
    for (const pattern of patterns) {
      for (const match of componentSource.matchAll(pattern)) tokens.add(match[0]);
    }
    expect(tokens.size).toBeGreaterThan(10);
    for (const token of tokens) {
      expect(allFacts, `面板出现了事实源中不存在的标识符：${token}`).toContain(token);
    }
  });

  it("产品名为 BaseForge，且不含禁用词、伪造状态字段与跨模块耦合", () => {
    expect(componentSource).toContain("BaseForge");
    for (const word of FORBIDDEN_STRINGS) {
      expect(componentSource, `面板不应出现：${word}`).not.toContain(word);
    }
    expect(componentSource).not.toMatch(/\bfetch\s*\(/);
    expect(componentSource).not.toMatch(/\bwindow\./);
    expect(componentSource).not.toMatch(/\bdocument\./);
    expect(componentSource).not.toMatch(/\buse[A-Z][A-Za-z]*\s*\(/);
    expect(componentSource).not.toMatch(/from ["']@\//);
  });

  it("禁止 emoji，图标只来自 lucide-react", () => {
    expect(componentSource).not.toMatch(EMOJI_PATTERN);
    expect(componentSource).toContain('from "lucide-react"');
    const importSources = Array.from(componentSource.matchAll(/from\s+["']([^"']+)["']/g)).map(
      (match) => match[1],
    );
    expect(importSources.length).toBeGreaterThan(0);
    for (const source of importSources) {
      expect(["react", "lucide-react"], `不得引入业务模块：${source}`).toContain(source);
    }
  });

  it("不宣传已下线的项目内 AI 问答，并如实标注残留工具不可用", () => {
    expect(componentSource).toContain("项目内 AI 问答已移除");
    expect(componentSource).toContain("/api/ai/ask");
    expect(componentSource).toContain("已下线，请勿使用");
    expect(componentSource).not.toContain("AI_ASK_EXAMPLE");
    expect(componentSource).not.toContain("nowen_ai_ask({");
    expect(componentSource).not.toContain("结合 AI 生成回答并标注信息来源");
    // 仍在的端点必须写明，避免用户误以为 AI 处理能力也被删掉
    expect(componentSource).toContain("/api/ai/chat");
    expect(componentSource).toContain("/api/ai/knowledge-stats");
  });

  it("令牌指引使用静态文案，不跳转、不派发事件", () => {
    expect(componentSource).toContain("在『访问令牌』中创建令牌");
    expect(componentSource).not.toContain("SettingsModal");
    expect(componentSource).not.toContain("dispatchEvent");
    expect(componentSource).not.toContain("CustomEvent");
  });
});
