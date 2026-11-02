import type { PluginContributionRecord, PluginEditorCommandWhen } from "./pluginApi";
import { pluginApi } from "./pluginApi";
import {
  detectShortcutPlatform,
  formatShortcutChord,
  shortcutChordMatchesEvent,
} from "./shortcutRegistry";
import type { ShortcutChord, ShortcutPlatform } from "./shortcuts/types";

const PLUGIN_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const LOCAL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ACTION_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const KEYBINDING_MODIFIERS = ["Mod", "Alt", "Shift"];
const SUPPORTED_WHEN = new Set<PluginEditorCommandWhen>(["editorFocused", "noteOpen"]);
const MAX_COMMANDS = 50;

/**
 * 已启用插件声明的编辑器命令（`contributes.editorCommands`）。
 *
 * 插件只提供声明（标题/关键词/快捷键/Action id），真正的执行仍走插件 Action 通道，
 * 与命令面板的 plugin commands 完全一致；这里只负责"注册 → 斜杠菜单/快捷键 → 注销"。
 */
export interface RegisteredPluginEditorCommand {
  /** 全局唯一：`<pluginId>.<localId>` */
  id: string;
  pluginId: string;
  localId: string;
  title: string;
  keywords: string[];
  /** 已校验的快捷键组合；非法或未声明时为 undefined（仅出现在斜杠菜单） */
  chord?: ShortcutChord;
  when?: PluginEditorCommandWhen;
  action: string;
}

let registered: RegisteredPluginEditorCommand[] = [];
let revision = 0;
const listeners = new Set<() => void>();

/**
 * 解析 `Mod-Alt-K` 形式快捷键，规则与后端 manifest 校验保持一致：
 * 允许 Mod / Alt / Shift 修饰键 + 单个字母或数字主按键，且必须含 Mod 或 Alt。
 */
export function parseKeybinding(value: unknown): ShortcutChord | null {
  if (typeof value !== "string") return null;
  const tokens = value.split("-");
  if (tokens.length < 2 || tokens.length > 4) return null;
  const primary = tokens[tokens.length - 1];
  if (!/^[A-Za-z0-9]$/.test(primary)) return null;
  const modifiers = tokens.slice(0, -1);
  if (modifiers.some((modifier) => !KEYBINDING_MODIFIERS.includes(modifier))) return null;
  if (new Set(modifiers).size !== modifiers.length) return null;
  if (!modifiers.includes("Mod") && !modifiers.includes("Alt")) return null;
  if (modifiers.includes("Mod") && /^[acvxzrwq]$/i.test(primary)) return null;
  return [...modifiers, primary.toUpperCase()];
}

export function formatKeybinding(chord: ShortcutChord, platform: ShortcutPlatform = detectShortcutPlatform()): string {
  return formatShortcutChord(chord, platform);
}

export function keybindingMatchesEvent(
  chord: ShortcutChord,
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): boolean {
  return shortcutChordMatchesEvent(chord, event, platform);
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 50)
    .slice(0, 10);
}

function toRegistered(pluginId: string, contribution: unknown): RegisteredPluginEditorCommand | null {
  if (!contribution || typeof contribution !== "object" || Array.isArray(contribution)) return null;
  const item = contribution as {
    id?: unknown; title?: unknown; keywords?: unknown; keybinding?: unknown; when?: unknown; action?: unknown;
  };
  if (typeof item.id !== "string" || !item.id.startsWith(`${pluginId}.`)) return null;
  const localId = item.id.slice(pluginId.length + 1);
  if (!LOCAL_ID_RE.test(localId)) return null;
  if (typeof item.title !== "string" || item.title.length === 0 || item.title.length > 100) return null;
  if (typeof item.action !== "string" || !ACTION_ID_RE.test(item.action)) return null;
  const chord = parseKeybinding(item.keybinding) ?? undefined;
  const when = typeof item.when === "string" && SUPPORTED_WHEN.has(item.when as PluginEditorCommandWhen)
    ? (item.when as PluginEditorCommandWhen)
    : undefined;
  return {
    id: item.id,
    pluginId,
    localId,
    title: item.title,
    keywords: normalizeKeywords(item.keywords),
    ...(chord ? { chord } : {}),
    ...(when ? { when } : {}),
    action: item.action,
  };
}

