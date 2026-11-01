import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real assistant-config reads the lockfile from XDG_CONFIG_HOME. Pin the
// environment too: the lockfile filename is environment-dependent, and a dev
// machine's persisted default environment would otherwise redirect the lookup.
const testDir = mkdtempSync(join(tmpdir(), "pair-command-test-"));
process.env.XDG_CONFIG_HOME = testDir;
const originalEnvironment = process.env.CADET_ENVIRONMENT;
process.env.CADET_ENVIRONMENT = "production";

import { withPreconnect } from "./helpers/http.js";

// The gateway-CLI mint runs in a SUBPROCESS for local and docker assistants;
// answer it in-process and record the invocations (the fetch stubs below
// still serve the loopback HTTP mint the other topologies keep using).
const mintCalls: Array<{ command: string; args: readonly string[] }> = [];
// The gateway CLI self-sources its advertised url from its own workspace
// config, so the mint carries no url argument; the mock echoes the base the
// test seeded there.
let mintReplyBase = "";
const actualStepRunner = await import("../lib/step-runner.js");
const mockExecOutput = mock(
  (command: string, args: readonly string[]): Promise<string> => {
    mintCalls.push({ command, args });
    return Promise.resolve(
      JSON.stringify({
        deviceCode: "device-code",
        userCode: "ABCD-EFGH",
        verificationUri: `${mintReplyBase}/assistant/pair`,
        publicBaseUrl: mintReplyBase,
        expiresAt: "2026-06-04T00:10:00.000Z",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      }),
    );
  },
);
mock.module("../lib/step-runner.js", () => ({
  ...actualStepRunner,
  execOutput: mockExecOutput,
}));

// The cloud-home arms (cloud/custom/baseten) mint through the platform's
// terminal-session exec API instead of a local subprocess; answer it
// in-process so the custom-pairing test never touches the network.
const actualTerminalSession = await import("../lib/terminal-session.js");
const execViaTerminalSessionMock = mock(
  async (
    _assistant: unknown,
    _command: string[],
  ): Promise<{ output: string; exitCode: number }> => ({
    output: "",
    exitCode: 0,
  }),
);
mock.module("../lib/terminal-session.js", () => ({
  ...actualTerminalSession,
  execViaTerminalSession: execViaTerminalSessionMock,
}));

const { buildAppConnectUrl, pair } = await import("../commands/pair.js");

// Distinct loopback (mint) vs reachable (advertised) URLs to verify the split.
const LOCAL_URL = "http://127.0.0.1:7830";
const RUNTIME_URL = "http://192.168.1.50:7830";
const PUBLIC_URL = "https://pair.example.ts.net";

