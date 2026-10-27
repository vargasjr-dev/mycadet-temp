import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GATEWAY_PORT } from "../lockfile-contract";
import {
  authorizePairedForwardHeaders,
  gatewayTargetsFromLockfile,
  parseAssistantGatewayUrl,
  readGatewayTargets,
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

const targets =
  (
    map: Record<
      string,
      | { kind: "loopback"; port: number }
      | { kind: "remote"; runtimeUrl: string }
    >,
  ) =>
  () =>
    new Map(Object.entries(map));

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
  const entry = targets({
    "abc-123": loopback(8080),
    "def-456": remote("https://gw.example.com"),
  });

  test("passes non-gateway paths through untouched", () => {
    expect(resolveGatewayProxyTarget("/index.html", entry)).toEqual({
      kind: "pass",
    });
    expect(
      resolveGatewayProxyTarget("/assistant/assets/app.js", targets({})),
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
      resolveGatewayProxyTarget("/v1/assistants/zzz-999/x", targets({})),
    ).toEqual({ kind: "pass" });
  });
});

describe("gatewayTargetsFromLockfile", () => {
  test("resolves a paired entry's custom addressing to a remote target", () => {
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          {
            assistantId: "abc-123",
            cloud: "custom",
            ipAddress: "gw.example.com",
            port: 443,
          },
        ],
      }),
    ).toEqual(targets({ "abc-123": remote("https://gw.example.com") })());
  });

  test("omits loopback entries with no recorded port beyond the default's loopback form", () => {
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          { assistantId: "abc-123", cloud: "custom" },
          { assistantId: "def-456", cloud: "cloud" },
        ],
      }),
    ).toEqual(new Map());
  });

  test("resolves a local entry's recorded gatewayPort to a loopback target", () => {
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          {
            assistantId: "abc-123",
            cloud: "local",
            resources: { gatewayPort: 8080, daemonPort: 8501 },
          },
        ],
      }),
    ).toEqual(targets({ "abc-123": loopback(8080) })());
  });

  test("a docker entry without a recorded port derives the default gateway port", () => {
    expect(
      gatewayTargetsFromLockfile({
        assistants: [{ assistantId: "abc-123", cloud: "docker" }],
      }),
    ).toEqual(new Map([["abc-123", loopback(GATEWAY_PORT)]]));
  });

  test("omits ports outside the 1024-65535 proxy range", () => {
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          {
            assistantId: "abc-123",
            cloud: "local",
            resources: { gatewayPort: 80, daemonPort: 8501 },
          },
          {
            assistantId: "def-456",
            cloud: "docker",
            resources: { gatewayPort: 70000 },
          },
        ],
      }),
    ).toEqual(new Map());
  });

  test("omits clouds the SPA does not drive over this proxy", () => {
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          { assistantId: "a", cloud: "cloud" },
          // A retired spelling parses as "local": loopback-gated, so it
          // derives the default loopback port rather than being omitted.
          { assistantId: "b", cloud: "gcp" },
        ],
      }),
    ).toEqual(new Map([["b", { kind: "loopback", port: GATEWAY_PORT }]]));
  });

  test("a custom entry's recorded addressing is targetable", () => {
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          {
            assistantId: "c",
            cloud: "custom",
            ipAddress: "gw.example.com",
            port: 7831,
          },
        ],
      }),
    ).toEqual(
      new Map([
        ["c", { kind: "remote", runtimeUrl: "https://gw.example.com:7831" }],
      ]),
    );
  });

  test("tolerates malformed entries", () => {
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          null,
          42,
          { noId: true },
          { assistantId: "", paired: true },
          {
            assistantId: "abc-123",
            cloud: "local",
            resources: { gatewayPort: 8080, daemonPort: 8501 },
          },
        ],
      }),
    ).toEqual(targets({ "abc-123": loopback(8080) })());
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
              resources: { gatewayPort: 8080, daemonPort: 8501 },
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
      targets({
        "abc-123": loopback(8080),
        "def-456": remote("https://gw.example.com"),
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
      "https://gw.example.com",
      headers,
      async (assistantId, runtimeUrl) => {
        expect(assistantId).toBe("abc-123");
        expect(runtimeUrl).toBe("https://gw.example.com");
        return { ok: true, accessToken: "host-token" };
      },
    );
    expect(result).toEqual({ ok: true });
    expect(headers.get("authorization")).toBe("Bearer host-token");
  });
});
