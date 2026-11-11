import type { BaseForgeHostApi } from "./hostApi.generated.js";
import type { BaseForgePluginErrorCode } from "./errors.generated.js";

export * from "./hostApi.generated.js";
export * from "./contributions.generated.js";
export * from "./errors.generated.js";
export * from "./mock.generated.js";

export type JsonObject = Record<string, unknown>;
export type ActionResult = { success?: boolean; data?: unknown; text?: string } | unknown;

export interface NoteSummary {
  id: string; notebookId: string; title: string; contentText?: string; contentFormat: string;
  workspaceId: string | null; version: number; createdAt: string; updatedAt: string;
}
export interface Note extends NoteSummary { content: string }
export interface Notebook { id: string; parentId: string | null; name: string; description?: string; icon?: string; color?: string | null; workspaceId: string | null; createdAt: string; updatedAt: string }
export interface Tag { id: string; name: string; color: string; workspaceId: string | null; createdAt: string }
export interface Task extends JsonObject { id: string; title: string; userId: string; workspaceId: string | null; isCompleted: number; priority: number }
export interface Attachment { id: string; noteId: string; filename: string; mimeType: string; size: number; createdAt: string }
export interface Mindmap extends JsonObject { id: string; userId: string; workspaceId: string | null; title: string; data?: unknown; createdAt?: string; updatedAt?: string }

export interface PluginExecutionInfo { executionId: string; correlationId?: string; causationId?: string; depth?: number; idempotencyKey?: string }
export interface PluginActionContext<TInput extends JsonObject = JsonObject> { input: TInput; baseforge: BaseForgeHostApi; execution?: PluginExecutionInfo }
export type PluginActionHandler<TInput extends JsonObject = JsonObject> = (context: PluginActionContext<TInput>) => ActionResult | Promise<ActionResult>;
export interface BaseForgePluginDefinition {
  activate?(context: { baseforge: BaseForgeHostApi }): void | Promise<void>;
  actions: Record<string, PluginActionHandler>;
  deactivate?(): void | Promise<void>;
}

export class BaseForgePluginError extends Error {
  constructor(message: string, readonly code: BaseForgePluginErrorCode = "PLUGIN_ERROR") {
    super(message);
    this.name = "BaseForgePluginError";
  }
}

/** 编译期保留完整类型，运行时原样返回，不夹带业务实现或凭证。 */
export function definePlugin<T extends BaseForgePluginDefinition>(plugin: T): T { return plugin; }
