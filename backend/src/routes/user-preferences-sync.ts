import { Hono } from "hono";
import { getDb } from "../db/schema";

type MarkdownViewMode = "source" | "preview" | "split";
type RemoteImagePasteMode = "localize" | "ask" | "keep-remote";
type ReadingDensity = "cozy" | "compact";
type EditorFontSize = 0 | 14 | 16 | 18 | 20 | 22 | 24;
type EditorMode = "md" | "tiptap";
type CodeBlockCollapseMode = "expanded" | "long" | "collapsed";
type FolderAutoLockMinutes = 0 | 5 | 15 | 30 | 60;
type NavigationModuleId = "notifications" | "favorites" | "files" | "diary" | "tasks" | "mindmaps" | "ai-chat" | "shares";
type TaskCenterOptionalModuleId = "inbox" | "my-day" | "planner" | "habits" | "stats";
type NoteTheme = "default" | "paper" | "minimal" | "eye-care";
type CodeBlockTheme =
  // auto = 跟随昼夜：浅色取 GitHub Light，深色取 GitHub Dark
  | "auto"
  | "github-dark"
  | "github-light"
  | "dracula"
  | "monokai"
  | "solarized-light"
  | "one-dark"
  | "nord";

export interface SyncedUserPreferences {
  noteTitleAsAppTitle: boolean;
  outlineDefaultOpen: boolean;
  lockOnOpen: boolean;
  folderAutoLockMinutes: FolderAutoLockMinutes;
  folderLockOnBackground: boolean;
  showNotesInNotebookTree: boolean;
  readingDensity: ReadingDensity;
  editorFontSize: EditorFontSize;
  showNoteListUpdatedTime: boolean;
  enableNoteTabs: boolean;
  markdownDefaultViewMode: MarkdownViewMode;
  remoteImagePasteMode: RemoteImagePasteMode;
  defaultEditorMode: EditorMode;
  codeBlockTheme: CodeBlockTheme;
  codeBlockCollapseMode: CodeBlockCollapseMode;
  noteTheme: NoteTheme;
  noteListTitleOnly: boolean;
  hiddenNavigationModules: NavigationModuleId[];
  navigationModuleOrder: NavigationModuleId[];
  hiddenTaskCenterModules: TaskCenterOptionalModuleId[];
  journalLockOnEntry: boolean;
  showNoteListDividers: boolean;
}

type PreferenceKey = keyof SyncedUserPreferences;
type PreferencePatch = Partial<SyncedUserPreferences>;
type FieldUpdatedAt = Partial<Record<PreferenceKey, string>>;

interface StoredPreferenceMeta {
  version: 2;
  revision: number;
  fieldUpdatedAt: FieldUpdatedAt;
  /** 已应用过的「默认值版本」（缺省 = 1）：用于默认值变更时的一次性迁移 */
  defaultsRevision?: number;
}

interface StoredPreferenceDocument extends SyncedUserPreferences {
  __meta?: StoredPreferenceMeta;
}

interface PreferenceState {
  prefs: SyncedUserPreferences;
  hasPreferences: boolean;
  revision: number;
  fieldUpdatedAt: FieldUpdatedAt;
  updatedAt: string | null;
}

export const DEFAULT_SYNCED_USER_PREFERENCES: SyncedUserPreferences = {
  noteTitleAsAppTitle: false,
  outlineDefaultOpen: false,
  lockOnOpen: false,
  folderAutoLockMinutes: 15,
  folderLockOnBackground: true,
  showNotesInNotebookTree: false,
  readingDensity: "cozy",
  editorFontSize: 0,
  showNoteListUpdatedTime: true,
  enableNoteTabs: false,
  markdownDefaultViewMode: "source",
  remoteImagePasteMode: "localize",
  defaultEditorMode: "tiptap",
  codeBlockTheme: "auto",
  codeBlockCollapseMode: "long",
  noteTheme: "default",
  noteListTitleOnly: false,
  hiddenNavigationModules: [],
  navigationModuleOrder: ["notifications", "favorites", "files", "diary", "tasks", "mindmaps", "ai-chat", "shares"],
  hiddenTaskCenterModules: [],
  journalLockOnEntry: false,
  showNoteListDividers: false,
};

