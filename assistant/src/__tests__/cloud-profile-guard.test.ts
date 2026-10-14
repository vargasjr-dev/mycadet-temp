/**
 * Tests the two layers protecting managed inference profiles:
 *
 * - Route-level managed guards: cloud profiles can't be deleted via PATCH
 *   and the PUT profile route accepts only a pure status re-enable body for
 *   them.
 * - The commitConfigWrite invariant guard: every cloud profile name
 *   ("quality-optimized", "balanced", "cost-optimized", "os-beta") is fully
 *   read-only across PATCH/SET/PUT while its on-disk entry is
 *   managed-source — the only writable transition is re-enabling a disabled
 *   profile. A user-owned (`source: "user"`) entry sharing a cloud name is
 *   not locked.
 *
 * Plus the wire-only profile keys (`invariant`, `supportsVision`) stamped on
 * config reads: PATCH/SET strip them so a GET → write round-trip succeeds.
 */

import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// The config routes under test read and write the workspace config.json via
// the real loader (`loadRawConfig`/`saveRawConfig`). Tests seed the raw file
// directly (the fixtures are raw-file shapes, not schema-parsed configs, so
// the whole file is replaced rather than composed via `setConfig`) and detect
// commits by comparing the on-disk text against the seeded snapshot —
// `saveRawConfig` pretty-prints, so any commit (even a content no-op) changes
// the text.
let rawConfig: Record<string, unknown>;
let seededRawText = "";
let mtimeSeq = 0;
// Counter so tests can assert whether `commitConfigWrite` ran its post-write
// side effects: rejected writes must leave it at 0, allowed writes bump it
// exactly once.
let initializeProvidersCalls = 0;

function configJsonPath(): string {
  return join(process.env.CADET_WORKSPACE_DIR!, "config.json");
}

/**
 * Write `raw` to the workspace config.json as the seeded pre-test state.
 * Also called after in-place mutations of `rawConfig` to flush them to disk.
 */
function seedRawConfig(raw: Record<string, unknown>): void {
  rawConfig = raw;
  seededRawText = JSON.stringify(raw);
  writeFileSync(configJsonPath(), seededRawText);
  // Distinct mtime per write so the loader's file-signature cache can never
  // read two consecutive seeds as identical.
  mtimeSeq += 1;
  const stamp = new Date(Date.now() + mtimeSeq);
  utimesSync(configJsonPath(), stamp, stamp);
}

