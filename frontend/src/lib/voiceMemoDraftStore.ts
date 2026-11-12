import { openDB, type IDBPDatabase } from "idb";
import type { RecordedVoice } from "./voiceRecorder";

export interface VoiceMemoAttachment {
  attachmentId: string;
  src: string;
  filename: string;
  mimeType: string;
  size: number;
  durationMs: number;
}
export interface VoiceMemoDraft {
  id: string;
  scope: string;
  noteId: string;
  createdAt: number;
  mimeType: string;
  durationMs: number;
  blob: Blob;
  status: "recorded" | "upload-failed";
  attachment?: VoiceMemoAttachment;
}

const DATABASE_NAME = "baseforge-voice-memo-drafts";
/** 旧版（nowen-note 时期）库名，升级时搬迁一次，避免语音备忘草稿丢失。 */
const LEGACY_DATABASE_NAME = "nowen-voice-memo-drafts";
const database = () => openDB(DATABASE_NAME, 1, { upgrade(db) { db.createObjectStore("drafts", { keyPath: "id" }); } });
let legacyDraftMigration: Promise<void> | null = null;
/** 仅当新库不存在同 id 记录时复制旧库草稿，旧库保留不删除。 */
function migrateLegacyDrafts(db: IDBPDatabase): Promise<void> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return Promise.resolve();
  return indexedDB.databases().then((entries) => {
    if (!entries.some((entry) => entry?.name === LEGACY_DATABASE_NAME)) return;
    return openDB(LEGACY_DATABASE_NAME).then(async (legacy) => {
      try {
        const legacyDrafts = await legacy.getAll("drafts") as VoiceMemoDraft[];
        for (const draft of legacyDrafts) {
          if (!await db.getKey("drafts", draft.id)) await db.put("drafts", draft);
        }
      } finally { legacy.close(); }
    }).catch(() => undefined);
  }).catch(() => undefined);
}
async function openDatabase(): Promise<IDBPDatabase> {
  const db = await database();
  if (!legacyDraftMigration) legacyDraftMigration = migrateLegacyDrafts(db);
  await legacyDraftMigration;
  return db;
}
export const voiceMemoDraftStore = {
  async put(draft: VoiceMemoDraft) { const db = await openDatabase(); try { await db.put("drafts", draft); } finally { db.close(); } },
  async list(scope: string): Promise<VoiceMemoDraft[]> { const db = await openDatabase(); try { return (await db.getAll("drafts") as VoiceMemoDraft[]).filter((draft) => draft.scope === scope).sort((a, b) => a.createdAt - b.createdAt); } finally { db.close(); } },
  async remove(id: string) { const db = await openDatabase(); try { await db.delete("drafts", id); } finally { db.close(); } },
};

export function createVoiceMemoDraft(scope: string, noteId: string, voice: RecordedVoice): VoiceMemoDraft {
  return { id: crypto.randomUUID(), scope, noteId, createdAt: Date.now(), mimeType: voice.mimeType, durationMs: voice.durationMs, blob: voice.blob, status: "recorded" };
}
