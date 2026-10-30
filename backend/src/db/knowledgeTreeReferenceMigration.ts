import type { Migration } from "./migrations.impl.js";
import { ensureKnowledgeTreeReferenceTable } from "./knowledgeTreeMigrationCore.js";

/**
 * 复制 = 连接：同一篇文档可以出现在多个目录。
 *
 * 老库在 v60 已经装过知识树基础表，但那时还没有引用表；单独用一个版本把
 * knowledge_tree_references 补上，避免为了加一张表去重跑基础 helper 的回填 DML。
 */
export const knowledgeTreeReferenceMigration: Migration = {
  version: 137,
  name: "knowledge-tree-references",
  up: ensureKnowledgeTreeReferenceTable,
};