/** The raw config a route commit persisted, or null when nothing was saved. */
function committedRaw(): Record<string, unknown> | null {
  const text = readFileSync(configJsonPath(), "utf8");
  if (text === seededRawText) {
    return null;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function makeDefaultRawConfig(): Record<string, unknown> {
  return {
    llm: {
      profiles: {
        "quality-optimized": {
          provider: "cadet",
          model: "claude-sonnet-4-6",
        },
        balanced: {
          provider: "cadet",
          model: "claude-sonnet-4-6",
        },
        "cost-optimized": {
          provider: "cadet",
          model: "claude-sonnet-4-6",
        },
        "my-custom": { provider: "openai", model: "gpt-4o" },
      },
    },
  };
}

mock.module("../providers/registry.js", () => ({
  initializeProviders: async () => {
    initializeProvidersCalls += 1;
  },
}));

mock.module("../persistence/embeddings/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

// The replace-profile handler auto-derives `provider_connection` from the
// first active connection matching the requested provider when the body
// omits it. That path queries the `provider_connections` table, which the
// test doesn't migrate — stub it out so the guard logic stays the focus.
mock.module("../providers/inference/connections.js", () => ({
  listConnections: () => [],
  createConnection: () => ({ ok: false, error: { code: "already_exists" } }),
  getConnection: () => null,
  CADET_CLOUD_CONNECTION_NAME: "cadet",
}));

import { ROUTES } from "../runtime/routes/conversation-query-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";

const replaceRoute = ROUTES.find(
  (r) => r.operationId === "config_llm_profiles_replace",
)!;

const patchRoute = ROUTES.find((r) => r.operationId === "config_patch")!;

const setRoute = ROUTES.find((r) => r.operationId === "config_set")!;

beforeEach(() => {
  seedRawConfig(makeDefaultRawConfig());
  initializeProvidersCalls = 0;
});

function expectNothingCommitted(): void {
  expect(committedRaw()).toBeNull();
  expect(initializeProvidersCalls).toBe(0);
}

function expectOneCommitCycle(): void {
  expect(committedRaw()).not.toBeNull();
  expect(initializeProvidersCalls).toBe(1);
}

function savedProfile(name: string): Record<string, unknown> {
  return (committedRaw() as Record<string, any>).llm.profiles[name] as Record<
    string,
    unknown
  >;
}

describe("partial default-provider config", () => {
  for (const provider of ["cadet", "chatgpt"]) {
    test(`timezone PATCH accepts a model-less ${provider} default`, async () => {
      seedRawConfig({ llm: { default: { provider } } });
      await patchRoute.handler({
        body: { ui: { userTimezone: "America/New_York" } },
      });
      const saved = committedRaw() as {
        ui: { userTimezone: string };
        llm: { default: { provider: string; model?: string } };
      };
      expect(saved.ui.userTimezone).toBe("America/New_York");
      expect(saved.llm.default).toEqual({ provider });
      expectOneCommitCycle();
    });
    test(`PATCH can select ${provider} as default without a model`, async () => {
      seedRawConfig({});
      await patchRoute.handler({ body: { llm: { default: { provider } } } });
      expect(
        (committedRaw() as { llm: { default: { provider: string } } }).llm
          .default,
      ).toEqual({ provider });
    });
  }
  test("an explicit unroutable default model is still rejected", async () => {
    await expect(
      patchRoute.handler({
        body: {
          llm: { default: { provider: "cadet", model: "not-a-real-model" } },
        },
      }),
    ).rejects.toThrow(/not served by the Cadet Cloud route/);
    expectNothingCommitted();
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/config/llm/profiles/:name — replace inference profile
// ---------------------------------------------------------------------------

describe("PUT /v1/config/llm/profiles/:name — cloud profile guard", () => {
  test("rejects provider/model edits to quality-optimized", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "quality-optimized" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(
      'Cannot edit cloud profile "quality-optimized" fields [provider, model]. ' +
        "Cloud profiles are read-only (a disabled profile can be re-enabled); " +
        "duplicate to a custom profile to customize.",
    );
  });

  test("rejects edits to balanced", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects edits to cost-optimized", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "cost-optimized" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("allows edits to custom-balanced (user-owned)", async () => {
    const result = await replaceRoute.handler({
      pathParams: { name: "custom-balanced" },
      body: { provider: "openai", model: "gpt-4o" },
    });
    expect(result).toEqual({ ok: true });
    expect(committedRaw()).not.toBeNull();
  });

  test("allows edits to a user-defined profile", async () => {
    const result = await replaceRoute.handler({
      pathParams: { name: "my-custom" },
      body: { provider: "openai", model: "gpt-4o" },
    });
    expect(result).toEqual({ ok: true });
    expect(committedRaw()).not.toBeNull();
  });

  test("accepts routing identities on the replace path without deriving a connection", async () => {
    const result = await replaceRoute.handler({
      pathParams: { name: "my-custom" },
      body: { provider: "cadet", model: "claude-opus-4-8" },
    });
    expect(result).toEqual({ ok: true });
    const committed = committedRaw() as {
      llm?: { profiles?: Record<string, Record<string, unknown>> };
    } | null;
    expect(committed?.llm?.profiles?.["my-custom"]).toMatchObject({
      provider: "cadet",
      model: "claude-opus-4-8",
    });
    expect(
      committed?.llm?.profiles?.["my-custom"]?.provider_connection,
    ).toBeUndefined();
  });

  test("rejects a routing identity with an unroutable model at the write choke point", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "my-custom" },
        body: { provider: "cadet", model: "not-a-real-model" },
      }),
    ).rejects.toThrow(/not served by the Cadet Cloud route/);
    expect(committedRaw()).toBeNull();
  });

  test("rejects a routing identity in a raw call-site fragment without a model", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { callSites: { mainAgent: { provider: "chatgpt" } } } },
      }),
    ).rejects.toThrow(/requires an explicit model/);
    expect(committedRaw()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Null-as-clear sentinel: clients send `{ label: null }` or
  // `{ status: null }` to clear a cloud profile's overrides back to the
  // seed defaults. The Zod `ProfileEntry` schema accepts null for both
  // fields. Every managed name is invariant, so on managed-source entries
  // only the status clear is allowed (re-enable) — every other field is
  // frozen at commit time.
  // -------------------------------------------------------------------------

  test("PUT { label: null } on a cloud profile is rejected (label is frozen)", async () => {
    seedRawConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "cadet",
            model: "claude-sonnet-4-6",
            label: "My Custom Name",
          },
        },
      },
    });
    await expect(
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { label: null },
      }),
    ).rejects.toThrow('Cannot edit cloud profile "balanced" fields [label]');
    expectNothingCommitted();
  });

  test("PUT on the code-owned latency profile is rejected, status re-enable included", async () => {
    // Fast fronts live voice, so it takes no writes at all: the re-enable
    // escape hatch the other cloud profiles keep would persist a stub that
    // never governs what the name resolves to.
    seedRawConfig({ llm: { profiles: {} } });

    for (const body of [
      { label: "Zippy" },
      { status: "active" as const },
      { status: null },
    ]) {
      await expect(
        replaceRoute.handler({
          pathParams: { name: "latency-optimized" },
          body,
        }),
      ).rejects.toThrow(
        'Profile "latency-optimized" is code-owned and cannot be edited.',
      );
    }
    expectNothingCommitted();
  });

  test("PUT on a cloud backup profile is rejected as code-owned", async () => {
    // Backups are code-owned too, and they carry no on-disk entry, so the
    // code-owned rejection has to win over the availability gate: reporting
    // "not currently available" would be wrong for a profile the picker
    // lists and the user can select.
    seedRawConfig({ llm: { profiles: {} } });

    for (const name of [
      "balanced-backup",
      "quality-optimized-backup",
      "cost-optimized-backup",
      "latency-optimized-backup",
    ]) {
      for (const body of [
        { label: "Zippy" },
        { status: "active" as const },
        { status: null },
      ]) {
        await expect(
          replaceRoute.handler({ pathParams: { name }, body }),
        ).rejects.toThrow(
          `Profile "${name}" is code-owned and cannot be edited.`,
        );
      }
    }
    expectNothingCommitted();
  });

  test("PUT { status: null } on cloud profile clears status (back to active-by-absence)", async () => {
    seedRawConfig({
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "cadet",
            model: "claude-sonnet-4-6",
            status: "disabled",
          },
        },
      },
    });
    const result = await replaceRoute.handler({
      pathParams: { name: "quality-optimized" },
      body: { status: null },
    });
    expect(result).toEqual({ ok: true });
    const profile = savedProfile("quality-optimized");
    expect("status" in profile).toBe(false);
    expect(profile.provider).toBe("cadet");
    expect(profile.model).toBe("claude-sonnet-4-6");
  });

  test("PUT { label: null, status: null } on managed os-beta is rejected (label is frozen)", async () => {
    seedRawConfig({
      llm: {
        profiles: {
          "os-beta": {
            provider: "cadet",
            model: "zai-org/GLM-5.2",
            label: "OS Beta (Custom)",
            status: "disabled",
          },
        },
      },
    });
    // The status clear alone is the re-enable direction and would pass, but
    // the label clear touches a frozen field so the whole write is rejected.
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { label: null, status: null },
      }),
    ).rejects.toThrow('Cannot edit cloud profile "os-beta" fields [label]');
    expectNothingCommitted();
  });

  test("PUT { status: 'disabled' } on managed os-beta is rejected (read-only)", async () => {
    seedRawConfig({
      llm: {
        profiles: {
          "os-beta": {
            provider: "cadet",
            model: "zai-org/GLM-5.2",
            label: "Custom Label",
          },
        },
      },
    });
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { status: "disabled" },
      }),
    ).rejects.toThrow(
      'Cannot edit cloud profile "os-beta". Cloud profiles are read-only',
    );
    expectNothingCommitted();
  });

  test("PUT { topP } on managed os-beta is rejected (topP is frozen)", async () => {
    seedRawConfig({
      llm: {
        profiles: {
          "os-beta": {
            provider: "cadet",
            model: "zai-org/GLM-5.2",
          },
        },
      },
    });
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { topP: 0.9 },
      }),
    ).rejects.toThrow('Cannot edit cloud profile "os-beta" fields [topP]');
    expectNothingCommitted();
  });

  test("PUT { topP: null } on managed os-beta is rejected (frozen even when clearing)", async () => {
    seedRawConfig({
      llm: {
        profiles: {
          "os-beta": {
            provider: "cadet",
            model: "zai-org/GLM-5.2",
            topP: 0.7,
          },
        },
      },
    });
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { topP: null },
      }),
    ).rejects.toThrow('Cannot edit cloud profile "os-beta" fields [topP]');
    expectNothingCommitted();
  });

  test("PUT { status: 'active' } re-enables a disabled managed os-beta profile", async () => {
    seedRawConfig({
      llm: {
        profiles: {
          "os-beta": {
            provider: "cadet",
            model: "claude-sonnet-4-6",
            status: "disabled",
          },
        },
      },
    });
    const result = await replaceRoute.handler({
      pathParams: { name: "os-beta" },
      body: { status: "active" },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("os-beta");
    expect(profile.status).toBe("active");
    expect(profile.provider).toBe("cadet");
    expect(profile.model).toBe("claude-sonnet-4-6");
  });

  test("allows edits to a user-owned profile sharing a cloud name (os-beta)", async () => {
    seedRawConfig({
      llm: {
        profiles: {
          "os-beta": {
            provider: "anthropic",
            model: "gpt-4o",
          },
        },
      },
    });
    const result = await replaceRoute.handler({
      pathParams: { name: "os-beta" },
      body: { provider: "openai", model: "gpt-4o" },
    });
    expect(result).toEqual({ ok: true });
    const profile = savedProfile("os-beta");
    expect(profile.provider).toBe("openai");
    expect(profile.model).toBe("gpt-4o");
  });

  test("rejects edits to a cloud os-beta profile", async () => {
    seedRawConfig({
      llm: {
        profiles: {
          "os-beta": {
            provider: "cadet",
            model: "accounts/fireworks/models/glm-5p2",
          },
        },
      },
    });
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects PUT to os-beta when no os-beta profile exists, writing no stub", async () => {
    seedRawConfig({ llm: { profiles: {} } });
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { label: "My OS Beta" },
      }),
    ).rejects.toThrow("not currently available");
    expect(committedRaw()).toBeNull();
    const onDisk = JSON.parse(readFileSync(configJsonPath(), "utf8")) as Record<
      string,
      any
    >;
    expect(onDisk?.llm?.profiles?.["os-beta"]).toBeUndefined();
  });

  test("PUT { label: '' } on cloud profile still rejected by `.min(1)`", async () => {
    // `.nullable()` only widens the type to accept null — empty strings
    // still fail the min-length check, which is correct: an empty string
    // would persist as a literal "" override, not the clear-to-seed
    // intent. Clients must send `null` to clear.
    await expect(
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { label: "" },
      }),
    ).rejects.toThrow(BadRequestError);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/config — cloud profile deletion guard
