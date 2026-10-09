import { afterEach, describe, expect, test } from "bun:test";

import {
  setupRemoteGatewayNavBridge,
} from "@/lib/auth/remote-gateway-nav-bridge";

const REAL_PARENT = window.parent;

function setLocation(path: string): void {
  window.history.pushState(null, "", `http://localhost:3000${path}`);
}

function setMode(mode: string | undefined): void {
  window.__CADET_CONFIG__ = mode ? { mode } : undefined;
}

/** Replaces window.parent with a capturing stub and returns its calls. */
function captureParentFrame(): { calls: Array<{ nav?: string; path?: string; source?: string }> } {
  const calls: Array<{ nav?: string; path?: string; source?: string }> = [];
  Object.defineProperty(window, "parent", {
    value: {
      postMessage: (data: unknown) => {
        calls.push(data as { nav?: string; path?: string; source?: string });
      },
    },
    configurable: true,
  });
  return { calls };
}

function parentToIframe(path: string): void {
  const event = new MessageEvent("message", {
    data: { source: "mycadet-web-parent-nav", path },
    source: window.parent as MessageEventSource,
  });
  window.dispatchEvent(event);
}

afterEach(() => {
  Object.defineProperty(window, "parent", {
    value: REAL_PARENT,
    configurable: true,
  });
  setMode(undefined);
  setLocation("/assistant/");
});

describe("remote-gateway nav bridge", () => {
  test("inactive outside remote-gateway mode", () => {
    setMode(undefined);
    const original = window.history.pushState;
    setupRemoteGatewayNavBridge();
    expect(window.history.pushState).toBe(original);
  });

  test("emits push and replace navigations to the parent", () => {
    setMode("remote-gateway");
    const parent = captureParentFrame();
    setupRemoteGatewayNavBridge();

    window.history.pushState(null, "", "/assistant/conversations/12/");
    window.history.replaceState(null, "", "/assistant/conversations/13/");

    expect(parent.calls.map((c) => c.nav)).toEqual(["push", "replace"]);
    expect(parent.calls[0]?.path).toBe("/assistant/conversations/12/");
    expect(parent.calls[1]?.path).toBe("/assistant/conversations/13/");
    expect(parent.calls.every((c) => c.source === "mycadet-web-nav")).toBe(
      true,
    );
  });

  test("applies parent-driven navigation without echoing it back", () => {
    setMode("remote-gateway");
    const parent = captureParentFrame();
    setupRemoteGatewayNavBridge();

    parentToIframe("/assistant/conversations/9/");

    expect(window.location.pathname).toBe("/assistant/conversations/9/");
    // The applied navigation is suppressed — the parent already knows.
    expect(parent.calls).toEqual([]);
  });

  test("ignores parent messages that are not nav drives", () => {
    setMode("remote-gateway");
    const parent = captureParentFrame();
    setupRemoteGatewayNavBridge();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "other-protocol", path: "/assistant/x/" },
        source: window.parent as MessageEventSource,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "mycadet-web-parent-nav", path: "https://evil.example" },
        source: window.parent as MessageEventSource,
      }),
    );

    expect(window.location.pathname).not.toBe("/assistant/x/");
    expect(window.location.pathname).not.toBe("https://evil.example");
    expect(parent.calls).toEqual([]);
  });
});
