// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  revision: 0,
  listener: null as (() => void) | null,
  signedUrl: "",
  acquire: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/noteAttachmentAccessBridge", () => ({
  subscribeAttachmentAccess: (listener: () => void) => {
    fixture.listener = listener;
    return () => {
      if (fixture.listener === listener) fixture.listener = null;
    };
  },
  getAttachmentAccessSnapshot: () => fixture.revision,
  getAttachmentRenderSource: (raw: string | null | undefined) => ({
    attachmentId: "123e4567-e89b-42d3-a456-426614174216",
    persistentSrc: raw || "",
  }),
  acquireAttachmentRenderUrl: fixture.acquire,
}));

vi.mock("@/lib/api", () => ({
  resolveAttachmentUrl: (src: string) => (
    fixture.signedUrl || `https://note.example.com${src.startsWith("/") ? src : `/${src}`}`
  ),
}));

import { useAttachmentVideoRenderSource } from "../useAttachmentVideoRenderSource";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const PERSISTED_SRC = "/api/attachments/123e4567-e89b-42d3-a456-426614174216";

function Probe() {
  const source = useAttachmentVideoRenderSource(PERSISTED_SRC);
  return <video data-testid="video" data-render-key={source.renderKey} src={source.renderSrc} />;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fixture.revision = 0;
  fixture.listener = null;
  fixture.signedUrl = "";
  fixture.acquire.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("useAttachmentVideoRenderSource", () => {
  it("switches to a late signed URL without downloading the whole video as a blob", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await act(async () => {
      root.render(<Probe />);
    });

    expect(host.querySelector("video")?.getAttribute("src"))
      .toBe(`https://note.example.com${PERSISTED_SRC}`);

    fixture.signedUrl = `${PERSISTED_SRC}?exp=123&sig=signed&scope=user`;
    await act(async () => {
      fixture.revision += 1;
      fixture.listener?.();
    });

    const refreshedVideo = host.querySelector("video");
    expect(refreshedVideo?.getAttribute("src")).toBe(fixture.signedUrl);
    expect(refreshedVideo?.getAttribute("data-render-key")).toBe(fixture.signedUrl);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
