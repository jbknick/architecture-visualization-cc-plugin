// Shared helpers for component tests: an in-process fetch backed by the mock fixture.
import { cleanup, type RenderResult, render } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { handleMockApi, handleMockWrite, type MockResponse } from "../mock/fixture.ts";
import { resetMockOverlay } from "../mock/overlay.ts";
import { App } from "./App.tsx";
import { overlayStore } from "./overlayStore.ts";
import { StoreProvider } from "./store.tsx";

// jsdom has no ResizeObserver; the UI kit's tab indicator measures with one.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(() => {
  cleanup();
  resetMockOverlay();
  overlayStore.clear();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

type Override = (url: URL) => MockResponse | null | undefined;

/** Replace fetch with the mock API. `override` can answer first (return undefined to fall through). */
export function installMockFetch(override?: Override) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1");
    calls.push(url.pathname + url.search);
    const method = init?.method ?? "GET";
    const write =
      method === "GET"
        ? null
        : handleMockWrite(url, init?.body ? JSON.parse(String(init.body)) : null, method);
    if (method !== "GET") calls.push(`${method} ${url.pathname} ${String(init?.body ?? "")}`.trimEnd());
    const res = write ?? override?.(url) ?? handleMockApi(url) ?? { status: 404, body: {} };
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

export function renderApp(hash = ""): RenderResult {
  window.location.hash = hash;
  return render(
    <StoreProvider>
      <App />
    </StoreProvider>,
  );
}
