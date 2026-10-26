import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NoteDeepLinkBridge from "../NoteDeepLinkBridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  state: {
    activeNote: null as { id: string } | null,
    viewMode: "notebook" as string,
  },
  actions: {
    setActiveNote: vi.fn(),
    setMobileView: vi.fn(),
    setViewMode: vi.fn(),
    setSelectedNotebook: vi.fn(),
    openNoteTab: vi.fn(),
  },
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: mocks.state }),
  useAppActions: () => mocks.actions,
}));

vi.mock("@/hooks/useUserPreferences", () => ({
  useUserPreferences: () => ({ prefs: { enableNoteTabs: true } }),
}));

vi.mock("@/hooks/useNoteLoader", () => ({
  useNoteLoader: () => ({ loadNote: vi.fn(), cancelNoteLoad: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({ api: { getNote: vi.fn() } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// appPathNavigation / noteDeepLink 用真实实现（jsdom history 可用），
// 这样断言的是真实 URL 收回行为而非 mock 自说自话。

const NOTE_ID = "86a7c9d7-5078-4240-9a56-a096118f05c7";

function renderBridge(root: Root, activeNote: { id: string } | null) {
  mocks.state.activeNote = activeNote;
  act(() => {
    root.render(<NoteDeepLinkBridge />);
  });
}

describe("NoteDeepLinkBridge 关闭最后一个页签（activeNote → null）", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
    vi.clearAllMocks();
  });

  it("activeNote 从笔记变为 null 时，URL 应从 /notes/:id 收回 /", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    // 打开笔记：URL 先到 /notes/:id，activeNote 就位。
    window.history.pushState({}, "", `/notes/${NOTE_ID}`);
    renderBridge(root, { id: NOTE_ID });
    expect(window.location.pathname).toBe(`/notes/${NOTE_ID}`);

    // 关闭最后一个页签：activeNote → null（viewMode 保持 notebook）。
    renderBridge(root, null);

    expect(window.location.pathname).toBe("/");

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("activeNote 为 null 期间刷新（路由命中 /notes/:id 无对应状态）时保持深链加载语义", () => {
    // 该用例只锁定：URL 命中笔记且 activeNote 为 null 时，桥应发起加载而不是清 URL。
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    window.history.pushState({}, "", `/notes/${NOTE_ID}`);
    renderBridge(root, null);

    // 深链加载语义：URL 不应被立即清掉（由 loadNote 的 onError 负责 404 清理）。
    expect(window.location.pathname).toBe(`/notes/${NOTE_ID}`);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
