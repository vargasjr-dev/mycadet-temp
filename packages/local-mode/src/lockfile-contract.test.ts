import { describe, expect, test } from "bun:test";

import {
  LockfileAssistantSchema,
  LockfileSchema,
  RemoteSchema,
  KNOWN_REMOTES,
  GATEWAY_PORT,
  getGatewayUrl,
  parseLockfile,
  stripSensitiveFields,
  SENSITIVE_KEYS,
  type Lockfile,
  type LockfileAssistant,
} from "./lockfile-contract";

describe("parseLockfile", () => {
  test("passes through a fully-populated lockfile", () => {
    const raw = {
      activeAssistant: "asst_1",
      assistants: [
        {
          assistantId: "asst_1",
          name: "Alice",
          cloud: "cloud",
          hatchedAt: "2026-01-01T00:00:00.000Z",
          cloudAssistantId: "platform-assistant-1",
          cloudBaseUrl: "https://platform.example.com",
          cloudOrganizationId: "org_1",
        },
        {
          assistantId: "asst_2",
          name: "Bob",
          cloud: "custom",
          ipAddress: "203.0.113.9",
          port: 7831,
        },
      ],
    };

    expect(parseLockfile(raw)).toEqual(raw as Lockfile);
  });

  test("keeps entries missing only optional fields", () => {
    const raw = {
      activeAssistant: null,
      assistants: [{ assistantId: "asst_1", cloud: "cloud" }],
    };

    const parsed = parseLockfile(raw);
    expect(parsed.assistants).toHaveLength(1);
    expect(parsed.assistants[0]).toEqual({
      assistantId: "asst_1",
      cloud: "cloud",
    });
  });

  test("salvages a legacy entry that has only an assistantId", () => {
    // The oldest persisted entries carry just the identity; the CLI fills the
    // rest in lazily. assistantId is the only required field, so the entry must
    // survive — normalized to the default `local` cloud.
    const parsed = parseLockfile({
      activeAssistant: "asst_1",
      assistants: [{ assistantId: "asst_1" }],
    });
    expect(parsed.assistants).toEqual([
      { assistantId: "asst_1", cloud: "local" },
    ]);
  });

  test("salvages an entry whose cloud is absent", () => {
    // Older CLI builds predate the `cloud` field and persisted the runtime URL
    // under a different key (`localUrl`), so a real on-disk entry can lack both
    // modeled fields. It must still be returned, normalized to `local`.
    const parsed = parseLockfile({
      activeAssistant: null,
      assistants: [
        { assistantId: "asst_1", localUrl: "http://127.0.0.1:7777" },
      ],
    });
    expect(parsed.assistants).toEqual([
      {
        assistantId: "asst_1",
        cloud: "local",
      },
    ]);
  });

  test("drops malformed entries but salvages valid siblings", () => {
    const raw = {
      activeAssistant: "asst_ok",
      assistants: [
        { assistantId: "asst_ok", cloud: "local" },
        { cloud: "local", runtimeUrl: "http://b" }, // missing assistantId
        { assistantId: 42, cloud: "local", runtimeUrl: "http://c" }, // wrong type
        "not-an-object",
      ],
    };

    const parsed = parseLockfile(raw);
    expect(parsed.assistants).toEqual([
      { assistantId: "asst_ok", cloud: "local" },
    ]);
    expect(parsed.activeAssistant).toBe("asst_ok");
  });

  test("accepts (but drops) entry fields unknown to this build", () => {
    const raw = {
      activeAssistant: "asst_1",
      schemaVersion: 99, // unknown top-level field from a newer writer
      assistants: [
        {
          assistantId: "asst_1",
          cloud: "local",
          futureField: { nested: true }, // unknown entry field
        },
      ],
    };

    // A newer writer's extra fields must never make an older reader reject
    // the entry — the schema is strict over the fields it models, so the
    // unknown entry field drops from the validated value while the unknown
    // root field rides the loose root (the local-mode write path still
    // merges raw JSON; see lockfile.test.ts).
    const parsed = parseLockfile(raw);
    expect(parsed.assistants).toEqual([
      { assistantId: "asst_1", cloud: "local" },
    ]);
    expect(parsed.activeAssistant).toBe("asst_1");
    expect(parsed.schemaVersion).toBe(99);
  });

  test("defaults missing or non-array assistants to an empty list", () => {
    expect(parseLockfile({}).assistants).toEqual([]);
    expect(parseLockfile({ assistants: "nope" }).assistants).toEqual([]);
  });

  test("coerces a non-string activeAssistant to null", () => {
    expect(
      parseLockfile({ assistants: [], activeAssistant: 7 }).activeAssistant,
    ).toBeNull();
    expect(parseLockfile({ assistants: [] }).activeAssistant).toBeNull();
  });

  test("returns the empty lockfile for non-object input", () => {
    const empty: Lockfile = { assistants: [], activeAssistant: null };
    expect(parseLockfile(null)).toEqual(empty);
    expect(parseLockfile(undefined)).toEqual(empty);
    expect(parseLockfile("[]")).toEqual(empty);
    expect(parseLockfile(123)).toEqual(empty);
  });

  test("absorbs a mistyped cloud as local; drops an entry whose other fields are mistyped", () => {
    // Entries parse whole: a mistyped modeled field invalidates the entry
    // (dropped, never partially salvaged). `cloud` is the exception — its
    // preprocessor absorbs any malformed value as "local".
    const raw = {
      assistants: [
        { assistantId: "asst_1", cloud: 7 }, // cloud not a string
        { assistantId: "asst_2", cloud: "local", port: "nope" }, // mistyped modeled field
      ],
      activeAssistant: null,
    };
    expect(parseLockfile(raw).assistants).toEqual([
      { assistantId: "asst_1", cloud: "local" },
    ]);
  });

  test("drops an entry only when its assistantId is missing or mistyped", () => {
    const raw = {
      assistants: [
        { cloud: "local" }, // no assistantId
        { assistantId: 42, cloud: "local" }, // assistantId not a string
      ],
      activeAssistant: null,
    };
    expect(parseLockfile(raw).assistants).toEqual([]);
  });

  test("drops an entry whose runtime fields are mistyped", () => {
    const raw = {
      assistants: [
        {
          assistantId: "asst_1",
          cloud: "local",
          port: "7777",
          daemonPort: 7778,
        },
      ],
      activeAssistant: null,
    };
    expect(parseLockfile(raw).assistants).toEqual([]);
  });

  test("keeps local runtime resource fields when well-typed", () => {
    const raw = {
      assistants: [
        {
          assistantId: "asst_1",
          cloud: "local",
          port: 7777,
          daemonPort: 7778,
          runtimeVersion: "v0.8.13",
          runtimeInstallDir: "/tmp/cadet/runtime/0.8.13",
        },
      ],
      activeAssistant: null,
    };
    const parsed = parseLockfile(raw).assistants[0];
    if (parsed?.cloud !== "local") throw new Error("expected a local entry");
    expect(parsed.port).toBe(7777);
    expect(parsed.daemonPort).toBe(7778);
    expect(parsed.runtimeVersion).toBe("v0.8.13");
    expect(parsed.runtimeInstallDir).toBe("/tmp/cadet/runtime/0.8.13");
  });

  test("the resources parse is strict over the modeled shape; secrets leave at the hosts' strip", () => {
    // Every field the CLI read-modify-writes is modeled, so the parse drops
    // nothing; the renderer boundary is `stripSensitiveFields`, which every
    // host runs on the raw JSON before this parse ever sees it.
    const raw = {
      assistants: [
        {
          assistantId: "asst_1",
          cloud: "local",
          instanceDir: "/data",
          port: 7777,
          daemonPort: 7778,
          runtimeVersion: "v0.8.13",
          runtimeInstallDir: "/tmp/cadet/runtime/0.8.13",
          cesPort: 7780,
        },
      ],
      activeAssistant: null,
    };
    const parsed = parseLockfile(raw).assistants[0];
    expect(parsed).toMatchObject({
      instanceDir: "/data",
      port: 7777,
      daemonPort: 7778,
      runtimeVersion: "v0.8.13",
      runtimeInstallDir: "/tmp/cadet/runtime/0.8.13",
      cesPort: 7780,
    });
    const stripped = structuredClone(raw);
    stripSensitiveFields(stripped);
    expect(parseLockfile(stripped).assistants[0]).toMatchObject({
      instanceDir: "/data",
      port: 7777,
      daemonPort: 7778,
      runtimeVersion: "v0.8.13",
      runtimeInstallDir: "/tmp/cadet/runtime/0.8.13",
      cesPort: 7780,
    });
  });

  test("ignores legacy remote markers; a cloudless entry is local", () => {
    // Pre-union entries encoded topology in `project`/`sshUser` markers and a
    // retired `paired` cloud spelling; the unified taxonomy has no legacy
    // reading — a cloudless or unknown cloud parses as "local".
    const raw = {
      assistants: [
        { assistantId: "gcp_1", project: "my-proj" },
        { assistantId: "ssh_1", sshUser: "deploy" },
        { assistantId: "legacy_1", cloud: "paired" },
      ],
      activeAssistant: null,
    };
    expect(parseLockfile(raw).assistants).toEqual([
      { assistantId: "gcp_1", cloud: "local" },
      { assistantId: "ssh_1", cloud: "local" },
      { assistantId: "legacy_1", cloud: "local" },
    ]);
  });

  test("the root LockfileSchema parses the file shape directly", () => {
    // parseLockfile is this schema's safeParse with an empty-lockfile
    // fallback; pinning the schema itself keeps the export honest.
    const parsed = LockfileSchema.safeParse({
      assistants: [
        { assistantId: "a", cloud: "local" },
        { notAnAssistant: true },
        null,
      ],
      activeAssistant: "a",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.assistants).toEqual([
      { assistantId: "a", cloud: "local" },
    ]);
    expect(parsed.data.activeAssistant).toBe("a");
    expect(LockfileSchema.safeParse("not an object").success).toBe(false);
  });

  test("parses the known clouds; a future writer's value degrades to local", () => {
    const raw = {
      assistants: [
        { assistantId: "a", cloud: "cloud", project: "stale-proj" },
        { assistantId: "c", cloud: "quantum" }, // unknown to this build
      ],
      activeAssistant: null,
    };
    expect(parseLockfile(raw).assistants).toEqual([
      { assistantId: "a", cloud: "cloud" },
      { assistantId: "c", cloud: "local" },
    ]);
  });

  test("carries the CLI's root process records through the parse", () => {
    const raw = {
      assistants: [{ assistantId: "a" }],
      activeAssistant: null,
      tunnel: {
        pid: 4242,
        provider: "ngrok" as const,
        startedAt: "2026-10-21T00:00:00.000Z",
        publicUrl: "https://tunnel.example.ts.net",
      },
      app: { pid: 51, port: 7840, builtSha: "abc1234" },
    };
    expect(parseLockfile(raw).tunnel).toEqual(raw.tunnel);
    expect(parseLockfile(raw).app).toEqual(raw.app);
  });

  test("drops a mistyped root process record, never the file", () => {
    const raw = {
      assistants: [{ assistantId: "a" }],
      activeAssistant: null,
      tunnel: { pid: "not-a-pid", provider: "ngrok", startedAt: "x" },
      app: 42,
    };
    const parsed = parseLockfile(raw);
    expect(parsed.tunnel).toBeUndefined();
    expect(parsed.app).toBeUndefined();
    expect(parsed.assistants).toEqual([{ assistantId: "a", cloud: "local" }]);
  });
});

describe("LockfileSchema defaults", () => {
  test("the empty-lockfile fallback is defined on the schema itself", () => {
    // parseLockfile's torn-file fallback parses an empty object through the
    // schema, so the default data lives in exactly one place.
    expect(LockfileSchema.parse({})).toEqual({
      assistants: [],
      activeAssistant: null,
    });
  });
});

describe("taxonomy", () => {
  test("KNOWN_REMOTES covers the documented topologies", () => {
    expect(KNOWN_REMOTES).toEqual([
      "local",
      "docker",
      "apple-container",
      "cloud",
      "custom",
      "baseten",
    ]);
  });

  test("RemoteSchema is the enum the lockfile and injected config share", () => {
    expect([...RemoteSchema.options]).toEqual([...KNOWN_REMOTES]);
  });

  test("SENSITIVE_KEYS lists the redacted secrets", () => {
    expect(SENSITIVE_KEYS).toEqual(["bearerToken", "guardianBootstrapSecret"]);
  });
});

describe("getGatewayUrl", () => {
  test("a baseten entry rides the sandbox API server's /port/ route", () => {
    expect(
      getGatewayUrl({
        assistantId: "asst_bx",
        cloud: "baseten",
        sandboxUrl: "https://sbx-name-abc123.us-pdx-1.b10.co",
        port: 7830,
      }),
    ).toBe("https://sbx-name-abc123.us-pdx-1.b10.co/port/7830");
  });

  test("a baseten entry's recorded URL is joined trailing-slash-free", () => {
    expect(
      getGatewayUrl({
        assistantId: "asst_bx",
        cloud: "baseten",
        sandboxUrl: "https://sbx-name-abc123.us-pdx-1.b10.co/",
        port: 7830,
      }),
    ).toBe("https://sbx-name-abc123.us-pdx-1.b10.co/port/7830");
  });

  test("a baseten entry without a sandbox URL is dropped by the parse", () => {
    // The union makes the URL and port un-omittable: a record that lost them
    // (a describe miss) cannot survive as a half-addressable baseten entry.
    const parsed = parseLockfile({
      assistants: [{ assistantId: "asst_bx", cloud: "baseten", port: 7830 }],
    });
    expect(parsed.assistants).toEqual([]);
  });

  test("the schema round-trips a baseten entry's sandbox URL", () => {
    const raw = {
      activeAssistant: "asst_bx",
      assistants: [
        {
          assistantId: "asst_bx",
          name: "Sandboxed",
          cloud: "baseten",
          sandboxUrl: "https://sbx-name-abc123.us-pdx-1.b10.co",
          port: 7830,
        },
      ],
    };
    expect(parseLockfile(raw)).toEqual(raw as Lockfile);
  });

  test("an unknown cloud still parses as local", () => {
    // The union's preprocessor routes absent and unknown topologies to the
    // local default, so a forward-compat entry survives a downgrade.
    const parsed = parseLockfile({
      assistants: [{ assistantId: "asst_new", cloud: "galaxy" }],
    });
    expect(parsed.assistants).toEqual([
      { assistantId: "asst_new", cloud: "local" },
    ]);
  });
});
