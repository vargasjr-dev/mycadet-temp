/**
 * The desktop stream's close-code contract, plus one smoke test that the
 * route resolves through the shared gateway resolver (whose routing rules are
 * covered in `live-voice/connection.test.ts`).
 */

import { describe, expect, mock, test } from "bun:test";


import {
  desktopEndReasonForClose,
  resolveDesktopStreamWsUrl,
} from "./desktop-connection";

// The unified transport mints with a same-origin POST; stood in for so the
// URL smoke test doesn't leave the process.
const originalFetch = globalThis.fetch;

describe("resolving the desktop stream URL", () => {
  test("dials the desktop route on the gateway", async () => {
    const storyFetch = mock(async () =>
      Response.json(
        { token: "tok-abc", expiresAt: "2026-06-01T00:05:00Z" },
        { status: 200 },
      ),
    );
    globalThis.fetch = Object.assign(storyFetch, {
      preconnect: () => {},
    }) as typeof globalThis.fetch;
    try {
      const url = new URL(await resolveDesktopStreamWsUrl("asst-1"));

      // The unified transport: a minted token rides the id-prefixed tunnel
      // path (the routing rules are covered in live-voice/connection.test.ts).
      expect(url.protocol).toBe("wss:");
      expect(url.pathname).toBe("/asst-1/v1/desktop/stream");
      expect(url.searchParams.get("token")).toBe("tok-abc");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("what a close code means", () => {
  test("4013 is another viewer holding the slot", () => {
    expect(desktopEndReasonForClose(4013)).toBe("busy");
  });

  test("4008 is an assistant with no desktop to serve", () => {
    expect(desktopEndReasonForClose(4008)).toBe("unavailable");
  });

  test("4011 is a desktop that did not start", () => {
    expect(desktopEndReasonForClose(4011)).toBe("failed");
  });

  test("tunnel's 1013 tunnel drop is a lost connection, not a busy desktop", () => {
    expect(desktopEndReasonForClose(1013)).toBe("lost");
  });

  test("anything else is a connection worth retrying", () => {
    expect(desktopEndReasonForClose(1000)).toBe("lost");
    expect(desktopEndReasonForClose(1006)).toBe("lost");
    expect(desktopEndReasonForClose(3001)).toBe("lost");
  });
});