/**
 * 全量替换注册表。宿主每收到一次 `/plugins/contributions` 就调用一次：
 * 插件停用/卸载后不再出现在返回里 → 对应命令随之注销，不残留快捷键。
 */
export function replacePluginEditorCommands(records: PluginContributionRecord[]): number {
  const next: RegisteredPluginEditorCommand[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (!record || typeof record.pluginId !== "string") continue;
    const pluginId = record.pluginId.toLowerCase();
    if (!PLUGIN_ID_RE.test(pluginId)) continue;
    const contributions = Array.isArray(record.editorCommands) ? record.editorCommands : [];
    for (const contribution of contributions.slice(0, MAX_COMMANDS)) {
      const command = toRegistered(pluginId, contribution);
      if (!command || seen.has(command.id)) continue;
      seen.add(command.id);
      next.push(command);
    }
  }
  registered = next;
  revision += 1;
  for (const listener of listeners) listener();
  return registered.length;
}

export function listPluginEditorCommands(): RegisteredPluginEditorCommand[] {
  return registered;
}

/** 命中当前平台/条件后可执行的命令（快捷键分发用）。 */
export function listPluginEditorCommandsWithKeybinding(): RegisteredPluginEditorCommand[] {
  return registered.filter((command) => !!command.chord);
}

export function clearPluginEditorCommands(): void {
  if (registered.length === 0) return;
  registered = [];
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribePluginEditorCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 供 useSyncExternalStore 订阅注册表变化（斜杠菜单即时反映启用/停用）。 */
export function pluginEditorCommandsRevision(): number {
  return revision;
}

/**
 * 组装 Action 入参：只传插件 Action 显式声明的字段，避免 validateActionInput 因
 * "未知参数" 直接拒绝（命令面板历史行为是无条件带 noteId，对未声明该入参的插件会失败）。
 */
export function buildEditorCommandInput(
  context: { noteId?: string | null; declaredInputs?: readonly string[] } = {},
): Record<string, unknown> {
  if (!context.noteId) return {};
  if (!context.declaredInputs?.includes("noteId")) return {};
  return { noteId: context.noteId };
}

/** 插件 Action 声明的入参字段缓存：键为 `<pluginId>/<actionId>`。 */
let declaredInputsByAction = new Map<string, Set<string>>();
let declaredInputsLoading: Promise<void> | null = null;

export function primePluginActionInputs(
  actions: Array<{ pluginId: string; actionId: string; input?: Record<string, unknown> }>,
): void {
  const next = new Map<string, Set<string>>();
  for (const action of actions) {
    if (typeof action.pluginId !== "string" || typeof action.actionId !== "string") continue;
    next.set(`${action.pluginId}/${action.actionId}`, new Set(Object.keys(action.input || {})));
  }
  declaredInputsByAction = next;
  declaredInputsLoading = null;
}

export function resetPluginActionInputs(): void {
  declaredInputsByAction = new Map();
  declaredInputsLoading = null;
}

async function ensurePluginActionInputs(): Promise<void> {
  if (declaredInputsByAction.size > 0) return;
  if (!declaredInputsLoading) {
    declaredInputsLoading = pluginApi
      .actions()
      .then((actions) => primePluginActionInputs(actions))
      .catch(() => {
        declaredInputsLoading = null;
      });
  }
  await declaredInputsLoading;
}

/** 走既有插件 Action 通道执行编辑器命令（快捷键与斜杠菜单共用）。 */
export async function executePluginEditorCommand(
  command: Pick<RegisteredPluginEditorCommand, "pluginId" | "action">,
  context: { noteId?: string | null } = {},
): Promise<void> {
  await ensurePluginActionInputs();
  const declaredInputs = [...(declaredInputsByAction.get(`${command.pluginId}/${command.action}`) || [])];
  await pluginApi.execute(
    command.pluginId,
    command.action,
    buildEditorCommandInput({ noteId: context.noteId, declaredInputs }),
  );
}

/** `when` 条件求值：缺省按 editorFocused 处理，避免插件命令在任意输入框里抢键。 */
export function editorCommandMatchesContext(
  command: Pick<RegisteredPluginEditorCommand, "when">,
  context: { editorFocused: boolean; noteOpen: boolean },
): boolean {
  if (command.when === "noteOpen") return context.noteOpen;
  return context.editorFocused;
}
