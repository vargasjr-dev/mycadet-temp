import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkHealth } from "../daemon-readiness";
import { saveBasetenSandboxToken } from "../guardian-token";
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

describe("checkHealth — the baseten gateway doors", () => {
  test("a minted preview is the door: the probe rides it with the preview token", async () => {
    const seen = { path: "", preview: null as string | null, auth: null as string | null };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.path = new URL(req.url).pathname;
        seen.preview = req.headers.get("x-blaxel-preview-token");
        seen.auth = req.headers.get("authorization");
        return Response.json({ status: "healthy", version: "1.2.3" });
      },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-health-prev-"));
    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    saveBasetenSandboxToken("asst-baseten", "sbx-tok-1", "preview-tok-1");
    try {
      const entry = {
        assistantId: "asst-baseten",
        cloud: "baseten",
        name: "sbx-x",
        sandboxUrl: "https://sbx-x.b10.co",
        previewUrl: `http://127.0.0.1:${server.port}`,
        port: 7830,
      } as LockfileAssistant;
      const result = await checkHealth(entry);
      expect(result.status).toBe("healthy");
      expect(seen.path).toBe("/healthz");
      expect(seen.preview).toBe("preview-tok-1");
      // Authorization carries nothing — the gateway's own bearer flows
      // through the edge untouched.
      expect(seen.auth).toBe(null);
    } finally {
      server.stop(true);
      if (oldXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = oldXdg;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the probe rides the gateway URL presenting the preview token", async () => {
    const seen = { url: "", preview: null as string | null };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.url = req.url;
        seen.preview = req.headers.get("x-blaxel-preview-token");
        return Response.json({ status: "healthy", version: "1.2.3" });
      },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-health-sbx-"));
    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    saveBasetenSandboxToken("asst-baseten", "sbx-tok-1", "prev-tok-1");
    try {
      // The preview IS the door: the probe rides the recorded preview URL.
      const entry = {
        assistantId: "asst-baseten",
        cloud: "baseten",
        name: "sbx-x",
        sandboxUrl: "http://sandbox.example.test",
        previewUrl: `http://127.0.0.1:${server.port}`,
        port: 7830,
      } as LockfileAssistant;
      const result = await checkHealth(entry);
      expect(result.status).toBe("healthy");
      expect(result.version).toBe("1.2.3");
      expect(seen.preview).toBe("prev-tok-1");
    } finally {
      server.stop(true);
      if (oldXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = oldXdg;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a missing preview token still probes (bare) instead of throwing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-health-sbx-"));
    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    try {
      const result = await checkHealth({
        assistantId: "asst-notoken",
        cloud: "baseten",
        name: "sbx-x",
        sandboxUrl: "http://127.0.0.1:1",
        previewUrl: "http://127.0.0.1:1",
        port: 7830,
      } as LockfileAssistant);
      expect(result.status).toBe("unreachable");
    } finally {
      if (oldXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = oldXdg;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

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
