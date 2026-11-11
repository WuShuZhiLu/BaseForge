#!/usr/bin/env node
/**
 * baseforge-cli — BaseForge 命令行工具
 *
 * 用法：
 *   baseforge notes list              列出笔记
 *   baseforge notes get <id>          查看笔记
 *   baseforge notes create            创建笔记
 *   baseforge notebooks list          列出笔记本
 *   baseforge attachments upload      上传附件
 *   baseforge attachments list        查询附件
 *   baseforge attachments attach      把附件插入 Markdown 笔记
 *   baseforge search <query>          搜索笔记
 *   baseforge tasks list              列出任务
 *   baseforge tags list               列出标签
 *   baseforge ai ask <question>       知识库问答
 *   baseforge ai process              AI 文本处理
 *   baseforge config                  配置连接信息
 *
 * 环境变量：
 *   BASEFORGE_URL       BaseForge 后端地址（默认 http://localhost:3001）
 *   BASEFORGE_USERNAME  登录用户名（默认 admin）
 *   BASEFORGE_PASSWORD  登录密码（默认 admin123）
 */

import { Command } from "commander";
import chalk from "chalk";
import { BaseForgeClient } from "./sdk-client.js";
import { AttachmentClient } from "./attachment-client.js";
import { registerNotesCommands } from "./commands/notes.js";
import { registerNotebooksCommands } from "./commands/notebooks.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerTasksCommands } from "./commands/tasks.js";
import { registerTagsCommands } from "./commands/tags.js";
import { registerAICommands } from "./commands/ai.js";
import { registerAttachmentCommands } from "./commands/attachments.js";
import { registerConfigCommand } from "./commands/config.js";

function getConfig() {
  return {
    baseUrl: process.env.BASEFORGE_URL || "http://localhost:3001",
    username: process.env.BASEFORGE_USERNAME || "admin",
    password: process.env.BASEFORGE_PASSWORD || "admin123",
  };
}

// ===== 读取配置 =====
export function getClient(): BaseForgeClient {
  return new BaseForgeClient(getConfig());
}

export function getAttachmentClient(): AttachmentClient {
  return new AttachmentClient(getConfig());
}

// ===== 主程序 =====
const program = new Command();

program
  .name("baseforge")
  .description(chalk.bold("BaseForge 命令行工具") + " — 从终端管理你的笔记")
  .version("1.0.0");

registerNotesCommands(program);
registerNotebooksCommands(program);
registerAttachmentCommands(program);
registerSearchCommand(program);
registerTasksCommands(program);
registerTagsCommands(program);
registerAICommands(program);
registerConfigCommand(program);

program.parse();