// ---------------------------------------------------------------------------

describe("PATCH /v1/config — cloud profile deletion guard", () => {
  test("allows deletion of custom-balanced via null (user-owned)", async () => {
    const result = await patchRoute.handler({
      body: { llm: { profiles: { "custom-balanced": null } } },
    });
    expect(result).toHaveProperty("llm");
  });

  test("allows deletion of a user-defined profile via null", async () => {
    const result = await patchRoute.handler({
      body: { llm: { profiles: { "my-custom": null } } },
    });
    expect(result).toHaveProperty("llm");
  });

  test("allows non-profile config patches", async () => {
    const result = await patchRoute.handler({
      body: { someOtherKey: "value" },
    });
    expect(result).toHaveProperty("llm");
  });

  test("clears stale Tunnel ownership when manually patching public base URL", async () => {
    seedRawConfig({
      ingress: {
        publicBaseUrl: "https://stale-tunnel.example.test",
        publicBaseUrlManagedBy: "tunnel",
      },
    });

    const result = await patchRoute.handler({
      body: {
        ingress: { publicBaseUrl: "https://manual.example.test" },
      },
    });

    expect(result).toHaveProperty("ingress");
    const committed = committedRaw() as Record<string, any>;
    expect(committed.ingress.publicBaseUrl).toBe("https://manual.example.test");
    expect(committed.ingress.publicBaseUrlManagedBy).toBe("tunnel");
    expect("lastTunnel" in committed.ingress).toBe(false);
    expect("pairingTunnel" in committed.ingress).toBe(false);
    expect("assistantId" in committed.ingress).toBe(false);
  });

  test("allows patches that modify a cloud profile (non-null)", async () => {
    const result = await patchRoute.handler({
      body: {
        llm: {
          profiles: { "quality-optimized": { provider: "anthropic" } },
        },
      },
    });
    expect(result).toHaveProperty("llm");
  });

  test("allows deletion of a user-owned profile sharing a cloud name (os-beta)", async () => {
    seedRawConfig({
      llm: {
        profiles: {
          "os-beta": {
            provider: "cadet",
            model: "claude-sonnet-4-6",
          },
        },
      },
    });
    const result = await patchRoute.handler({
      body: { llm: { profiles: { "os-beta": null } } },
    });
    expect(result).toHaveProperty("llm");
  });
});

