import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LockfileAssistant } from "../lockfile-contract";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them — bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`.
const realLoopbackFetch = { ...(await import("../loopback-fetch")) };

const loopbackSafeFetchMock = mock<typeof realLoopbackFetch.loopbackSafeFetch>(
  async () => new Response("{}", { status: 200 }),
);

mock.module("../loopback-fetch", () => ({
  ...realLoopbackFetch,
  loopbackSafeFetch: loopbackSafeFetchMock,
}));

const { pairLocal } = await import("../remotes/local/pair");

const entry = {
  assistantId: "asst-local",
  cloud: "local",
  port: 7830,
} as unknown as LockfileAssistant;

const body = JSON.stringify({ platform: "cli", deviceId: "device-1" });

afterAll(() => {
  mock.module("../loopback-fetch", () => realLoopbackFetch);
});

describe("pairLocal — the loopback POST is the local presence transport", () => {
  beforeEach(() => {
    loopbackSafeFetchMock.mockImplementation(
      async () => new Response("{}", { status: 200 }),
    );
  });

  test("POSTs the device body to the gateway's pair route", async () => {
    await pairLocal(entry, body);
    expect(loopbackSafeFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = loopbackSafeFetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:7830/v1/pair");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Cadet-Interface-Id": "cli",
    });
    expect(init?.body).toBe(body);
  });

  test("a refused pair comes back structured with the status", async () => {
    loopbackSafeFetchMock.mockImplementation(
      async () => new Response("loopback only", { status: 403 }),
    );
    const result = await pairLocal(entry, body);
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "loopback only",
    });
  });

  test("an ok pair resolves to the parsed response", async () => {
    loopbackSafeFetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ token: "t", guardianId: "g" }), {
          status: 200,
        }),
    );
    const result = await pairLocal(entry, body);
    expect(result).toEqual({
      ok: true,
      response: { token: "t", guardianId: "g" },
    });
  });
});
