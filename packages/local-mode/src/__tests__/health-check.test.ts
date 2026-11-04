import { describe, test, expect } from "bun:test";
import { checkHealth } from "../daemon-readiness";
import type { LockfileAssistant } from "../lockfile-contract";

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
  test("reads as down for a non-existent host", async () => {
    const result = await checkHealth(localEntry(1));
    expect(result.version).toBeUndefined();
    expect(result.status).toBe("unreachable");
  });

  test("reads a serving gateway's version and verdict", async () => {
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
      expect(result.version).toBe("0.9.0");
    } finally {
      server.stop(true);
    }
  });

  test("reads as down for a malformed health body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        // A schema-rejecting body: an empty version fails the wire schema
        // exactly like a non-JSON answer does.
        return Response.json({ status: "healthy", version: "" });
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

  test("reads as down for a non-ok health response", async () => {
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