// ---------------------------------------------------------------------------
// commitConfigWrite — cloud-profile invariant guard
//
// Every cloud profile name (balanced, quality-optimized, cost-optimized,
// os-beta) is read-only to every config-write route while its on-disk entry
// is managed-source; the only writable transition is re-enabling a disabled
// profile. A user-owned entry sharing a cloud name is not locked. Enforced
// point, so PATCH, SET, and PUT are all covered by the same checks.
// ---------------------------------------------------------------------------

describe("cloud-profile invariant guard — rejected writes", () => {
  test("PATCH overwriting balanced with a string is rejected", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: "junk" } } },
      }),
    ).rejects.toThrow("expected object, received string");
    expectNothingCommitted();
  });

  test("PATCH overwriting balanced with an array is rejected", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: ["disabled"] } } },
      }),
    ).rejects.toThrow("expected object, received array");
    expectNothingCommitted();
  });

  // SET flows through the same commitConfigWrite guard as PATCH, so the
  // per-field matrix above isn't repeated per route — one rejection per
  // route proves the wiring. PUT rejects non-re-enable managed bodies at its
  // own gate, before the commit guard.
  test("PUT { status: 'disabled' } on balanced is rejected", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { status: "disabled" },
      }),
    ).rejects.toThrow(
      'Cannot edit cloud profile "balanced". Cloud profiles are read-only',
    );
    expectNothingCommitted();
  });

  test("PATCH { status: 'weird' } on balanced is rejected (junk status)", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { status: "weird" } } } },
      }),
    ).rejects.toThrow("llm.profiles.balanced.status: Invalid option");
    expectNothingCommitted();
  });

  test("SET llm.profiles.balanced.status = 123 is rejected (junk status)", async () => {
    await expect(
      setRoute.handler({
        body: { path: "llm.profiles.balanced.status", value: 123 },
      }),
    ).rejects.toThrow("llm.profiles.balanced.status: Invalid option");
    expectNothingCommitted();
  });
});