const PREFERENCE_KEYS = Object.keys(DEFAULT_SYNCED_USER_PREFERENCES) as PreferenceKey[];
/** 默认值版本：v2 = 大纲默认不钉住；v3 = 代码块默认跟随昼夜（auto） */
const PREFERENCE_DEFAULTS_REVISION = 3;
const PREFERENCE_KEY_SET = new Set<string>(PREFERENCE_KEYS);
const NAVIGATION_MODULE_ORDER: NavigationModuleId[] = ["notifications", "favorites", "files", "diary", "tasks", "mindmaps", "ai-chat", "shares"];
const NAVIGATION_MODULE_IDS = new Set<string>(NAVIGATION_MODULE_ORDER);
const TASK_CENTER_OPTIONAL_MODULE_IDS = new Set<string>(["inbox", "my-day", "planner", "habits", "stats"]);
const CODE_BLOCK_THEMES = new Set<CodeBlockTheme>([
  "auto",
  "github-dark",
  "github-light",
  "dracula",
  "monokai",
  "solarized-light",
  "one-dark",
  "nord",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeNavigationModuleOrder(value: unknown, fallback: NavigationModuleId[]): NavigationModuleId[] {
  const source = Array.isArray(value) ? value : fallback;
  const saved = Array.from(new Set(source.filter((item): item is NavigationModuleId =>
    typeof item === "string" && NAVIGATION_MODULE_IDS.has(item)
  )));
  const seen = new Set(saved);
  return [...saved, ...NAVIGATION_MODULE_ORDER.filter((id) => !seen.has(id))];
}

function normalizePreferenceValue<K extends PreferenceKey>(
  key: K,
  value: unknown,
  fallback: SyncedUserPreferences[K],
): SyncedUserPreferences[K] {
  switch (key) {
    case "noteTitleAsAppTitle":
    case "outlineDefaultOpen":
    case "lockOnOpen":
    case "folderLockOnBackground":
    case "showNotesInNotebookTree":
    case "showNoteListUpdatedTime":
    case "enableNoteTabs":
    case "noteListTitleOnly":
    case "journalLockOnEntry":
    case "showNoteListDividers":
      return (typeof value === "boolean" ? value : fallback) as SyncedUserPreferences[K];
    case "hiddenNavigationModules":
      return (
        Array.isArray(value)
          ? Array.from(new Set(value.filter((item): item is NavigationModuleId =>
              typeof item === "string" && NAVIGATION_MODULE_IDS.has(item)
            )))
          : fallback
      ) as SyncedUserPreferences[K];
    case "navigationModuleOrder":
      return normalizeNavigationModuleOrder(value, fallback as NavigationModuleId[]) as SyncedUserPreferences[K];
    case "hiddenTaskCenterModules":
      return (
        Array.isArray(value)
          ? Array.from(new Set(value.filter((item): item is TaskCenterOptionalModuleId =>
              typeof item === "string" && TASK_CENTER_OPTIONAL_MODULE_IDS.has(item)
            )))
          : fallback
      ) as SyncedUserPreferences[K];
    case "folderAutoLockMinutes":
      return (
        value === 0 || value === 5 || value === 15 || value === 30 || value === 60
          ? value
          : fallback
      ) as SyncedUserPreferences[K];
    case "readingDensity":
      return (value === "cozy" || value === "compact" ? value : fallback) as SyncedUserPreferences[K];
    case "editorFontSize":
      return (
        value === 0 || value === 14 || value === 16 || value === 18 ||
        value === 20 || value === 22 || value === 24
          ? value
          : fallback
      ) as SyncedUserPreferences[K];
    case "markdownDefaultViewMode":
      return (
        value === "source" || value === "preview" || value === "split"
          ? value
          : fallback
      ) as SyncedUserPreferences[K];
    case "remoteImagePasteMode":
      return (
        value === "localize" || value === "ask" || value === "keep-remote"
          ? value
          : fallback
      ) as SyncedUserPreferences[K];
    case "defaultEditorMode":
      return (value === "md" || value === "tiptap" ? value : fallback) as SyncedUserPreferences[K];
    case "codeBlockTheme":
      return (
        typeof value === "string" && CODE_BLOCK_THEMES.has(value as CodeBlockTheme)
          ? value
          : fallback
      ) as SyncedUserPreferences[K];
    case "codeBlockCollapseMode":
      return (
        value === "expanded" || value === "long" || value === "collapsed"
          ? value
          : fallback
      ) as SyncedUserPreferences[K];
    case "noteTheme":
      return (
        value === "default" || value === "paper" || value === "minimal" || value === "eye-care"
          ? value
          : fallback
      ) as SyncedUserPreferences[K];
  }
}

export function normalizeSyncedUserPreferences(
  input: unknown,
  base: SyncedUserPreferences = DEFAULT_SYNCED_USER_PREFERENCES,
): SyncedUserPreferences {
  const raw = isObject(input) ? input : {};
  const next = { ...base };
  for (const key of PREFERENCE_KEYS) {
    next[key] = normalizePreferenceValue(key, raw[key], base[key]) as never;
  }
  return next;
}

function parseFieldUpdatedAt(value: unknown): FieldUpdatedAt {
  if (!isObject(value)) return {};
  const result: FieldUpdatedAt = {};
  for (const key of PREFERENCE_KEYS) {
    const timestamp = value[key];
    if (typeof timestamp === "string" && timestamp.length <= 64) {
      result[key] = timestamp;
    }
  }
  return result;
}

export function readPreferenceState(userId: string): PreferenceState {
  const row = getDb()
    .prepare("SELECT preferencesJson, updatedAt FROM user_preferences WHERE userId = ?")
    .get(userId) as { preferencesJson: string; updatedAt: string } | undefined;

  if (!row) {
    return { prefs: DEFAULT_SYNCED_USER_PREFERENCES, hasPreferences: false, revision: 0, fieldUpdatedAt: {}, updatedAt: null };
  }

  try {
    const parsed = JSON.parse(row.preferencesJson) as unknown;
    const raw = isObject(parsed) ? parsed : {};
    const meta = isObject(raw.__meta) ? raw.__meta : {};
    const revision = typeof meta.revision === "number" && Number.isInteger(meta.revision) && meta.revision > 0 ? meta.revision : 1;
    const fieldUpdatedAt = parseFieldUpdatedAt(meta.fieldUpdatedAt);
    const prefs = normalizeSyncedUserPreferences(raw);
    // 默认值迁移（一次性）：旧默认曾随升级全量 seed 进存量记录，无法区分「用户改的」
    // 与「默认写进去的」，故按默认值版本号逐版重新落一次新默认；用户此后手动修改会被
    // 保留（版本号已升级，不再重跑）。
    const defaultsRevision = typeof meta.defaultsRevision === "number" && Number.isInteger(meta.defaultsRevision) ? meta.defaultsRevision : 1;
    if (defaultsRevision < PREFERENCE_DEFAULTS_REVISION) {
      // v2：大纲默认不再钉住
      if (defaultsRevision < 2) prefs.outlineDefaultOpen = DEFAULT_SYNCED_USER_PREFERENCES.outlineDefaultOpen;
      // v3：代码块旧默认 github-dark 改为「跟随昼夜」的 auto
      if (defaultsRevision < 3 && prefs.codeBlockTheme === "github-dark") {
        prefs.codeBlockTheme = DEFAULT_SYNCED_USER_PREFERENCES.codeBlockTheme;
      }
      try {
        getDb()
          .prepare("UPDATE user_preferences SET preferencesJson = ? WHERE userId = ?")
          .run(serializeStoredPreferences(prefs, revision, fieldUpdatedAt), userId);
      } catch {
        // 写回失败不阻断读取：下次仍会按旧版默认再迁移一次
      }
    }
    return {
      prefs,
      hasPreferences: true,
      revision,
      fieldUpdatedAt,
      updatedAt: row.updatedAt || null,
    };
  } catch {
    return { prefs: DEFAULT_SYNCED_USER_PREFERENCES, hasPreferences: true, revision: 1, fieldUpdatedAt: {}, updatedAt: row.updatedAt || null };
  }
}

function validatePatch(input: unknown): { patch: PreferencePatch; errors: string[] } {
  const raw = isObject(input) ? input : {};
  const patch: PreferencePatch = {};
  const errors: string[] = [];
  for (const key of PREFERENCE_KEYS) {
    if (!(key in raw)) continue;
    if (key === "hiddenNavigationModules") {
      const value = raw[key];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !NAVIGATION_MODULE_IDS.has(item))) {
        errors.push(`${key} 的值无效`);
        continue;
      }
    }
    if (key === "navigationModuleOrder") {
      const value = raw[key];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !NAVIGATION_MODULE_IDS.has(item))) {
        errors.push(`${key} 的值无效`);
        continue;
      }
    }
    if (key === "hiddenTaskCenterModules") {
      const value = raw[key];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !TASK_CENTER_OPTIONAL_MODULE_IDS.has(item))) {
        errors.push(`${key} 的值无效`);
        continue;
      }
    }
    const current = DEFAULT_SYNCED_USER_PREFERENCES[key];
    const normalized = normalizePreferenceValue(key, raw[key], current);
    if (normalized === current && raw[key] !== current) {
      errors.push(`${key} 的值无效`);
      continue;
    }
    patch[key] = normalized as never;
  }
  return { patch, errors };
}

