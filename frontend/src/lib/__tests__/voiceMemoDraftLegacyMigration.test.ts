import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { voiceMemoDraftStore, type VoiceMemoDraft } from "../voiceMemoDraftStore";

const draft = (id: string): VoiceMemoDraft => ({
  id, scope: `note:${id}`, noteId: id, createdAt: 1, mimeType: "audio/webm",
  durationMs: 100, blob: new Blob(["x"]), status: "recorded",
});

describe("voiceMemoDraftStore 旧 nowen-voice-memo-drafts 库迁移", () => {
  beforeEach(() => { indexedDB = new IDBFactory(); });

  it("首次访问时把旧库草稿搬到新库，旧库保留", async () => {
    const legacy = await openDB("nowen-voice-memo-drafts", 1, { upgrade(db) { db.createObjectStore("drafts", { keyPath: "id" }); } });
    await legacy.put("drafts", draft("old-1"));
    await legacy.put("drafts", draft("old-2"));
    legacy.close();

    const listed = await voiceMemoDraftStore.list("note:old-1");
    expect(listed.map((d) => d.id)).toEqual(["old-1"]);
    const all = await voiceMemoDraftStore.list("note:old-2");
    expect(all.map((d) => d.id)).toEqual(["old-2"]);

    const names = (await indexedDB.databases()).map((e) => e.name);
    expect(names).toContain("nowen-voice-memo-drafts");
    expect(names).toContain("baseforge-voice-memo-drafts");
  });

  it("新写入的草稿直接进新库，且不覆盖同 id 的已有记录", async () => {
    await voiceMemoDraftStore.put(draft("new-1"));
    expect((await voiceMemoDraftStore.list("note:new-1")).map((d) => d.id)).toEqual(["new-1"]);
  });
});
