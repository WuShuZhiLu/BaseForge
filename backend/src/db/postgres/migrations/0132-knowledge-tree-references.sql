-- 复制 = 连接：同一篇文档可以在多个目录各有一条路径，正文只存一份。
-- 对应 SQLite 迁移 v137（knowledgeTreeReferenceMigration.ts）。
CREATE TABLE IF NOT EXISTS knowledge_tree_references (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT,
  "scopeKey" TEXT NOT NULL,
  "parentId" TEXT NOT NULL
    REFERENCES knowledge_tree_nodes(id) ON DELETE CASCADE,
  "resourceType" TEXT NOT NULL
    CHECK ("resourceType" IN ('note')),
  "resourceId" TEXT NOT NULL,
  title TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isDeleted" INTEGER NOT NULL DEFAULT 0,
  "deletedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("parentId", "resourceId")
);

CREATE INDEX IF NOT EXISTS idx_knowledge_tree_references_scope
  ON knowledge_tree_references("scopeKey", "parentId", "sortOrder", "createdAt");
CREATE INDEX IF NOT EXISTS idx_knowledge_tree_references_resource
  ON knowledge_tree_references("resourceId", "isDeleted");
