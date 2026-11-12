#!/usr/bin/env node
/**
 * 触发 Gitea Actions 的 workflow_dispatch。
 *
 * 用途：
 *   1. GitHub 发布完成后，回调 Gitea 触发发布同步（sync-release.yml）；
 *   2. Gitea 同步并转正 Release 后，触发镜像 workflow 把 latest 移动到新版本。
 *
 * 凭据只从环境变量读取：
 *   GITEA_URL      Gitea 站点根地址（如 https://git.example.com）
 *   GITEA_REPO     owner/repo
 *   GITEA_TOKEN    仅需触发 workflow 的 token（不要复用其它写权限 token）
 *   GITEA_REF      分支，缺省 main
 *
 * 用法：
 *   node scripts/dispatch-gitea-workflow.mjs \
 *     --workflow sync-release.yml \
 *     --input tag=v1.0.0 --input publish=true
 */
import process from "node:process";

function parseArgs(argv) {
  const args = { workflow: "", ref: "", inputs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--workflow") args.workflow = argv[++i] || "";
    else if (item === "--ref") args.ref = argv[++i] || "";
    else if (item === "--input") {
      const pair = argv[++i] || "";
      const index = pair.indexOf("=");
      if (index <= 0) throw new Error(`--input 需要 key=value 形式：${pair}`);
      args.inputs.push([pair.slice(0, index), pair.slice(index + 1)]);
    } else if (item === "--help" || item === "-h") {
      console.log("用法: node scripts/dispatch-gitea-workflow.mjs --workflow <file> [--ref <branch>] [--input key=value ...]");
      process.exit(0);
    }
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[dispatch] 缺少环境变量 ${name}`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workflow = args.workflow || process.env.GITEA_WORKFLOW || "";
  if (!workflow) {
    console.error("[dispatch] 缺少 --workflow（如 sync-release.yml）");
    process.exit(2);
  }

  const baseUrl = requireEnv("GITEA_URL").replace(/\/+$/, "");
  const token = requireEnv("GITEA_TOKEN");
  const repo = requireEnv("GITEA_REPO");
  const ref = args.ref || process.env.GITEA_REF || "main";
  const inputs = Object.fromEntries(args.inputs);

  const url = `${baseUrl}/api/v1/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  console.log(`[dispatch] ${repo} workflow=${workflow} ref=${ref} inputs=${JSON.stringify(inputs)}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref, inputs }),
  });

  if (!response.ok) {
    // 不打印响应头，避免把 token 相关字段带进日志。
    const text = await response.text().catch(() => "");
    throw new Error(`[dispatch] Gitea API ${response.status}: ${text.slice(0, 300)}`);
  }
  console.log("[dispatch] 已触发");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
