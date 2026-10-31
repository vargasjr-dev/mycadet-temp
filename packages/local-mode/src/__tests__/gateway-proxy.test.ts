import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GATEWAY_PORT,
  LockfileAssistantSchema,
  type LockfileAssistant,
} from "../lockfile-contract";
import {
  authorizePairedForwardHeaders,
  parseAssistantGatewayUrl,
  readGatewayTargets,
  resolveAssistantRetireProxyDecision,
  resolveGatewayProxyTarget,
  sanitizePairedForwardHeaders,
} from "../gateway-proxy";

const rejection = {
  kind: "reject",
  status: 403,
  message: "Assistant is not active in lockfile",
} as const;

const loopback = (port: number) => ({ kind: "loopback", port }) as const;
const remote = (runtimeUrl: string) =>
  ({ kind: "remote", runtimeUrl }) as const;

const entries = (map: Record<string, unknown>) => () =>
  new Map(
    Object.entries(map).map(
      ([id, raw]) => [id, LockfileAssistantSchema.parse(raw)] as const,
    ),
  );

describe("parseAssistantGatewayUrl", () => {
  test("parses the scoped SDK surface and forwards the full path", () => {
    expect(parseAssistantGatewayUrl("/v1/assistants/abc-123")).toEqual({
      match: true,
      valid: true,
      target: {
        assistantId: "abc-123",
        path: "/v1/assistants/abc-123",
        search: "",
      },
    });
    expect(
      parseAssistantGatewayUrl("/v1/assistants/abc-123/conversations"),
    ).toEqual({
      match: true,
      valid: true,
      target: {
        assistantId: "abc-123",
        path: "/v1/assistants/abc-123/conversations",
        search: "",
      },
    });
  });

  test("forwards the scoped readyz tail to the gateway's root probe", () => {
    expect(parseAssistantGatewayUrl("/v1/assistants/abc-123/readyz")).toEqual({
      match: true,
      valid: true,
      target: { assistantId: "abc-123", path: "/readyz", search: "" },
    });
  });

  test("preserves the query and drops the fragment on the scoped surface", () => {
    expect(
      parseAssistantGatewayUrl("/v1/assistants/abc-123/messages?x=1#frag"),
    ).toEqual({
      match: true,
      valid: true,
      target: {
        assistantId: "abc-123",
        path: "/v1/assistants/abc-123/messages",
        search: "?x=1",
      },
    });
  });

  test("flattens the contact family to the gateway's flat routes", () => {
    expect(
      parseAssistantGatewayUrl("/v1/assistants/abc-123/contacts/x"),
    ).toEqual({
      match: true,
      valid: true,
      target: {
        assistantId: "abc-123",
        path: "/v1/contacts/x",
        search: "",
      },
    });
    expect(
      parseAssistantGatewayUrl("/v1/assistants/abc-123/contact-channels/y?z=1"),
    ).toEqual({
      match: true,
      valid: true,
      target: {
        assistantId: "abc-123",
        path: "/v1/contact-channels/y",
        search: "?z=1",
      },
    });
  });

  test("rejects dot segments (raw and percent-encoded)", () => {
    expect(parseAssistantGatewayUrl("/v1/assistants/../secret")).toMatchObject({
      match: true,
      valid: false,
    });
    expect(
      parseAssistantGatewayUrl("/v1/assistants/abc/%2e%2e/secret"),
    ).toMatchObject({ match: true, valid: false });
  });

  test("rejects malformed percent-encoding as an invalid parse", () => {
    expect(parseAssistantGatewayUrl("/v1/assistants/%zz/x")).toEqual({
      match: true,
      valid: false,
    });
  });

  test("does not match unrelated paths", () => {
    expect(parseAssistantGatewayUrl("/index.html").match).toBe(false);
    expect(parseAssistantGatewayUrl("/assistant/assets/app.js").match).toBe(
      false,
    );
  });
});

