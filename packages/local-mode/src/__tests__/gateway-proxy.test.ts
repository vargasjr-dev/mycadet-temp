import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
      legacy: false,
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
      legacy: false,
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
      legacy: false,
      target: { assistantId: "abc-123", path: "/readyz", search: "" },
    });
  });

  test("preserves the query and drops the fragment on the scoped surface", () => {
    expect(
      parseAssistantGatewayUrl("/v1/assistants/abc-123/messages?x=1#frag"),
    ).toEqual({
      match: true,
      valid: true,
      legacy: false,
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
      legacy: false,
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
      legacy: false,
      target: {
        assistantId: "abc-123",
        path: "/v1/contact-channels/y",
        search: "?z=1",
      },
    });
  });

  test("parses the legacy unscoped prefix and forwards the tail", () => {
    expect(parseAssistantGatewayUrl("/__gateway/abc-123/auth/token")).toEqual({
      match: true,
      valid: true,
      legacy: true,
      target: { assistantId: "abc-123", path: "/auth/token", search: "" },
    });
    expect(
      parseAssistantGatewayUrl("/assistant/__gateway/abc-123/readyz"),
    ).toEqual({
      match: true,
      valid: true,
      legacy: true,
      target: { assistantId: "abc-123", path: "/readyz", search: "" },
    });
  });

  test("rejects dot segments on both shapes (raw and percent-encoded)", () => {
    expect(parseAssistantGatewayUrl("/v1/assistants/../secret")).toMatchObject({
      match: true,
      valid: false,
    });
    expect(
      parseAssistantGatewayUrl("/v1/assistants/abc/%2e%2e/secret"),
    ).toMatchObject({ match: true, valid: false });
    expect(parseAssistantGatewayUrl("/__gateway/abc/../secret")).toMatchObject({
      match: true,
      valid: false,
    });
  });

  test("rejects malformed percent-encoding as an invalid parse", () => {
    expect(parseAssistantGatewayUrl("/v1/assistants/%zz/x")).toEqual({
      match: true,
      valid: false,
    });
    expect(parseAssistantGatewayUrl("/__gateway/%zz/v1")).toEqual({
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

  test("forwards the legacy prefix for unscoped gateway routes", () => {
    expect(
      resolveGatewayProxyTarget("/__gateway/abc-123/auth/token", entry),
    ).toEqual({
      kind: "forward",
      assistantId: "abc-123",
      path: "/auth/token",
      search: "",
      target: loopback(8080),
    });
  });

  test("rejects an unknown id on the legacy prefix", () => {
    expect(resolveGatewayProxyTarget("/__gateway/zzz-999/v1", entry)).toEqual(
      rejection,
    );
    expect(
      resolveGatewayProxyTarget("/__gateway/abc/../secret", entry),
    ).toEqual(rejection);
  });
});

describe("gatewayTargetsFromLockfile", () => {
  test("resolves a paired entry with a usable runtimeUrl to a remote target", () => {
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          {
            assistantId: "abc-123",
            paired: true,
            runtimeUrl: "https://gw.example.com",
          },
        ],
      }),
    ).toEqual(targets({ "abc-123": remote("https://gw.example.com") })());
  });

  test("omits a paired entry whose runtimeUrl is unusable", () => {
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          { assistantId: "abc-123", paired: true, runtimeUrl: "not a url" },
          { assistantId: "def-456", paired: true },
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

  test("resolves a docker entry's loopback runtimeUrl (no resources block)", () => {
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          {
            assistantId: "abc-123",
            cloud: "docker",
            runtimeUrl: "http://127.0.0.1:9000",
          },
        ],
      }),
    ).toEqual(new Map([["abc-123", loopback(9000)]]));
  });

  test("resolves a loopback-cloud entry whose runtimeUrl is remote as paired", () => {
    // Paired-ness derives from the addressing (no stored flag): a
    // loopback-gateway cloud whose runtimeUrl points off-machine is a
    // connect import, so it targets that remote runtimeUrl.
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          {
            assistantId: "abc-123",
            cloud: "local",
            runtimeUrl: "https://elsewhere.example.com",
          },
        ],
      }),
    ).toEqual(
      new Map([
        [
          "abc-123",
          { kind: "remote", runtimeUrl: "https://elsewhere.example.com" },
        ],
      ]),
    );
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
            runtimeUrl: "http://127.0.0.1:70000",
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
          { assistantId: "b", cloud: "apple-container" },
          // A retired spelling parses as "local": loopback-gated, and with no
          // loopback port it is omitted.
          { assistantId: "d", cloud: "gcp" },
        ],
      }),
    ).toEqual(new Map());
  });

  test("a custom entry's off-machine runtimeUrl is targetable by addressing", () => {
    // Targeting keys on the addressing alone: an entry whose runtimeUrl
    // points off this machine resolves as remote, whatever its cloud says.
    expect(
      gatewayTargetsFromLockfile({
        assistants: [
          {
            assistantId: "c",
            cloud: "custom",
            runtimeUrl: "https://gw.example.com",
          },
        ],
      }),
    ).toEqual(
      new Map([
        ["c", { kind: "remote", runtimeUrl: "https://gw.example.com" }],
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
  test("reads the id-keyed target map from disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-proxy-"));
    const lockfile = path.join(dir, "lockfile.json");
    fs.writeFileSync(
      lockfile,
      JSON.stringify({
        assistants: [
          {
            assistantId: "abc-123",
            cloud: "local",
            resources: { gatewayPort: 8080, daemonPort: 8501 },
          },
          {
            assistantId: "def-456",
            paired: true,
            runtimeUrl: "https://gw.example.com",
          },
        ],
      }),
    );
    expect(readGatewayTargets([lockfile])).toEqual(
      targets({
        "abc-123": loopback(8080),
        "def-456": remote("https://gw.example.com"),
      })(),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the first readable lockfile is authoritative even when it yields no targets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-proxy-"));
    const first = path.join(dir, "first.json");
    const second = path.join(dir, "second.json");
    fs.writeFileSync(first, JSON.stringify({ assistants: [] }));
    fs.writeFileSync(
      second,
      JSON.stringify({
        assistants: [
          {
            assistantId: "abc-123",
            cloud: "local",
            resources: { gatewayPort: 8080, daemonPort: 8501 },
          },
        ],
      }),
    );
    expect(readGatewayTargets([first, second])).toEqual(new Map());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("unreadable and missing candidates are skipped, absent files yield an empty map", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-proxy-"));
    const unreadable = path.join(dir, "unreadable.json");
    const good = path.join(dir, "good.json");
    fs.writeFileSync(unreadable, "{ not json");
    fs.writeFileSync(
      good,
      JSON.stringify({
        assistants: [
          {
            assistantId: "abc-123",
            cloud: "local",
            resources: { gatewayPort: 8080, daemonPort: 8501 },
          },
        ],
      }),
    );
    expect(readGatewayTargets([unreadable, good])).toEqual(
      targets({ "abc-123": loopback(8080) })(),
    );
    expect(readGatewayTargets([path.join(dir, "absent.json")])).toEqual(
      new Map(),
    );
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
