import type { ReactNode } from "react";
import {
  BookOpen,
  Info,
  KeyRound,
  Link2,
  Server,
  ShieldCheck,
  Waypoints,
} from "lucide-react";

/* 客户端最小配置：packages/nowen-mcp/README.md · docs/tutorials/mcp.md */
const MINIMAL_CONFIG = `{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": ["/absolute/path/to/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}`;

const BUILD_COMMANDS = `cd packages/nowen-mcp
npm install
npm run build`;

const QUICK_CHECK = `node ./bin/nowen-mcp.mjs`;

/* 环境变量：packages/nowen-mcp/README.md · docs/tutorials/mcp.md「环境变量」 */
const ENV_VARS: Array<[string, string, string]> = [
  ["NOWEN_URL", "BaseForge 服务地址", "http://localhost:3001"],
  ["NOWEN_API_TOKEN", "Personal API Token，优先于用户名密码", "—"],
  ["NOWEN_USERNAME", "旧版用户名认证，仅用于兼容旧配置", "admin"],
  ["NOWEN_PASSWORD", "旧版密码认证，仅用于兼容旧配置", "admin123"],
  ["ALLOWED_NOTEBOOK_IDS", "MCP 实例侧笔记本白名单，逗号分隔", "未启用"],
  ["MCP_ACCESS_MODE", "read-only 或 read-write", "read-write"],
  ["MCP_INCLUDE_DESCENDANTS", "本地白名单是否包含子笔记本", "false"],
  ["NOWEN_MCP_HEARTBEAT_MS", "可选 stderr 心跳间隔（毫秒），0/off 关闭", "0"],
];

/* 可用工具：docs/tutorials/mcp.md「可用工具」与 packages/nowen-mcp/src/index.ts */
const TOOL_GROUPS: Array<{ label: string; tools: string[] }> = [
  { label: "笔记本", tools: ["nowen_list_notebooks", "nowen_create_notebook"] },
  {
    label: "笔记与搜索",
    tools: [
      "nowen_list_notes",
      "nowen_read_note",
      "nowen_create_note",
      "nowen_update_note",
      "nowen_delete_note",
      "nowen_search",
    ],
  },
  {
    label: "附件与标签",
    tools: [
      "nowen_upload_attachment",
      "nowen_list_attachments",
      "nowen_attach_to_note",
      "nowen_list_tags",
      "nowen_manage_tags",
    ],
  },
  {
    label: "AI 文本处理与统计",
    tools: ["nowen_ai_process", "nowen_knowledge_stats"],
  },
];