describe("resolveGatewayProxyTarget", () => {
  const entry = entries({
    "abc-123": {
      assistantId: "abc-123",
      cloud: "local",
      port: 8080,
      daemonPort: 8501,
    },
    "def-456": {
      assistantId: "def-456",
      cloud: "custom",
      ipAddress: "gw.example.com",
      port: 443,
    },
  });

  test("passes non-gateway paths through untouched", () => {
    expect(resolveGatewayProxyTarget("/index.html", entry)).toEqual({
      kind: "pass",
    });
    expect(
      resolveGatewayProxyTarget("/assistant/assets/app.js", entries({})),
    ).toEqual({ kind: "pass" });
  });

  test("forwards a scoped path for an active loopback id to its port", () => {
    expect(
      resolveGatewayProxyTarget("/v1/assistants/abc-123/conversations", entry),
    ).toEqual({
      kind: "forward",
      assistantId: "abc-123",
      path: "/v1/assistants/abc-123/conversations",
      search: "",
      target: loopback(8080),
    });
  });
  test("forwards a scoped path for an imported pairing to its runtimeUrl", () => {
    expect(
      resolveGatewayProxyTarget("/v1/assistants/def-456/messages?x=1", entry),
    ).toEqual({
      kind: "forward",
      assistantId: "def-456",
      path: "/v1/assistants/def-456/messages",
      search: "?x=1",
      target: remote("https://gw.example.com"),
    });
  });

  test("flattens the contact family in the forward path", () => {
    expect(
      resolveGatewayProxyTarget("/v1/assistants/abc-123/contacts/x", entry),
    ).toEqual({
      kind: "forward",
      assistantId: "abc-123",
      path: "/v1/contacts/x",
      search: "",
      target: loopback(8080),
    });
  });

  test("passes an unknown id on the scoped surface through", () => {
    // Cloud assistants and stale ids ride the host's generic /v1 handling.
    expect(
      resolveGatewayProxyTarget("/v1/assistants/zzz-999/messages", entry),
    ).toEqual({ kind: "pass" });
    expect(
      resolveGatewayProxyTarget("/v1/assistants/zzz-999/x", entries({})),
    ).toEqual({ kind: "pass" });
  });
});

describe("gateway target derivation", () => {
  const forwardTarget = (id: string, raw: unknown) =>
    resolveGatewayProxyTarget(`/v1/assistants/${id}/x`, entries({ [id]: raw }))
      .kind === "forward"
      ? (
          resolveGatewayProxyTarget(
            `/v1/assistants/${id}/x`,
            entries({ [id]: raw }),
          ) as { target: unknown }
        ).target
      : undefined;

  test("resolves a paired entry's custom addressing to a remote target", () => {
    expect(
      forwardTarget("abc-123", {
        assistantId: "abc-123",
        cloud: "custom",
        ipAddress: "gw.example.com",
        port: 443,
      }),
    ).toEqual(remote("https://gw.example.com"));
  });

  test("a custom entry pointing at loopback is not targetable", () => {
    expect(
      resolveGatewayProxyTarget(
        "/v1/assistants/abc-123/x",
        entries({
          "abc-123": {
            assistantId: "abc-123",
            cloud: "custom",
            ipAddress: "127.0.0.1",
            port: 443,
          },
        }),
      ),
    ).toEqual({ kind: "pass" });
  });

  test("resolves a local entry's recorded gatewayPort to a loopback target", () => {
    expect(
      forwardTarget("abc-123", {
        assistantId: "abc-123",
        cloud: "local",
        port: 8080,
        daemonPort: 8501,
      }),
    ).toEqual(loopback(8080));
  });

  test("a docker entry without a recorded port derives the default gateway port", () => {
    expect(
      forwardTarget("abc-123", {
        assistantId: "abc-123",
        cloud: "docker",
      }),
    ).toEqual(loopback(GATEWAY_PORT));
  });

  test("ports outside the 1024-65535 proxy range are not targetable", () => {
    for (const port of [80, 70000]) {
      expect(
        resolveGatewayProxyTarget(
          "/v1/assistants/abc-123/x",
          entries({
            "abc-123": {
              assistantId: "abc-123",
              cloud: "local",
              port,
              daemonPort: 8501,
            },
          }),
        ),
      ).toEqual({ kind: "pass" });
    }
  });

  test("omits clouds the SPA does not drive over this proxy", () => {
    expect(
      resolveGatewayProxyTarget(
        "/v1/assistants/a/x",
        entries({ a: { assistantId: "a", cloud: "cloud" } }),
      ),
    ).toEqual({ kind: "pass" });
  });

  test("a baseten entry resolves to a remote target on the sandbox /port/ route", () => {
    expect(
      forwardTarget("sbx-1", {
        assistantId: "sbx-1",
        cloud: "baseten",
        sandboxUrl: "https://sbx-name-abc123.us-pdx-1.b10.co",
        port: 7830,
      }),
    ).toEqual(remote("https://sbx-name-abc123.us-pdx-1.b10.co/port/7830"));
  });
});

