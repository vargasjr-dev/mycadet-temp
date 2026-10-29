import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";

import { findAvailableServerPort } from "../lib/servers/nginx";
import { edgeServedRemote } from "../lib/servers/nginx";
import { summarizeStartupFailure } from "../lib/tunnel";

function portOf(server: ReturnType<typeof createServer>): number {
  const addr = server.address();
  return typeof addr === "object" && addr !== null ? addr.port : -1;
}

describe("summarizeStartupFailure", () => {
  test("names an nginx emerg line over generic log noise", () => {
    const log = [
      "Starting ngrok tunnel to localhost:7840...",
      "nginx: [emerg] bind() to 0.0.0.0:7840 failed (98: Address already in use)",
    ].join("\n");
    expect(summarizeStartupFailure(log)).toContain("[emerg]");
  });

  test("names an ngrok error code", () => {
    expect(
      summarizeStartupFailure(
        "agent started\nERR_NGROK_4018: Authentication failed",
      ),
    ).toContain("ERR_NGROK_4018");
  });

  test("the last matching line wins", () => {
    const log = [
      "nginx: [emerg] bind() to 0.0.0.0:7840 failed (98: Address already in use)",
      "nginx: [emerg] bind() to 0.0.0.0:7841 failed (98: Address already in use)",
    ].join("\n");
    expect(summarizeStartupFailure(log)).toContain(":7841");
  });

  test("falls back to the last non-empty line when nothing error-shaped appears", () => {
    expect(summarizeStartupFailure("first line\nsome plain output")).toBe(
      "some plain output",
    );
  });

  test("an empty log summarizes to null", () => {
    expect(summarizeStartupFailure("")).toBeNull();
    expect(summarizeStartupFailure("\n  \n")).toBeNull();
  });

  test("long lines are capped", () => {
    const long = `nginx: [emerg] ${"x".repeat(400)}`;
    const summary = summarizeStartupFailure(long) ?? "";
    expect(summary.length).toBeLessThanOrEqual(201);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("findAvailableServerPort", () => {
  test("skips a port a foreign listener already holds", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const occupied = portOf(blocker);
    try {
      const port = await findAvailableServerPort(occupied);
      expect(port).toBe(occupied + 1);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test("returns null when the whole band is busy", async () => {
    const scout = createServer();
    await new Promise<void>((resolve) => scout.listen(0, "127.0.0.1", resolve));
    const base = portOf(scout);
    await new Promise<void>((resolve) => scout.close(() => resolve()));
    // Hold both ports of a 2-port band with fresh listeners.
    const first = createServer();
    const second = createServer();
    await new Promise<void>((resolve) =>
      first.listen(base, "127.0.0.1", resolve),
    );
    await new Promise<void>((resolve) =>
      second.listen(base + 1, "127.0.0.1", resolve),
    );
    try {
      expect(await findAvailableServerPort(base, 2)).toBeNull();
    } finally {
      await new Promise<void>((resolve) => first.close(() => resolve()));
      await new Promise<void>((resolve) => second.close(() => resolve()));
    }
  });
});

describe("edgeServedRemote", () => {
  test("a docker cadet is stamped truthfully", () => {
    expect(edgeServedRemote("docker")).toBe("docker");
  });

  test("a custom cadet keeps its kind", () => {
    expect(edgeServedRemote("custom")).toBe("custom");
  });

  test("local, paired, cloud, and unknown entries read as custom so the remote-gateway machinery always runs", () => {
    expect(edgeServedRemote("local")).toBe("custom");
    expect(edgeServedRemote("paired")).toBe("custom");
    expect(edgeServedRemote("cloud")).toBe("custom");
    expect(edgeServedRemote(undefined)).toBe("custom");
  });
});