function InlineCode({ children }: { children: string }) {
  return (
    <code className="rounded bg-app-bg px-1 py-0.5 font-mono text-[11px] text-tx-primary">
      {children}
    </code>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-app-border bg-app-bg p-3 font-mono text-xs leading-5 text-tx-secondary">
      <code>{children}</code>
    </pre>
  );
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-app-border bg-app-surface p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-tx-primary">
        <span className="text-accent-primary">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

export default function McpSettings() {
  return (
    // 作为「AI 配置」面板的下半部分渲染，用上边框与模型配置区分开。
    <div className="space-y-5 border-t border-app-border pt-5">
      <header>
        <div className="flex items-center gap-2">
          <Link2 size={18} className="text-accent-primary" />
          <h2 className="text-lg font-bold text-tx-primary">MCP 连接</h2>
        </div>
        <p className="mt-1.5 text-sm leading-6 text-tx-tertiary">
          BaseForge 的知识库可作为外部 AI 的检索来源（检索增强 / RAG）。本地 MCP Server{" "}
          <InlineCode>nowen-mcp</InlineCode>{" "}
          以 stdio 方式运行，让 Claude Code、Cursor、VS Code 等 AI 客户端在授权范围内搜索、读取和维护笔记。
        </p>
      </header>

      <div className="flex items-start gap-2 rounded-xl border border-sky-500/20 bg-sky-500/5 p-3 text-xs leading-5 text-sky-700 dark:text-sky-300">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          当前正式可用的是本地源码 stdio Server；Claude.ai / Claude Desktop 的远程 Connector 不能直接连接这个本地 stdio 脚本，远程 MCP 需要单独的 HTTP 传输和认证实现。
        </span>
      </div>

      <Section icon={<Server size={16} />} title="运作方式与准备">
        <ul className="list-disc space-y-1.5 pl-5 text-xs leading-6 text-tx-secondary">
          <li>当前提供的是源码安装方式，需要 Node.js 20+ 与 npm。</li>
          <li>
            MCP Server 由外部 AI 客户端以本地 stdio 方式启动；stdout 仅用于 MCP stdio 协议，诊断日志写入 stderr。
          </li>
          <li>从仓库获取源码后，在 <InlineCode>packages/nowen-mcp</InlineCode> 目录执行构建：</li>
        </ul>
        <CodeBlock>{BUILD_COMMANDS}</CodeBlock>
        <p className="text-xs leading-6 text-tx-secondary">
          构建产物 <InlineCode>dist/scoped-entry.js</InlineCode> 是稳定启动器内部加载的入口，不要直接配置给客户端；客户端应配置稳定启动器{" "}
          <InlineCode>bin/nowen-mcp.mjs</InlineCode>。快速检查（stdio Server 正常会等待客户端输入并保持静默，按 <InlineCode>Ctrl+C</InlineCode> 结束）：
        </p>
        <CodeBlock>{QUICK_CHECK}</CodeBlock>
        <p className="text-xs leading-6 text-tx-secondary">
          认证优先级为 <InlineCode>NOWEN_API_TOKEN</InlineCode>，其次 <InlineCode>NOWEN_USERNAME</InlineCode> 与{" "}
          <InlineCode>NOWEN_PASSWORD</InlineCode>（仅用于兼容旧配置，不建议长期使用）。最终权限是用户 ACL、Token scopes 与 Token 笔记本资源授权的交集。
        </p>
      </Section>

      <Section icon={<Waypoints size={16} />} title="客户端配置">
        <p className="text-xs leading-6 text-tx-secondary">
          通用客户端（Cursor、Claude Desktop 等）使用 <InlineCode>mcpServers</InlineCode>；VS Code 的{" "}
          <InlineCode>.vscode/mcp.json</InlineCode> 使用顶层 <InlineCode>servers</InlineCode>。最小配置：
        </p>
        <CodeBlock>{MINIMAL_CONFIG}</CodeBlock>
        <p className="text-xs leading-6 text-tx-secondary">
          需要替换 <InlineCode>args</InlineCode> 中启动器的绝对路径、<InlineCode>NOWEN_URL</InlineCode> 与{" "}
          <InlineCode>NOWEN_API_TOKEN</InlineCode>。路径必须是绝对路径；Windows JSON 路径中的反斜杠需写成双反斜杠；Linux、macOS 和 WSL 路径必须以 / 开头。若服务部署在 NAS，<InlineCode>NOWEN_URL</InlineCode> 填写能从当前电脑访问的地址，例如{" "}
          <InlineCode>http://192.168.1.20:3001</InlineCode>。
        </p>
        <div>
          <p className="mb-2 text-xs font-medium text-tx-secondary">环境变量</p>
          <dl className="grid gap-2 sm:grid-cols-2">
            {ENV_VARS.map(([name, description, defaultValue]) => (
              <div key={name} className="rounded-lg border border-app-border bg-app-bg/40 px-2.5 py-2">
                <dt><InlineCode>{name}</InlineCode></dt>
                <dd className="mt-1 text-[11px] leading-5 text-tx-tertiary">
                  {description} · 默认 <InlineCode>{defaultValue}</InlineCode>
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <p className="text-xs leading-6 text-tx-secondary">
          <InlineCode>ALLOWED_NOTEBOOK_IDS</InlineCode>、<InlineCode>MCP_ACCESS_MODE</InlineCode> 与{" "}
          <InlineCode>MCP_INCLUDE_DESCENDANTS</InlineCode> 是 MCP 实例侧的本地白名单，可作为服务端 <InlineCode>restricted</InlineCode> 令牌授权之外的第二道限制；两层同时启用时，实际范围取交集。
        </p>
      </Section>

      <Section icon={<KeyRound size={16} />} title="访问令牌">
        <p className="text-xs leading-6 text-tx-secondary">在『访问令牌』中创建令牌。</p>
        <ul className="list-disc space-y-1.5 pl-5 text-xs leading-6 text-tx-secondary">
          <li>
            为每个 AI 客户端创建独立令牌，只开启实际需要的 scopes，例如 <InlineCode>notes:read</InlineCode>、<InlineCode>notes:write</InlineCode>。
          </li>
          <li>
            资源范围选择 <InlineCode>restricted</InlineCode>（限定笔记本），并指定可访问的笔记本，逐项设置「只读」或「读写」，按需开启「自动包含子笔记本」。
          </li>
          <li>
            令牌明文只显示一次，形如 <InlineCode>nkn_xxxxxxxxxxxxxxxxx</InlineCode>，请立即复制保存。
          </li>
          <li>
            <InlineCode>restricted</InlineCode> 令牌的笔记本资源列表为空时采用 fail-closed，所有笔记本访问都会被拒绝；历史令牌默认保持 <InlineCode>unrestricted</InlineCode>。
          </li>
        </ul>
      </Section>

      <Section icon={<BookOpen size={16} />} title="可用工具">
        <p className="text-xs leading-6 text-tx-secondary">
          重启客户端后，可先确认工具列表中出现 <InlineCode>nowen_list_notebooks</InlineCode>、<InlineCode>nowen_list_notes</InlineCode>、<InlineCode>nowen_read_note</InlineCode>、<InlineCode>nowen_search</InlineCode>。常用工具分组如下：
        </p>
        <dl className="space-y-2">
          {TOOL_GROUPS.map((group) => (
            <div key={group.label} className="rounded-lg border border-app-border bg-app-bg/40 px-2.5 py-2">
              <dt className="text-[11px] font-medium text-tx-secondary">{group.label}</dt>
              <dd className="mt-1.5 flex flex-wrap gap-1.5">
                {group.tools.map((tool) => <InlineCode key={tool}>{tool}</InlineCode>)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs leading-6 text-amber-700 dark:text-amber-300">
          项目内 AI 问答已移除；MCP 中残留的 <InlineCode>nowen_ai_ask</InlineCode> 对应后端 <InlineCode>/api/ai/ask</InlineCode> 已下线，请勿使用。
          <InlineCode>nowen_ai_process</InlineCode> 与 <InlineCode>nowen_knowledge_stats</InlineCode> 分别走仍在的 <InlineCode>/api/ai/chat</InlineCode> 与 <InlineCode>/api/ai/knowledge-stats</InlineCode>。
        </p>
        <p className="text-xs leading-6 text-tx-secondary">
          <InlineCode>nowen_search</InlineCode> 为全文搜索，结果自动限定在授权范围内；<InlineCode>nowen_knowledge_stats</InlineCode> 的全局统计在本地 scoped 模式下默认拒绝。
        </p>
      </Section>

      <Section icon={<ShieldCheck size={16} />} title="安全建议">
        <ul className="list-disc space-y-1.5 pl-5 text-xs leading-6 text-tx-secondary">
          <li>每个 AI 客户端使用独立令牌；先用只读令牌验证，再按需增加写权限。</li>
          <li>
            不要把令牌提交到 Git 仓库，也不要把真实令牌写进 <InlineCode>.cursor/mcp.json</InlineCode>、<InlineCode>.vscode/mcp.json</InlineCode> 等配置后提交。
          </li>
          <li><InlineCode>NOWEN_URL</InlineCode> 指向 NAS 时，先从客户端电脑浏览器验证地址可访问。</li>
          <li>
            返回 401 表示令牌错误、过期或已撤销；403 表示 scope、用户 ACL、笔记本授权或本地白名单拒绝了请求，不要改用管理员密码绕过。
          </li>
        </ul>
      </Section>
    </div>
  );
}
