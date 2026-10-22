import { describe, expect, it } from "vitest";
import type { NoteVersion } from "@/types";
import { filterVersionsByTab } from "../VersionHistoryPanel";

function version(overrides: Partial<NoteVersion>): NoteVersion {
  return {
    id: "v-1",
    noteId: "note-1",
    userId: "user-1",
    title: "Version",
    version: 1,
    changeType: "edit",
    changeSummary: null,
    createdAt: "2026-01-01 00:00:00",
    ...overrides,
  };
}

const autoVersion = version({ id: "v-auto-1", kind: "auto" });
const legacyVersion = version({ id: "v-legacy-1" }); // 旧后端不下发 kind，按 auto 归类
const manualVersion = version({ id: "v-manual-1", kind: "manual", label: "定稿" });

const all = [autoVersion, legacyVersion, manualVersion];

describe("filterVersionsByTab", () => {
  it("returns the list unchanged for the all tab", () => {
    expect(filterVersionsByTab(all, "all")).toEqual(all);
  });

  it("keeps only manual versions for the manual tab", () => {
    expect(filterVersionsByTab(all, "manual")).toEqual([manualVersion]);
  });

  it("keeps auto versions and legacy rows without kind for the auto tab", () => {
    expect(filterVersionsByTab(all, "auto")).toEqual([autoVersion, legacyVersion]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterVersionsByTab([], "manual")).toEqual([]);
    expect(filterVersionsByTab([manualVersion], "auto")).toEqual([]);
  });
});
