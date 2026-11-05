import type { Migration } from "./migrations.impl.js";

/**
 * v140：删除 AI 知识问答（对话 / 会话 / 聊天记录）遗留的表。
 *
 * 背景：0.2.0 起产品内核只保留「文档 + 知识库」，AI 问答面板整体移除；
 * AI 能力以「设置里配模型 + 写作助手 + 待办拆解 + embedding 检索」的形式保留，
 * 但不再有产品内的问答会话。代码侧已无任何读写方，这里把存量表清掉。
 *
 * 保留：ai_custom_prompts（写作助手的自定义指令模板）、user_ai_settings（模型配置）。
 *
 * 先删子表再删父表；索引随表自动消失。
 * 幂等：全部 IF EXISTS，重复执行安全。
 */
export const dropAiChatTablesMigration: Migration = {
  version: 140,
  name: "drop-ai-chat-tables",
  up(db) {
    db.exec(`
      DROP TABLE IF EXISTS ai_chat_messages;
      DROP TABLE IF EXISTS ai_chat_conversations;
    `);
  },
};
