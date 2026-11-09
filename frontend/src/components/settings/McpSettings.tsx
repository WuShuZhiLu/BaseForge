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

/* 客户端最小配置：packages/baseforge-mcp/README.md · docs/tutorials/mcp.md */
const MINIMAL_CONFIG = `{
  "mcpServers": {
    "baseforge": {
      "command": "node",
      "args": ["/absolute/path/to/baseforge-mcp.mjs"],
      "env": {
        "BASEFORGE_URL": "http://192.168.1.20:3001",
        "BASEFORGE_API_TOKEN": "nkn_xxx"
      }
    }
  }
}`;

const BUILD_COMMANDS = `cd packages/baseforge-mcp
npm install
npm run build`;

const QUICK_CHECK = `node ./dist/baseforge-mcp.mjs`;

/* 环境变量：packages/baseforge-mcp/README.md · docs/tutorials/mcp.md「环境变量」 */
const ENV_VARS: Array<[string, string, string]> = [
  ["BASEFORGE_URL", "BaseForge 服务地址", "http://localhost:3001"],
  ["BASEFORGE_API_TOKEN", "Personal API Token，必填，缺失时启动即报错", "—"],
];

/* 可用工具：docs/tutorials/mcp.md「可用工具」与 packages/baseforge-mcp/src/index.ts */
const TOOL_GROUPS: Array<{ label: string; tools: string[] }> = [
  { label: "笔记本", tools: ["baseforge_list_notebooks", "baseforge_create_notebook"] },
  {
    label: "笔记与搜索",
    tools: [
      "baseforge_list_notes",
      "baseforge_read_note",
      "baseforge_create_note",
      "baseforge_update_note",
      "baseforge_delete_note",
      "baseforge_search",
    ],
  },
  {
    label: "附件与标签",
    tools: [
      "baseforge_upload_attachment",
      "baseforge_list_attachments",
      "baseforge_attach_to_note",
      "baseforge_list_tags",
      "baseforge_manage_tags",
    ],
  },
  {
    label: "远程文件（内核能力）",
    tools: [
      "baseforge_list_remote_sources",
      "baseforge_manage_remote_source",
      "baseforge_list_remote_files",
      "baseforge_read_remote_file",
      "baseforge_write_remote_file",
      "baseforge_manage_remote_file",
      "baseforge_list_remote_links",
      "baseforge_manage_remote_link",
    ],
  },
  {
    label: "导出与分享",
    tools: [
      "baseforge_export_notes",
      "baseforge_list_shares",
      "baseforge_create_share",
      "baseforge_update_share",
      "baseforge_delete_share",
    ],
  },
  {
    label: "块与双链",
    tools: [
      "baseforge_get_block",
      "baseforge_search_blocks",
      "baseforge_get_backlinks",
      "baseforge_resolve_link",
    ],
  },
  {
    label: "系统运维（仅 unrestricted 令牌）",
    tools: [
      "baseforge_list_plugins",
      "baseforge_execute_plugin",
      "baseforge_list_webhooks",
      "baseforge_create_webhook",
      "baseforge_audit_stats",
      "baseforge_list_backups",
      "baseforge_create_backup",
    ],
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
          <InlineCode>baseforge-mcp</InlineCode>{" "}
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
          <li>
            MCP Server 是单文件 <InlineCode>baseforge-mcp.mjs</InlineCode>（发布时作为 Release 附件提供，仓库内为 <InlineCode>packages/baseforge-mcp/dist/baseforge-mcp.mjs</InlineCode>），依赖已全部打进文件，使用方只需 Node.js 20+。
          </li>
          <li>
            MCP Server 由外部 AI 客户端以本地 stdio 方式启动；stdout 仅用于 MCP stdio 协议，诊断日志写入 stderr。
          </li>
          <li>
            若仓库中没有构建产物（或需要更新），在 <InlineCode>packages/baseforge-mcp</InlineCode> 目录执行：
          </li>
        </ul>
        <CodeBlock>{BUILD_COMMANDS}</CodeBlock>
        <p className="text-xs leading-6 text-tx-secondary">
          快速检查：命令行运行 <CodeBlock>{QUICK_CHECK}</CodeBlock>，提示缺少 <InlineCode>BASEFORGE_API_TOKEN</InlineCode> 即表示文件可执行（按 <InlineCode>Ctrl+C</InlineCode> 结束）。
        </p>
        <p className="text-xs leading-6 text-tx-secondary">
          权限完全由 <InlineCode>BASEFORGE_API_TOKEN</InlineCode> 决定：最终权限是用户 ACL、Token scopes 与 Token 笔记本资源授权的交集，全部由服务端执行。
        </p>
      </Section>

      <Section icon={<Waypoints size={16} />} title="客户端配置">
        <p className="text-xs leading-6 text-tx-secondary">
          通用客户端（Cursor、Claude Desktop 等）使用 <InlineCode>mcpServers</InlineCode>；VS Code 的{" "}
          <InlineCode>.vscode/mcp.json</InlineCode> 使用顶层 <InlineCode>servers</InlineCode>。最小配置：
        </p>
        <CodeBlock>{MINIMAL_CONFIG}</CodeBlock>
        <p className="text-xs leading-6 text-tx-secondary">
          需要替换 <InlineCode>args</InlineCode> 中单文件的绝对路径、<InlineCode>BASEFORGE_URL</InlineCode> 与{" "}
          <InlineCode>BASEFORGE_API_TOKEN</InlineCode>。路径必须是绝对路径；Windows JSON 路径中的反斜杠需写成双反斜杠；Linux、macOS 和 WSL 路径必须以 / 开头。若服务部署在 NAS，<InlineCode>BASEFORGE_URL</InlineCode> 填写能从当前电脑访问的地址，例如{" "}
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
            按工具组授予 scope：文档用 <InlineCode>notes:read</InlineCode> / <InlineCode>notes:write</InlineCode>，远程文件用{" "}
            <InlineCode>remote_files:read</InlineCode> / <InlineCode>remote_files:write</InlineCode>，分享用{" "}
            <InlineCode>shares:read</InlineCode> / <InlineCode>shares:write</InlineCode>，任务接口用{" "}
            <InlineCode>tasks:read</InlineCode> / <InlineCode>tasks:write</InlineCode>。
          </li>
          <li>
            <InlineCode>restricted</InlineCode> 令牌的笔记本资源列表为空时采用 fail-closed，所有笔记本访问都会被拒绝；历史令牌默认保持 <InlineCode>unrestricted</InlineCode>。
          </li>
        </ul>
      </Section>

      <Section icon={<BookOpen size={16} />} title="可用工具">
        <p className="text-xs leading-6 text-tx-secondary">
          重启客户端后，可先确认工具列表中出现 <InlineCode>baseforge_list_notebooks</InlineCode>、<InlineCode>baseforge_list_notes</InlineCode>、<InlineCode>baseforge_read_note</InlineCode>、<InlineCode>baseforge_search</InlineCode>。常用工具分组如下：
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
          项目内 AI 问答已移除，MCP 也不再提供 AI 类工具；旧的 <InlineCode>baseforge_ai_ask</InlineCode>、
          <InlineCode>baseforge_ai_process</InlineCode> 与 <InlineCode>baseforge_knowledge_stats</InlineCode> 已下线，请勿使用。
          知识库内容通过检索、读取与导出工具提供给外部 AI，不在产品内做 AI 问答。
        </p>
        <p className="text-xs leading-6 text-tx-secondary">
          <InlineCode>baseforge_search</InlineCode> 为全文搜索，结果自动限定在 Token 授权范围内。
        </p>
      </Section>

      <Section icon={<ShieldCheck size={16} />} title="安全建议">
        <ul className="list-disc space-y-1.5 pl-5 text-xs leading-6 text-tx-secondary">
          <li>每个 AI 客户端使用独立令牌；先用只读令牌验证，再按需增加写权限。</li>
          <li>
            不要把令牌提交到 Git 仓库，也不要把真实令牌写进 <InlineCode>.cursor/mcp.json</InlineCode>、<InlineCode>.vscode/mcp.json</InlineCode> 等配置后提交。
          </li>
          <li><InlineCode>BASEFORGE_URL</InlineCode> 指向 NAS 时，先从客户端电脑浏览器验证地址可访问。</li>
          <li>
            返回 401 表示令牌错误、过期或已撤销；403 表示 scope、用户 ACL 或笔记本授权拒绝了请求，不要改用管理员密码绕过。
          </li>
        </ul>
      </Section>
    </div>
  );
}
