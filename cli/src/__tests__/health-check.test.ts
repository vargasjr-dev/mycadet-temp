import { describe, test, expect } from "bun:test";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import { checkHealth, HEALTH_CHECK_TIMEOUT_MS } from "../lib/health-check.js";

// The probe is entry-based: a local entry's gateway address is the loopback
// port the test server binds.
function localEntry(port: number | undefined): LockfileAssistant {
  return {
    assistantId: "asst-health",
    cloud: "local",
    port: port ?? 0,
  } as LockfileAssistant;
}

describe("checkHealth", () => {
  test("HEALTH_CHECK_TIMEOUT_MS is a positive number", () => {
    expect(typeof HEALTH_CHECK_TIMEOUT_MS).toBe("number");
    expect(HEALTH_CHECK_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("returns unreachable for non-existent host", async () => {
    const result = await checkHealth(localEntry(1));
    expect(["unreachable", "timeout"]).toContain(result.status);
    expect(result.version).toBeUndefined();
  });

  test("returns healthy for a serving gateway", async () => {
    // The detailed /healthz body always carries the version while the
    // runtime is up — a body without one reads as down.
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ status: "healthy", version: "1.2.3" });
      },
    });

    try {
      const result = await checkHealth(localEntry(server.port));
      expect(result.status).toBe("healthy");
      expect(result.detail).toBeNull();
      expect(result.version).toBe("1.2.3");
    } finally {
      server.stop(true);
    }
  });

  test("surfaces the runtime's own verdict when it is not healthy", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          status: "degraded",
          version: "0.9.0",
        });
      },
    });

    try {
      const result = await checkHealth(localEntry(server.port));
      expect(result.status).toBe("degraded");
      expect(result.detail).toBeNull();
      expect(result.version).toBe("0.9.0");
    } finally {
      server.stop(true);
    }
  });

  test("returns unreachable for a non-ok health response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    try {
      const result = await checkHealth(localEntry(server.port));
      expect(result.status).toBe("unreachable");
      expect(result.version).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});
