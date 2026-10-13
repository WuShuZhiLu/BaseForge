// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const NOTE_ID = "note-theme-0001";
const getNoteAppearance = vi.hoisted(() => vi.fn());

vi.mock("@/lib/noteAppearance", async () => {
  const actual = await vi.importActual<typeof import("@/lib/noteAppearance")>("@/lib/noteAppearance");
  return { ...actual, getNoteAppearance };
});

vi.mock("@/lib/pluginApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pluginApi")>("@/lib/pluginApi");
  return { ...actual, pluginApi: { ...actual.pluginApi, contributions: () => Promise.resolve([]) } };
});

import NoteAppearanceBridge from "@/components/NoteAppearanceBridge";
import { resolveNoteThemeTokens } from "@/lib/noteTheme";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  getNoteAppearance.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.classList.remove("dark");
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * 端到端回归：编辑器主区打上 .note-theme-surface + data-note-id 之后，
 * NoteAppearanceBridge 必须真的把 per-note 主题 token 写到该元素上。
 */
it("applies the stored per-note theme onto the marked editor surface", async () => {
  getNoteAppearance.mockResolvedValue({ noteId: NOTE_ID, themeId: "paper" });

  const surface = document.createElement("div");
  surface.className = "note-theme-surface";
  surface.dataset.noteId = NOTE_ID;
  document.body.appendChild(surface);

  await act(async () => {
    root.render(<NoteAppearanceBridge />);
  });
  await flush();

  expect(getNoteAppearance).toHaveBeenCalledWith(NOTE_ID);
  expect(surface.dataset.noteTheme).toBe("paper");
  expect(surface.style.getPropertyValue("--note-theme-surface"))
    .toBe(resolveNoteThemeTokens("paper", "light").surface);

  surface.remove();
});

it("clears the override when the note only follows the default", async () => {
  getNoteAppearance.mockResolvedValue({ noteId: NOTE_ID, themeId: null });

  const surface = document.createElement("div");
  surface.className = "note-theme-surface";
  surface.dataset.noteId = NOTE_ID;
  surface.style.setProperty("--note-theme-surface", "#123456");
  document.body.appendChild(surface);

  await act(async () => {
    root.render(<NoteAppearanceBridge />);
  });
  await flush();

  expect(surface.hasAttribute("data-note-theme")).toBe(false);
  expect(surface.style.getPropertyValue("--note-theme-surface")).toBe("");

  surface.remove();
});