describe("default-profile invariant guard — allowed writes", () => {
  test("PATCH re-enables a disabled cloud profile (BYOK re-enable)", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.status =
      "disabled";
    seedRawConfig(rawConfig);
    const result = await patchRoute.handler({
      body: { llm: { profiles: { balanced: { status: "active" } } } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    expect(savedProfile("balanced").status).toBe("active");
  });

  test("PATCH { status: null } clears a disabled default back to active-by-absence", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.status =
      "disabled";
    seedRawConfig(rawConfig);
    const result = await patchRoute.handler({
      body: { llm: { profiles: { balanced: { status: null } } } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    expect(savedProfile("balanced").status ?? null).toBeNull();
  });

  test("PUT { status: 'active' } re-enables a disabled cloud profile", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.status =
      "disabled";
    seedRawConfig(rawConfig);
    const result = await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { status: "active" },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    expect(savedProfile("balanced").status).toBe("active");
  });

  test("SET llm.profiles.balanced.status = 'active' re-enables a disabled cloud profile", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.status =
      "disabled";
    seedRawConfig(rawConfig);
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced.status", value: "active" },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    expect(savedProfile("balanced").status).toBe("active");
  });

  test("SET llm passes when the value carries the invariant profiles unchanged (incl. frozen topP override)", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.topP = 0.7;
    seedRawConfig(rawConfig);
    const nextLlm = structuredClone(
      (rawConfig as Record<string, any>).llm,
    ) as Record<string, unknown>;
    nextLlm.activeProfile = "my-custom";
    const result = await setRoute.handler({
      body: { path: "llm", value: nextLlm },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    // The pre-existing topP override survives untouched.
    expect(savedProfile("balanced").topP).toBe(0.7);
    expect((committedRaw() as Record<string, any>).llm.activeProfile).toBe(
      "my-custom",
    );
  });

  test("PATCH deleting a user-sourced balanced entry is allowed (invariance is source-gated)", async () => {
    // A `source: "user"` entry passes the cloud-deletion guard AND the
    // invariant guard — both key on the on-disk entry's managed source, so
    // a user-owned profile sharing a cloud name stays deletable.
    (rawConfig as Record<string, any>).llm.profiles.balanced.source = "user";
    seedRawConfig(rawConfig);
    const result = await patchRoute.handler({
      body: { llm: { profiles: { balanced: null } } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
  });

  test("PUT full edits on a user-sourced os-beta entry are allowed (invariance is source-gated)", async () => {
    (rawConfig as Record<string, any>).llm.profiles["os-beta"] = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    };
    seedRawConfig(rawConfig);
    const result = await replaceRoute.handler({
      pathParams: { name: "os-beta" },
      body: { provider: "openai", model: "gpt-4o", topP: 0.5 },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("os-beta");
    expect(profile.provider).toBe("openai");
    expect(profile.model).toBe("gpt-4o");
    expect(profile.topP).toBe(0.5);
  });

  test("PUT full edits on a custom profile remain allowed", async () => {
    const result = await replaceRoute.handler({
      pathParams: { name: "my-custom" },
      body: { provider: "openai", model: "gpt-4o", maxTokens: 4096 },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("my-custom");
    expect(profile.provider).toBe("openai");
    expect(profile.model).toBe("gpt-4o");
    expect(profile.maxTokens).toBe(4096);
  });

  test("PATCH non-profile llm writes are unaffected", async () => {
    const result = await patchRoute.handler({
      body: { llm: { activeProfile: "balanced" } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    expect((committedRaw() as Record<string, any>).llm.activeProfile).toBe(
      "balanced",
    );
    // The invariant profiles are untouched by an unrelated llm write.
    expect(savedProfile("balanced")).toEqual(
      (makeDefaultRawConfig() as Record<string, any>).llm.profiles.balanced,
    );
  });
});

// ---------------------------------------------------------------------------
// Wire-only profile keys (`invariant`, `supportsVision`) are stamped onto
// config GET/PATCH responses but never persisted. Writes carrying them —
// e.g. a `config get` → `config set` round-trip — must succeed with the
// wire keys stripped, not 400 on phantom fields.
// ---------------------------------------------------------------------------

describe("wire-only profile keys are stripped from writes", () => {
  test("PATCH re-enable carrying wire keys succeeds and persists neither key", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.status =
      "disabled";
    seedRawConfig(rawConfig);
    const result = await patchRoute.handler({
      body: {
        llm: {
          profiles: {
            balanced: {
              status: "active",
              invariant: true,
              supportsVision: true,
            },
          },
        },
      },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    const profile = savedProfile("balanced");
    expect(profile.status).toBe("active");
    expect("invariant" in profile).toBe(false);
    expect("supportsVision" in profile).toBe(false);
  });

  test("SET llm.profiles.balanced with a wire-shaped entry (GET round-trip) succeeds", async () => {
    const entry = structuredClone(
      (rawConfig as Record<string, any>).llm.profiles.balanced,
    ) as Record<string, unknown>;
    entry.invariant = true;
    entry.supportsVision = true;
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced", value: entry },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("balanced");
    expect("invariant" in profile).toBe(false);
    expect("supportsVision" in profile).toBe(false);
    expect(profile.provider).toBe("cadet");
    expect(profile.model).toBe("claude-sonnet-4-6");
  });

  test("SET of a wire-only leaf path never persists the key", async () => {
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced.supportsVision", value: true },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    expect("supportsVision" in savedProfile("balanced")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Stale wire-only keys on disk: configs written before the write-side strip
  // existed can carry `supportsVision` under a cloud profile. The invariant
  // guard ignores wire-only keys on both sides, so a GET → write round-trip
  // (whose incoming copy is stripped) is not rejected for "removing" the
  // stale key — and a full-entry SET drops it from disk.
  // -------------------------------------------------------------------------

  test("SET round-trip re-enabling a cloud profile with stale on-disk supportsVision succeeds and drops the stale key", async () => {
    const balanced = (rawConfig as Record<string, any>).llm.profiles.balanced;
    balanced.supportsVision = true; // stale pre-strip persistence
    balanced.status = "disabled";
    seedRawConfig(rawConfig);
    const entry = structuredClone(balanced) as Record<string, unknown>;
    entry.invariant = true; // wire stamp from GET
    entry.status = "active"; // legal re-enable
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced", value: entry },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("balanced");
    expect(profile.status).toBe("active");
    expect("supportsVision" in profile).toBe(false);
    expect("invariant" in profile).toBe(false);
    expect(profile.provider).toBe("cadet");
    expect(profile.model).toBe("claude-sonnet-4-6");
  });

  test("pure no-op SET round-trip with stale on-disk supportsVision succeeds", async () => {
    const balanced = (rawConfig as Record<string, any>).llm.profiles.balanced;
    balanced.supportsVision = true; // stale pre-strip persistence
    seedRawConfig(rawConfig);
    const entry = structuredClone(balanced) as Record<string, unknown>;
    entry.invariant = true; // wire stamp from GET
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced", value: entry },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("balanced");
    expect("supportsVision" in profile).toBe(false);
    expect("invariant" in profile).toBe(false);
    expect(profile.provider).toBe("cadet");
    expect(profile.model).toBe("claude-sonnet-4-6");
  });

  test("PATCH re-enable carrying wire keys succeeds when the on-disk entry has stale supportsVision", async () => {
    const balanced = (rawConfig as Record<string, any>).llm.profiles.balanced;
    balanced.supportsVision = true; // stale pre-strip persistence
    balanced.status = "disabled";
    seedRawConfig(rawConfig);
    const result = await patchRoute.handler({
      body: {
        llm: {
          profiles: {
            balanced: {
              status: "active",
              invariant: true,
              supportsVision: true,
            },
          },
        },
      },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    const profile = savedProfile("balanced");
    expect(profile.status).toBe("active");
    // The deep merge starts from the on-disk entry, so the stale key survives
    // a PATCH (only a full-entry SET removes it) — but the write gains no
    // `invariant` key and never 400s on the phantom-field diff.
    expect("invariant" in profile).toBe(false);
  });

  test("PATCH with supportsVision on a custom profile does not persist it", async () => {
    const result = await patchRoute.handler({
      body: {
        llm: {
          profiles: { "my-custom": { supportsVision: false, maxTokens: 2048 } },
        },
      },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    const profile = savedProfile("my-custom");
    expect("supportsVision" in profile).toBe(false);
    expect(profile.maxTokens).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// Code-owned default profiles: wire round-trip and shadowing guards
// ---------------------------------------------------------------------------

const getRoute = ROUTES.find((r) => r.operationId === "config_get")!;

describe("code-owned default profiles — wire view and write normalization", () => {
  test("GET serves thin stubs verbatim — materialization lives on the profiles API", async () => {
    seedRawConfig({
      llm: {
        profiles: { balanced: { status: "disabled" } },
      },
    });
    const response = (await getRoute.handler({})) as Record<string, any>;
    const wireBalanced = response.llm.profiles.balanced;
    expect(wireBalanced).toEqual({ status: "disabled" });
    // Catalog-only defaults (no on-disk stub) do not appear at all — the
    // profiles API's list serves their resolved bodies.
    expect(response.llm.profiles["quality-optimized"]).toBeUndefined();
  });

  test("PUT status re-enable on an absent always-available default creates a thin managed stub", async () => {
    seedRawConfig({ llm: { profiles: {} } });
    const result = await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { status: "active" },
    });
    expect(result).toEqual({ ok: true });
    expect(savedProfile("balanced")).toEqual({
      status: "active",
    });
  });

  test("PUT on absent flag-gated os-beta is still rejected", async () => {
    seedRawConfig({ llm: { profiles: {} } });
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { status: "active" },
      }),
    ).rejects.toThrow(
      'Profile "os-beta" is not currently available and cannot be edited.',
    );
    expectNothingCommitted();
  });

  test("an existing user-source shadow of a default name stays editable", async () => {
    seedRawConfig({
      llm: {
        profiles: {
          balanced: { source: "user", provider: "openai", model: "gpt-4o" },
        },
      },
    });
    const result = await patchRoute.handler({
      body: { llm: { profiles: { balanced: { model: "gpt-5.4" } } } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    expect(savedProfile("balanced").model).toBe("gpt-5.4");
  });
});

describe("code-owned default profiles — BYO default provider wire view", () => {
  // With the llm.default blob set, the wire view must show the column of the
  // intent × provider matrix that actually dispatches — not the cadet
  // column — and the write path must echo-strip against that same view or an
  // honest GET → write round-trip is rejected.
  test("GET serves no catalog-only defaults — the profiles API materializes the column", async () => {
    seedRawConfig({
      llm: { default: { provider: "anthropic" }, profiles: {} },
    });
    const response = (await getRoute.handler({})) as Record<string, any>;
    expect(response.llm.profiles).toEqual({});
  });

  test("GET → PATCH round-trip of the raw profiles is accepted on a BYO install too", async () => {
    seedRawConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: { balanced: { status: "disabled" } },
      },
    });
    const response = (await getRoute.handler({})) as Record<string, any>;
    const result = await patchRoute.handler({
      body: { llm: { profiles: response.llm.profiles } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    expect(savedProfile("balanced")).toEqual({
      status: "disabled",
    });
    // No absent-default echoes exist to reduce — nothing else is written.
    expect(savedProfile("quality-optimized")).toBeUndefined();
  });

  test("GET → SET llm round-trip of the raw view is accepted and writes no stubs", async () => {
    seedRawConfig({
      llm: { default: { provider: "anthropic" }, profiles: {} },
    });
    const response = (await getRoute.handler({})) as Record<string, any>;
    const result = await setRoute.handler({
      body: { path: "llm", value: response.llm },
    });
    expect(result).toHaveProperty("ok");
    // The raw response carries no materialized catalog bodies, so the
    // catalog-only default stays catalog-only.
    expect(savedProfile("balanced")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/config — legacy service-mode scrub
// ---------------------------------------------------------------------------

describe("PATCH /v1/config — provider-only services scrub legacy mode", () => {
  test("a paired provider+mode write persists without the mode key", async () => {
    // Web clients pair provider writes with `mode` so their saves stay valid
    // on daemons whose schemas still carry it; the raw config must not
    // resurrect the removed field on every save.
    await patchRoute.handler({
      body: {
        services: {
          "image-generation": { provider: "cadet", mode: "managed" },
          "web-search": { provider: "cadet", mode: "managed" },
        },
      },
    } as never);

    const raw = committedRaw() as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    // The section schemas are closed: the parse strips the legacy `mode`
    // key and materializes the section's defaults around the user's values.
    expect("mode" in raw.services["image-generation"]!).toBe(false);
    expect(raw.services["image-generation"]!.provider).toBe("cadet");
    expect("mode" in raw.services["web-search"]!).toBe(false);
    expect(raw.services["web-search"]!.provider).toBe("cadet");
  });
});
