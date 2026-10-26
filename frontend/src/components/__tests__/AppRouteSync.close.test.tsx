import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppRouteSync from "../AppRouteSync";
import type { AppRoute } from "@/lib/appRoute";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  state: {
    activeNote: null as { id: string } | null,
    viewMode: "notebook" as string,
    route: { kind: "home", url: "/" } as AppRoute,
  },
  actions: {
    setActiveNote: vi.fn(),
    setMobileView: vi.fn(),
    setViewMode: vi.fn(),
    setSelectedNotebook: vi.fn(),
    openNoteTab: vi.fn(),
    setRoute: vi.fn(),
  },
  // 必须是稳定引用：AppRouteSync 的读侧 effect 依赖 loadNote/cancelNoteLoad/t，
  // 每次渲染新建会让 effect 反复重跑、深链 pending 被重复打上（真实实现是 useCallback 稳定引用）。
  loadNote: vi.fn(),
  cancelNoteLoad: vi.fn(),
  t: (key: string) => key,
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: mocks.state }),
  useAppActions: () => mocks.actions,
}));

vi.mock("@/hooks/useUserPreferences", () => ({
  useUserPreferences: () => ({ prefs: { enableNoteTabs: true } }),
}));

vi.mock("@/hooks/useNoteLoader", () => ({
  useNoteLoader: () => ({ loadNote: mocks.loadNote, cancelNoteLoad: mocks.cancelNoteLoad }),
}));

vi.mock("@/lib/api", () => ({ api: { getNote: vi.fn() } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

// appPathNavigation / appRoute 用真实实现（jsdom history 可用），
// 这样断言的是真实 URL 收回行为而非 mock 自说自话。

const NOTE_ID = "86a7c9d7-5078-4240-9a56-a096118f05c7";
const NOTE_ROUTE: AppRoute = { kind: "note", noteId: NOTE_ID, url: `/notes/${NOTE_ID}` };

function renderSync(root: Root, activeNote: { id: string } | null, route: AppRoute) {
  mocks.state.activeNote = activeNote;
  mocks.state.route = route;
  act(() => {
    root.render(<AppRouteSync />);
  });
}

describe("AppRouteSync 关闭最后一个页签（activeNote → null）", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
    vi.clearAllMocks();
  });

  it("activeNote 从笔记变为 null 时，URL 应从 /notes/:id 收回 /（无墓碑、无时间窗）", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    // 打开笔记：URL 先到 /notes/:id，activeNote 就位。
    window.history.pushState({}, "", `/notes/${NOTE_ID}`);
    renderSync(root, { id: NOTE_ID }, NOTE_ROUTE);
    expect(window.location.pathname).toBe(`/notes/${NOTE_ID}`);

    // 关闭最后一个页签：activeNote → null（viewMode 保持 notebook）。
    renderSync(root, null, NOTE_ROUTE);

    expect(window.location.pathname).toBe("/");

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("activeNote 为 null 期间 URL 命中 /notes/:id 时保持深链加载语义", () => {
    // 该用例只锁定：URL 命中笔记且 activeNote 为 null 时，所有者应发起加载而不是清 URL。
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    window.history.pushState({}, "", `/notes/${NOTE_ID}`);
    renderSync(root, null, NOTE_ROUTE);

    // 深链加载语义：URL 不应被立即清掉（由 loadNote 的 onError 负责 404 清理）。
    expect(window.location.pathname).toBe(`/notes/${NOTE_ID}`);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("徽章切模块（viewMode 变化）时 URL 跟随模块路径", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    window.history.pushState({}, "", `/notes/${NOTE_ID}`);
    renderSync(root, { id: NOTE_ID }, NOTE_ROUTE);
    expect(window.location.pathname).toBe(`/notes/${NOTE_ID}`);

    // 切到收藏模块：URL 应跟随 /favorites（原模块同步 effect 语义）。
    renderSync(root, { id: NOTE_ID }, { kind: "home", url: "/" });
    mocks.state.viewMode = "favorites";
    renderSync(root, { id: NOTE_ID }, { kind: "module", viewMode: "favorites", url: "/favorites" });

    expect(window.location.pathname).toBe("/favorites");

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
