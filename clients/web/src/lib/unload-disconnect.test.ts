/**
 * Unit tests for `armUnloadDisconnect`.
 *
 * The beacon must: register exactly one `pagehide` listener per page,
 * fire a single `keepalive` POST to `/v1/clients/disconnect` carrying the
 * page's client id and registration headers, and swallow failures (the
 * daemon 404s when the abort-path dispose already removed the
 * subscriber — that outcome is success from the page's point of view).
 */

import { afterEach, describe, expect, test } from "bun:test";

const MODULE_PATH = "@/lib/unload-disconnect";

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

async function freshImport(): Promise<
  typeof import("./unload-disconnect")
> {
  return (await import(
    `${MODULE_PATH}?t=${Math.random()}`
  )) as typeof import("./unload-disconnect");
}

/** Install a fake `fetch` recording calls; returns the calls + restore. */
function stubFetch(): {
  calls: FetchCall[];
  respond: (impl: (url: string, init?: RequestInit) => Promise<unknown>) => void;
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  let impl: (url: string, init?: RequestInit) => Promise<unknown> = async () =>
    new Response(JSON.stringify({ disconnected: 1 }), { status: 200 });
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  }) as typeof fetch;
  return {
    calls,
    respond: (next) => {
      impl = next;
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/**
 * Each `freshImport()` yields a fresh module instance whose `armed` flag
 * starts false, but `window` listeners attach to the one shared window —
 * without cleanup, earlier tests' listeners pile onto later tests' pagehide
 * dispatches. Capture every pagehide listener as it registers and remove
 * them all in `afterEach`.
 */
function capturePagehideListeners(): { restore: () => void } {
  const original = window.addEventListener;
  const added: Array<[string, EventListener]> = [];
  window.addEventListener = ((type: string, listener: EventListener) => {
    if (type === "pagehide") {
      added.push([type, listener]);
    }
    return original.call(window, type, listener);
  }) as typeof window.addEventListener;
  return {
    restore: () => {
      window.addEventListener = original;
      for (const [type, listener] of added) {
        window.removeEventListener(type, listener);
      }
    },
  };
}

describe("armUnloadDisconnect", () => {
  let fetchStub: ReturnType<typeof stubFetch> | null = null;
  let listeners: ReturnType<typeof capturePagehideListeners> | null = null;

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = null;
    listeners?.restore();
    listeners = null;
  });

  test("pagehide sends one keepalive POST with the page's identity", async () => {
    fetchStub = stubFetch();
    listeners = capturePagehideListeners();
    const { armUnloadDisconnect } = await freshImport();
    armUnloadDisconnect();

    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchStub.calls.length).toBe(1);
    const call = fetchStub.calls[0]!;
    expect(call.url).toBe("/v1/clients/disconnect");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.keepalive).toBe(true);
    const headers = new Headers(call.init?.headers);
    expect(headers.get("X-Cadet-Interface-Id")).toBe("web");
    expect(headers.get("X-Cadet-Client-Id")).toBeTruthy();
    const identity = await import("@/lib/client-identity");
    expect(headers.get("X-Cadet-Client-Id")).toBe(identity.getClientId());
    expect(JSON.parse(String(call.init?.body))).toEqual({
      clientId: headers.get("X-Cadet-Client-Id"),
    });
  });

  test("arming twice registers the listener once", async () => {
    fetchStub = stubFetch();
    listeners = capturePagehideListeners();
    const { armUnloadDisconnect } = await freshImport();
    armUnloadDisconnect();
    armUnloadDisconnect();
    armUnloadDisconnect();

    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchStub.calls.length).toBe(1);
  });

  test("a rejected beacon is swallowed, not unhandled", async () => {
    fetchStub = stubFetch();
    listeners = capturePagehideListeners();
    fetchStub.respond(async () => {
      throw new TypeError("page is being torn down");
    });
    const { armUnloadDisconnect } = await freshImport();
    armUnloadDisconnect();

    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchStub.calls.length).toBe(1);
  });

  test("a 404 from the daemon (subscriber already gone) is ignored", async () => {
    fetchStub = stubFetch();
    fetchStub.respond(async () =>
      new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
        status: 404,
      }),
    );
    listeners = capturePagehideListeners();
    const { armUnloadDisconnect } = await freshImport();
    armUnloadDisconnect();

    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchStub.calls.length).toBe(1);
  });

  test("other pages' events do not trigger the beacon", async () => {
    fetchStub = stubFetch();
    listeners = capturePagehideListeners();
    const { armUnloadDisconnect } = await freshImport();
    armUnloadDisconnect();

    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchStub.calls.length).toBe(0);
  });
});