function challengeResponse(baseUrl = PUBLIC_URL): Response {
  return new Response(
    JSON.stringify({
      deviceCode: "device-code",
      userCode: "ABCD-EFGH",
      verificationUri: `${baseUrl}/assistant/pair`,
      expiresAt: "2026-06-04T00:10:00.000Z",
      expiresInSeconds: 600,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function approvalResponse(baseUrl = PUBLIC_URL): Response {
  return new Response(
    JSON.stringify({
      status: "approved",
      verificationUri: `${baseUrl}/assistant/pair`,
      expiresAt: "2026-06-04T00:10:00.000Z",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Answer the challenge + verification pair minted over loopback. */
function stubPairingGateway(
  calls: Array<[string, RequestInit | undefined]>,
  baseUrl = PUBLIC_URL,
): void {
  globalThis.fetch = withPreconnect(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push([url, init]);
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-challenge`) {
        return challengeResponse(baseUrl);
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-verification`) {
        return approvalResponse(baseUrl);
      }
      return new Response("not found", { status: 404 });
    },
  );
}

const INSTANCE_DIR = join(testDir, "instance");

function writeLockfile(): void {
  mkdirSync(join(testDir, "cadet"), { recursive: true });
  writeFileSync(
    join(testDir, "cadet", "lockfile.json"),
    JSON.stringify({
      assistants: [
        {
          assistantId: "pair-test",
          runtimeUrl: RUNTIME_URL,
          cloud: "local",
          resources: {
            instanceDir: INSTANCE_DIR,
            gatewayPort: 7830,
            daemonPort: 8501,
          },
        },
      ],
      activeAssistant: "pair-test",
    }),
  );
}

// Capture the real argv ONCE, before any test mutates it, and restore after
// every test — so a `['bun','cadet','pair',...]` argv can't leak into other
// test files in the same Bun run.
const ORIGINAL_ARGV = [...process.argv];

describe("pair command", () => {
  beforeEach(() => {
    mintCalls.length = 0;
    mintReplyBase = PUBLIC_URL;
    writeLockfile();
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
    if (originalEnvironment === undefined) {
      delete process.env.CADET_ENVIRONMENT;
    } else {
      process.env.CADET_ENVIRONMENT = originalEnvironment;
    }
  });

  test("mints a challenge, approves it locally, and prints the link plus a QR", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    stubPairingGateway(calls);

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = ["bun", "cadet", "pair"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // Mint through the gateway CLI subprocess: process execution IS the
    // local-presence proof and the approval, so the link alone completes
    // the pairing — no HTTP at all for a local assistant.
    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0]?.args.slice(-2)).toEqual(["pairing", "mint"]);
    expect(calls).toHaveLength(0);

    const output = logs.join("\n");
    // One artifact, two renderings: the link and the same link as a QR.
    expect(output).toContain(
      `${PUBLIC_URL}/assistant/pair#device_code=device-code`,
    );
    expect(output).toContain("\u2588");
    expect(output).toContain("cadet connect import");
    expect(output).toContain("Expires: 2026-06-04T00:10:00.000Z");
    // The base64 bundle is gone: no blob, and no hand-this-over copy.
    expect(output).not.toContain("Hand this to the other machine");
    expect(output).not.toMatch(/eyJ[A-Za-z0-9+/=]{20,}/);
  });

  test("--json emits the pairing link, device code, and expiry", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    stubPairingGateway(calls);

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = ["bun", "cadet", "pair", "--json"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    const out = JSON.parse(logs.join("\n"));
    expect(out).toEqual({
      pairUrl: `${PUBLIC_URL}/assistant/pair#device_code=device-code`,
      deviceCode: "device-code",
      expiresAt: "2026-06-04T00:10:00.000Z",
      expiresInSeconds: 600,
    });
    // The device code rides the fragment only, never the path or query.
    const parsed = new URL(out.pairUrl);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("#device_code=device-code");
    // No credential ever reaches the output.
    expect(logs.join("\n")).not.toContain("token");
  });

  test("--qr is a silent no-op, identical to a flagless run", async () => {
    // Shipped iOS builds tell users to run `cadet pair --qr` (see
    // clients/ios/App/App/Settings.bundle/Root.plist), copy those installs can
    // never receive an update for, so the flag stays accepted and ignored.
    const origFetch = globalThis.fetch;

    async function runPair(argv: string[]): Promise<{
      urls: string[];
      output: string;
    }> {
      const calls: Array<[string, RequestInit | undefined]> = [];
      stubPairingGateway(calls);
      const logs: string[] = [];
      const logSpy = spyOn(console, "log").mockImplementation(
        (...a: unknown[]) => {
          logs.push(a.join(" "));
        },
      );
      const errSpy = spyOn(console, "error").mockImplementation(
        (...a: unknown[]) => {
          logs.push(`ERROR ${a.join(" ")}`);
        },
      );
      process.argv = argv;
      try {
        await pair();
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
      return { urls: calls.map((c) => c[0]), output: logs.join("\n") };
    }

    let plain: { urls: string[]; output: string };
    let withQr: { urls: string[]; output: string };
    try {
      plain = await runPair(["bun", "cadet", "pair"]);
      withQr = await runPair(["bun", "cadet", "pair", "--qr"]);
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(withQr.urls).toEqual(plain.urls);
    expect(withQr.output).toBe(plain.output);
    // Accepted, not retired: no migration error, and the QR still prints.
    expect(withQr.output).not.toContain("no longer an option");
    expect(withQr.output).toContain("\u2588");
  });

  test("--qr is not advertised in the help output", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );
    process.argv = ["bun", "cadet", "pair", "--help"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
    }
    expect(logs.join("\n")).not.toContain("--qr");
  });

  test("--app-scheme without --app is refused rather than ignored", async () => {
    // A scheme only names the app link, so accepting it alone would print the
    // https QR and drop the scheme silently.
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = withPreconnect(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation(
      (...a: unknown[]) => {
        errors.push(a.join(" "));
      },
    );
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`exit:${code}`);
      },
    );

    process.argv = ["bun", "cadet", "pair", "--app-scheme", "cadet-dev"];
    let exited = false;
    try {
      await pair();
    } catch (e) {
      exited = e instanceof Error && e.message === "exit:1";
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("--app-scheme");
    expect(errors.join("\n")).toContain("--app");
    // Refused before anything is minted.
    expect(fetchCalled).toBe(false);
  });

  test("resolves an unquoted multi-word display name", async () => {
    // Assistant whose display name has a space; passed as separate argv tokens.
    writeFileSync(
      join(testDir, "cadet", "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "pair-test",
            name: "My Assistant",
            runtimeUrl: RUNTIME_URL,
            cloud: "local",
            resources: {
              instanceDir: INSTANCE_DIR,
              gatewayPort: 7830,
              daemonPort: 8501,
            },
          },
        ],
        activeAssistant: "pair-test",
      }),
    );

    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    stubPairingGateway(calls);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    process.argv = ["bun", "cadet", "pair", "My", "Assistant", "--json"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // Resolution succeeded (no exit), so the challenge was minted.
    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0]?.args.slice(-2)).toEqual(["pairing", "mint"]);
    expect(calls).toHaveLength(0);
  });

  test("rejects an unknown --flag before any network call", async () => {
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = withPreconnect(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation(
      (...a: unknown[]) => {
        errors.push(a.join(" "));
      },
    );
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`exit:${code}`);
      },
    );

    process.argv = ["bun", "cadet", "pair", "--frobnicate"];
    let exited = false;
    try {
      await pair();
    } catch (e) {
      exited = e instanceof Error && e.message === "exit:1";
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // A `--` flag this version doesn't know is a hard error, and it points at
    // the CLI self-update path — never a silent fall-through to another flow.
    expect(exited).toBe(true);
    const joined = errors.join("\n");
    expect(joined).toContain("unknown option '--frobnicate'");
    expect(joined).toContain("your CLI may be out of date");
    expect(joined).toContain("bun install -g cadet@latest");
    expect(fetchCalled).toBe(false);
  });

  test("rejects an unknown --flag even alongside a multi-word positional name", async () => {
    writeFileSync(
      join(testDir, "cadet", "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "pair-test",
            name: "My Assistant",
            runtimeUrl: RUNTIME_URL,
            localUrl: LOCAL_URL,
            cloud: "local",
          },
        ],
        activeAssistant: "pair-test",
      }),
    );

    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = withPreconnect(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation(
      (...a: unknown[]) => {
        errors.push(a.join(" "));
      },
    );
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`exit:${code}`);
      },
    );

    // Positional name tokens must not rescue an unknown flag from rejection.
    process.argv = ["bun", "cadet", "pair", "My", "Assistant", "--frobnicate"];
    let exited = false;
    try {
      await pair();
    } catch (e) {
      exited = e instanceof Error && e.message === "exit:1";
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("unknown option '--frobnicate'");
    expect(fetchCalled).toBe(false);
  });

  test("advertises the saved ingress url even when the runtime url is loopback", async () => {
    writeFileSync(
      join(testDir, "cadet", "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "pair-test",
            runtimeUrl: LOCAL_URL,
            cloud: "local",
            resources: {
              instanceDir: INSTANCE_DIR,
              gatewayPort: 7830,
              daemonPort: 8501,
            },
          },
        ],
        activeAssistant: "pair-test",
      }),
    );

    const OVERRIDE = "https://abc123.ngrok.app";
    mintReplyBase = OVERRIDE;
    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    stubPairingGateway(calls, OVERRIDE);
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = ["bun", "cadet", "pair", "--json"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // Mint still through the gateway CLI, carrying no url; the link
    // advertises the address the tunnel recorded.
    expect(mintCalls[0]?.args.slice(-2)).toEqual(["pairing", "mint"]);
    expect(JSON.parse(logs.join("\n")).pairUrl).toBe(
      `${OVERRIDE}/assistant/pair#device_code=device-code`,
    );
  });

  test("--web-approve approves a browser pairing code over loopback", async () => {
    writeFileSync(
      join(testDir, "cadet", "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "pair-test",
            runtimeUrl: LOCAL_URL,
            localUrl: LOCAL_URL,
            cloud: "local",
          },
        ],
        activeAssistant: "pair-test",
      }),
    );

    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = withPreconnect(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push([url, init]);
        if (url === `${LOCAL_URL}/v1/remote-web/pairing-verification`) {
          return new Response(
            JSON.stringify({
              status: "approved",
              verificationUri: "https://abc123.ngrok.app/assistant/pair",
              expiresAt: "2026-06-04T00:10:00.000Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = [
      "bun",
      "cadet",
      "pair",
      "--web-approve",
      "ABCD-EFGH",
      "--json",
    ];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(`${LOCAL_URL}/v1/remote-web/pairing-verification`);
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      userCode: "ABCD-EFGH",
    });
    expect(JSON.parse(logs.join("\n"))).toEqual({
      status: "approved",
      verificationUri: "https://abc123.ngrok.app/assistant/pair",
      expiresAt: "2026-06-04T00:10:00.000Z",
    });
  });

  test("buildAppConnectUrl composes and encodes the connect link", () => {
    expect(
      buildAppConnectUrl("cadet", "https://pair.example.ts.net", "device-code"),
    ).toBe(
      "cadet://connect?url=https%3A%2F%2Fpair.example.ts.net&code=device-code",
    );
    // Path prefixes and fragment-hostile characters survive the encoding.
    expect(
      buildAppConnectUrl(
        "cadet-dev",
        "https://host.example.ts.net/assistant-123",
        "a+b/c=",
      ),
    ).toBe(
      "cadet-dev://connect?url=https%3A%2F%2Fhost.example.ts.net%2Fassistant-123&code=a%2Bb%2Fc%3D",
    );
    // A label rides along as an encoded `name` param (spaces percent-encoded,
    // not form-encoded, for the app's URLComponents parser); an empty one is
    // omitted.
    expect(
      buildAppConnectUrl(
        "cadet",
        "https://pair.example.ts.net",
        "device-code",
        "My Homelab",
      ),
    ).toBe(
      "cadet://connect?url=https%3A%2F%2Fpair.example.ts.net&code=device-code&name=My%20Homelab",
    );
    expect(
      buildAppConnectUrl(
        "cadet",
        "https://pair.example.ts.net",
        "device-code",
        "",
      ),
    ).toBe(
      "cadet://connect?url=https%3A%2F%2Fpair.example.ts.net&code=device-code",
    );
  });

  test("--app emits an app connect URL alongside the browser URL", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = withPreconnect(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-challenge`) {
        return new Response(
          JSON.stringify({
            deviceCode: "device-code",
            userCode: "ABCD-EFGH",
            verificationUri: "https://pair.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
            expiresInSeconds: 600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-verification`) {
        return new Response(
          JSON.stringify({
            status: "approved",
            verificationUri: "https://pair.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = [
      "bun",
      "cadet",
      "pair",
      "--app",
      "--app-scheme",
      "cadet-dev",
      "--json",
    ];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    const out = JSON.parse(logs.join("\n"));
    // Without --label the connect link names the assistant after its lockfile
    // display name (the id here, since the entry has no name).
    expect(out.appUrl).toBe(
      "cadet-dev://connect?url=https%3A%2F%2Fpair.example.ts.net&code=device-code&name=pair-test",
    );
    // The browser URL stays available as the no-app fallback.
    expect(out.pairUrl).toBe(
      "https://pair.example.ts.net/assistant/pair#device_code=device-code",
    );
    expect(out.deviceCode).toBe("device-code");
  });

  test("--app --label overrides the assistant name in the connect link", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = withPreconnect(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-challenge`) {
        return new Response(
          JSON.stringify({
            deviceCode: "device-code",
            userCode: "ABCD-EFGH",
            verificationUri: "https://pair.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
            expiresInSeconds: 600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-verification`) {
        return new Response(
          JSON.stringify({
            status: "approved",
            verificationUri: "https://pair.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = [
      "bun",
      "cadet",
      "pair",
      "--app",
      "--label",
      "Homelab",
      "--json",
    ];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    const out = JSON.parse(logs.join("\n"));
    expect(out.appUrl).toBe(
      "cadet://connect?url=https%3A%2F%2Fpair.example.ts.net&code=device-code&name=Homelab",
    );
  });

  test("--app is refused alongside --web-approve", async () => {
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = withPreconnect(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation(
      (...a: unknown[]) => {
        errors.push(a.join(" "));
      },
    );
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`exit:${code}`);
      },
    );

    process.argv = [
      "bun",
      "cadet",
      "pair",
      "--app",
      "--web-approve",
      "ABCD-EFGH",
    ];
    let exited = false;
    try {
      await pair();
    } catch (e) {
      exited = e instanceof Error && e.message === "exit:1";
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("--web-approve");
    expect(fetchCalled).toBe(false);
  });

  test("the gateway-CLI mint's challenge drives the advertised link", async () => {
    mintReplyBase = "https://saved.example.ts.net";

    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = withPreconnect(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("not found", { status: 404 });
    });

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = ["bun", "cadet", "pair"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // The minted challenge must advertise the recorded URL.
    expect(mintCalls[0]?.args.slice(-2)).toEqual(["pairing", "mint"]);
    expect(calls).toHaveLength(0);
    const output = logs.join("\n");
    expect(output).toContain(
      "https://saved.example.ts.net/assistant/pair#device_code=device-code",
    );
  });

  test("a custom (ssh-managed) assistant mints through the platform exec API and advertises the gateway's own URL", async () => {
    writeFileSync(
      join(testDir, "cadet", "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "pair-test",
            cloud: "custom",
            ipAddress: "203.0.113.9",
            port: 7830,
          },
        ],
        activeAssistant: "pair-test",
      }),
    );
    // cloudPair requires a cloud login (the exec API authenticates with it).
    writeFileSync(join(testDir, "cadet", "cloud-token"), "test-cloud-token");

    // The mint runs ON the assistant's gateway through the platform's
    // terminal-session exec API; the challenge's verificationUri is the
    // gateway's own advertised URL.
    execViaTerminalSessionMock.mockResolvedValueOnce({
      output: `${JSON.stringify({
        deviceCode: "device-code",
        userCode: "ABCD-EFGH",
        verificationUri: `${PUBLIC_URL}/assistant/pair`,
        expiresAt: "2026-06-04T00:10:00.000Z",
        expiresInSeconds: 600,
      })}\n`,
      exitCode: 0,
    });

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = ["bun", "cadet", "pair"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
    }

    expect(execViaTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(execViaTerminalSessionMock.mock.calls[0]?.[1]).toEqual([
      "bun",
      "run",
      "src/cli/index.ts",
      "pairing",
      "mint",
    ]);
    const output = logs.join("\n");
    expect(output).toContain(
      `${PUBLIC_URL}/assistant/pair#device_code=device-code`,
    );
  });
});