function serializeStoredPreferences(
  prefs: SyncedUserPreferences,
  revision: number,
  fieldUpdatedAt: FieldUpdatedAt,
  defaultsRevision: number = PREFERENCE_DEFAULTS_REVISION,
): string {
  const document: StoredPreferenceDocument = { ...prefs, __meta: { version: 2, revision, fieldUpdatedAt, defaultsRevision } };
  return JSON.stringify(document);
}

function responsePayload(userId: string, state: PreferenceState, conflict = false) {
  return { ...state.prefs, hasPreferences: state.hasPreferences, userId, revision: state.revision, fieldUpdatedAt: state.fieldUpdatedAt, updatedAt: state.updatedAt, conflict };
}

async function writePreferences(c: any) {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const raw = isObject(body) ? body : {};
  const { patch, errors } = validatePatch(raw);
  if (errors.length > 0) return c.json({ error: errors[0], code: "INVALID_USER_PREFERENCE" }, 400);

  const patchKeys = Object.keys(patch) as PreferenceKey[];
  if (patchKeys.length === 0) {
    const unknownKeys = Object.keys(raw).filter((key) => !PREFERENCE_KEY_SET.has(key) && !key.startsWith("_"));
    return c.json({ error: unknownKeys.length > 0 ? "请求中没有可同步的账号级偏好字段" : "至少需要提供一个偏好字段", code: "EMPTY_USER_PREFERENCE_PATCH" }, 400);
  }

  const current = readPreferenceState(userId);
  const baseRevision = typeof raw._baseRevision === "number" && Number.isInteger(raw._baseRevision) ? raw._baseRevision : null;
  const migration = raw._migration === true;
  const conflict = baseRevision !== null && baseRevision !== current.revision;
  if (migration && current.hasPreferences) return c.json(responsePayload(userId, current, true));

  const nextPrefs = { ...current.prefs };
  const changedKeys: PreferenceKey[] = [];
  for (const key of patchKeys) {
    if (!current.hasPreferences || nextPrefs[key] !== patch[key]) {
      nextPrefs[key] = patch[key] as never;
      changedKeys.push(key);
    }
  }
  if (changedKeys.length === 0 && current.hasPreferences) return c.json(responsePayload(userId, current, conflict));

  const now = new Date().toISOString();
  const nextRevision = current.revision + 1;
  const fieldUpdatedAt = { ...current.fieldUpdatedAt };
  for (const key of changedKeys) fieldUpdatedAt[key] = now;

  getDb().prepare(`
    INSERT INTO user_preferences (userId, preferencesJson, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(userId) DO UPDATE SET
      preferencesJson = excluded.preferencesJson,
      updatedAt = excluded.updatedAt
  `).run(userId, serializeStoredPreferences(nextPrefs, nextRevision, fieldUpdatedAt), now);

  return c.json(responsePayload(userId, { prefs: nextPrefs, hasPreferences: true, revision: nextRevision, fieldUpdatedAt, updatedAt: now }, conflict));
}

const app = new Hono();
app.get("/", (c) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  return c.json(responsePayload(userId, readPreferenceState(userId)));
});
app.put("/", writePreferences);
app.patch("/", writePreferences);

export default app;