describe("readGatewayTargets", () => {
  // The reader resolves its path from the environment; a per-test XDG home
  // points it at the fixture's cadet dir.
  const withAmbientLockfile = (
    write: (lockfilePath: string) => void,
  ): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-proxy-"));
    process.env.XDG_CONFIG_HOME = dir;
    const lockfilePath = path.join(dir, "cadet", "lockfile.json");
    fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
    write(lockfilePath);
    return dir;
  };

  test("reads the id-keyed target map from disk", () => {
    const dir = withAmbientLockfile((lockfilePath) =>
      fs.writeFileSync(
        lockfilePath,
        JSON.stringify({
          assistants: [
            {
              assistantId: "abc-123",
              cloud: "local",
              port: 8080,
              daemonPort: 8501,
            },
            {
              assistantId: "def-456",
              cloud: "custom",
              ipAddress: "gw.example.com",
              port: 443,
            },
          ],
        }),
      ),
    );
    expect(readGatewayTargets()).toEqual(
      entries({
        "abc-123": {
          assistantId: "abc-123",
          cloud: "local",
          port: 8080,
          daemonPort: 8501,
        },
        "def-456": {
          assistantId: "def-456",
          cloud: "custom",
          ipAddress: "gw.example.com",
          port: 443,
        },
      })(),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an empty lockfile yields an empty map", () => {
    const dir = withAmbientLockfile((lockfilePath) =>
      fs.writeFileSync(lockfilePath, JSON.stringify({ assistants: [] })),
    );
    expect(readGatewayTargets()).toEqual(new Map());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("malformed entries are skipped, not fatal", () => {
    const dir = withAmbientLockfile((lockfilePath) =>
      fs.writeFileSync(
        lockfilePath,
        JSON.stringify({
          assistants: [
            null,
            42,
            { noId: true },
            { assistantId: "", cloud: "local", port: 8080, daemonPort: 8501 },
            {
              assistantId: "abc-123",
              cloud: "local",
              port: 8080,
              daemonPort: 8501,
            },
          ],
        }),
      ),
    );
    expect(readGatewayTargets().size).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an unreadable or absent lockfile yields an empty map", () => {
    const dir = withAmbientLockfile((lockfilePath) =>
      fs.writeFileSync(lockfilePath, "{ not json"),
    );
    expect(readGatewayTargets()).toEqual(new Map());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("remote-forward header handling", () => {
  test("sanitizePairedForwardHeaders strips renderer and browser-ambient headers", () => {
    const headers = new Headers({
      authorization: "Bearer renderer",
      cookie: "session=1",
      origin: "https://app.example.com",
      referer: "https://app.example.com/x",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    });
    sanitizePairedForwardHeaders(headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("origin")).toBeNull();
    expect(headers.get("referer")).toBeNull();
    expect(headers.get("sec-fetch-site")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("ngrok-skip-browser-warning")).toBe("true");
  });

  test("authorizePairedForwardHeaders installs the host's guardian bearer", async () => {
    const headers = new Headers({ authorization: "Bearer renderer" });
    const result = await authorizePairedForwardHeaders(
      "abc-123",
      headers,
      async (assistantId) => {
        expect(assistantId).toBe("abc-123");
        return { ok: true, accessToken: "host-token" };
      },
    );
    expect(result).toEqual({ ok: true });
    expect(headers.get("authorization")).toBe("Bearer host-token");
  });
});

describe("resolveAssistantRetireProxyDecision", () => {
  const noLockfile = () => null as never;
  const withEntries =
    (...entries: unknown[]) =>
    () => ({ assistants: entries });

  const localEntry = { assistantId: "asst-local", cloud: "local", port: 7830 };
  const dockerEntry = {
    assistantId: "asst-docker",
    cloud: "docker",
    port: 7831,
  };
  const appleEntry = {
    assistantId: "asst-apple",
    cloud: "apple-container",
    mgmtSocket: "/tmp/mgmt.sock",
  };
  const cloudEntry = {
    assistantId: "asst-cloud",
    cloud: "cloud",
  };
  const pairedEntry = {
    assistantId: "asst-paired",
    cloud: "custom",
    runtimeUrl: "https://gw.example.com",
  };

  test("non-DELETE methods pass without consulting the lockfile", () => {
    expect(
      resolveAssistantRetireProxyDecision(
        "/v1/assistants/asst-local/retire/",
        "POST",
        withEntries(localEntry),
      ),
    ).toEqual({ kind: "pass" });
    // The thunk is never called for a bail, so null proves the point.
    expect(
      resolveAssistantRetireProxyDecision(
        "/v1/assistants/asst-local/retire/",
        "GET",
        noLockfile,
      ),
    ).toEqual({ kind: "pass" });
  });

  test("non-retire paths pass without consulting the lockfile", () => {
    expect(
      resolveAssistantRetireProxyDecision(
        "/v1/assistants/asst-local/conversations",
        "DELETE",
        noLockfile,
      ),
    ).toEqual({ kind: "pass" });
  });

  test("a host-retirable entry resolves to retireLocal", () => {
    expect(
      resolveAssistantRetireProxyDecision(
        "/v1/assistants/asst-local/retire/",
        "DELETE",
        withEntries(localEntry),
      ),
    ).toEqual({ kind: "retireLocal", assistantId: "asst-local" });
    expect(
      resolveAssistantRetireProxyDecision(
        "/v1/assistants/asst-docker/retire/",
        "DELETE",
        withEntries(dockerEntry),
      ),
    ).toEqual({ kind: "retireLocal", assistantId: "asst-docker" });
    expect(
      resolveAssistantRetireProxyDecision(
        "/v1/assistants/asst-apple/retire/",
        "DELETE",
        withEntries(appleEntry),
      ),
    ).toEqual({ kind: "retireLocal", assistantId: "asst-apple" });
  });

  test("cloud and paired entries pass through to the endpoint's forward", () => {
    expect(
      resolveAssistantRetireProxyDecision(
        "/v1/assistants/asst-cloud/retire/",
        "DELETE",
        withEntries(cloudEntry),
      ),
    ).toEqual({ kind: "pass" });
    expect(
      resolveAssistantRetireProxyDecision(
        "/v1/assistants/asst-paired/retire/",
        "DELETE",
        withEntries(pairedEntry),
      ),
    ).toEqual({ kind: "pass" });
  });

  test("an id the lockfile does not know passes", () => {
    expect(
      resolveAssistantRetireProxyDecision(
        "/v1/assistants/ghost/retire/",
        "DELETE",
        withEntries(localEntry),
      ),
    ).toEqual({ kind: "pass" });
  });
});
