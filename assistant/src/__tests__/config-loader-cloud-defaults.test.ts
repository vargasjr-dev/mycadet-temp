/**
 * When IS_CLOUD=true and no config.json exists yet, loadConfig() must
 * write all managed-capable service modes as "managed" instead of the
 * per-service schema default. When IS_CLOUD is absent/false, or when
 * config.json already exists, the Zod schema defaults and existing values
 * are preserved unchanged — note that `google-oauth` and `notion-oauth`
 * default to "managed" at the schema level (per JARVIS-966), while every
 * other managed-capable service defaults to "your-own".
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.CADET_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

afterAll(() => {
  mock.restore();
});

import { invalidateConfigCache, loadConfig } from "../config/loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "memory", "knowledge"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

function resetWorkspace(): void {
  if (existsSync(WORKSPACE_DIR)) {
    for (const name of readdirSync(WORKSPACE_DIR)) {
      rmSync(join(WORKSPACE_DIR, name), { recursive: true, force: true });
    }
  }
  ensureTestDir();
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

// When IS_CLOUD=true, every managed-capable service defaults to "managed".
// Without IS_CLOUD, services split by Zod schema default: google/notion-oauth
// resolve to "managed" (per JARVIS-966), the rest resolve to "your-own".
// web-search is deliberately absent: `provider` is its only axis, so the
// platform context injects no mode for it. image-generation is also absent:
// its managed axis is the provider ("cadet" proxies through the cloud),
// so the cloud context fills `provider: "cadet"` rather than a mode.
const MANAGED_SERVICES = [
  "google-oauth",
  "outlook-oauth",
  "linear-oauth",
  "github-oauth",
  "notion-oauth",
] as const;

/**
 * Services whose Zod schema default is `"managed"` rather than `"your-own"`.
 * For these, the fresh-write and in-memory paths produce `"managed"` even
 * when IS_CLOUD is false/unset — the schema default applies regardless of
 * deployment context. See `assistant/src/config/schemas/services.ts` and
 * JARVIS-966: managed mode is the optimization target for new users on
 * managed-capable infra, since the BYO flow requires a Google Cloud /
 * Notion integration setup that most users never complete.
 */
const SCHEMA_MANAGED_DEFAULT_SERVICES = [
  "google-oauth",
  "notion-oauth",
] as const;

// web-search is absent from both lists: it carries no mode at all.
// image-generation and web-search are absent from both lists: they carry
// no mode at all.
const SCHEMA_YOUR_OWN_DEFAULT_SERVICES = [
  "outlook-oauth",
  "linear-oauth",
  "github-oauth",
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cloud-managed config defaults", () => {
  const originalIsPlatform = process.env.IS_CLOUD;

  beforeEach(() => {
    resetWorkspace();
    invalidateConfigCache();
  });

  afterEach(() => {
    invalidateConfigCache();
    // Restore env to its original value
    if (originalIsPlatform === undefined) {
      delete process.env.IS_CLOUD;
    } else {
      process.env.IS_CLOUD = originalIsPlatform;
    }
  });

  test("IS_CLOUD=true, no config file → all 6 cloud service modes written as 'managed', image-generation provider written as 'cadet'", () => {
    process.env.IS_CLOUD = "true";

    loadConfig();

    expect(existsSync(CONFIG_PATH)).toBe(true);
    const written = readConfig() as { services?: Record<string, unknown> };
    expect(written.services).toBeDefined();
    const services = written.services!;
    for (const svc of MANAGED_SERVICES) {
      expect((services[svc] as { mode?: string })?.mode).toBe("managed");
    }
    expect((services["web-search"] as { provider?: string })?.provider).toBe(
      "inference-provider-native",
    );
    // image-generation's managed axis is its provider: the cloud context
    // fills "cadet" and never injects a cloud mode (the persisted mode is
    // the schema default).
    const imageGen = services["image-generation"] as {
      provider?: string;
      mode?: string;
    };
    expect(imageGen?.provider).toBe("cadet");
    expect(imageGen?.mode).not.toBe("managed");
  });

  test("IS_CLOUD=false, no config file → service modes follow schema defaults (your-own except google/notion-oauth which are managed)", () => {
    process.env.IS_CLOUD = "false";

    loadConfig();

    expect(existsSync(CONFIG_PATH)).toBe(true);
    const written = readConfig() as { services?: Record<string, unknown> };
    expect(written.services).toBeDefined();
    const services = written.services!;
    for (const svc of SCHEMA_YOUR_OWN_DEFAULT_SERVICES) {
      expect((services[svc] as { mode?: string })?.mode).toBe("your-own");
    }
    for (const svc of SCHEMA_MANAGED_DEFAULT_SERVICES) {
      expect((services[svc] as { mode?: string })?.mode).toBe("managed");
    }
  });

  test("IS_CLOUD unset, no config file → service modes follow schema defaults (your-own except google/notion-oauth which are managed)", () => {
    delete process.env.IS_CLOUD;

    loadConfig();

    expect(existsSync(CONFIG_PATH)).toBe(true);
    const written = readConfig() as { services?: Record<string, unknown> };
    expect(written.services).toBeDefined();
    const services = written.services!;
    for (const svc of SCHEMA_YOUR_OWN_DEFAULT_SERVICES) {
      expect((services[svc] as { mode?: string })?.mode).toBe("your-own");
    }
    for (const svc of SCHEMA_MANAGED_DEFAULT_SERVICES) {
      expect((services[svc] as { mode?: string })?.mode).toBe("managed");
    }
  });

  test("IS_CLOUD=true, config file already exists → existing service mode values are preserved", () => {
    process.env.IS_CLOUD = "true";

    // Write an existing config with image-generation mode explicitly set to "your-own"
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          services: {
            "image-generation": { mode: "your-own" },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig();

    const written = readConfig() as { services?: Record<string, unknown> };
    expect(written.services).toBeDefined();
    // The raw value must be preserved — backfill path, not fresh-write path.
    // (Migration 134 rewrites this legacy shape at daemon startup; the loader
    // itself must simply leave it alone.)
    expect(
      (written.services!["image-generation"] as { mode?: string })?.mode,
    ).toBe("your-own");
    // The parsed config strips the legacy key and carries the filled
    // provider; no mode survives the schema.
    expect(config.services["image-generation"]).not.toHaveProperty("mode");
    expect(config.services["image-generation"].provider).toBe("cadet");
  });

  test("IS_CLOUD=true, config file with explicit notion-oauth mode='your-own' → preserved (schema default is 'managed')", () => {
    process.env.IS_CLOUD = "true";

    // notion-oauth's schema default is "managed" (per JARVIS-966), but an
    // explicit user choice of "your-own" must win — the fill-defaults pass
    // must never override an explicit value, even one that contradicts the
    // schema default. Mirror of the image-generation "your-own preserved"
    // test above, but for a service whose schema default is "managed".
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          services: {
            "notion-oauth": { mode: "your-own" },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig();

    const written = readConfig() as { services?: Record<string, unknown> };
    expect(written.services).toBeDefined();
    expect((written.services!["notion-oauth"] as { mode?: string })?.mode).toBe(
      "your-own",
    );
    expect(config.services["notion-oauth"].mode).toBe("your-own");
  });

  test("IS_CLOUD=true, config file exists without a services key → in-memory config has all managed modes", () => {
    // Regression guard for the cloud-managed boot order: by the time
    // `loadConfig()` runs, lifecycle steps such as `seedInferenceProfiles`
    // have already written `config.json` (with `llm.profiles` etc.), so
    // `configFileExisted` is true even on a brand-new cloud-managed
    // assistant. Deployment-context defaults must still be applied to the
    // in-memory config for any leaf keys that are absent from disk.
    process.env.IS_CLOUD = "true";

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          llm: {
            profiles: {
              balanced: { provider: "anthropic", model: "claude-sonnet-4.5" },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig();

    // In-memory config has the deployment-context defaults applied for the
    // missing service-mode fields.
    for (const svc of MANAGED_SERVICES) {
      expect(
        (config.services as unknown as Record<string, { mode: string }>)[svc]!
          .mode,
      ).toBe("managed");
    }
    // ...and for image-generation's provider, whose fill is "cadet".
    expect(config.services["image-generation"].provider).toBe("cadet");

    // The on-disk file is NOT modified by the fill pass — disk reflects only
    // what was already there. Existing-file branch never re-writes config.json.
    const onDisk = readConfig() as Record<string, unknown>;
    expect(onDisk["services"]).toBeUndefined();
  });

  test("IS_CLOUD=true, config file exists with an explicit image-generation provider → provider wins over the cadet fill", () => {
    process.env.IS_CLOUD = "true";

    // User has an explicit BYOK image-generation provider on disk. The fill
    // pass targets exactly that leaf (`provider: "cadet"`), so the explicit
    // value must win and no mode is injected — the effective mode is the
    // schema default.
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          services: {
            "image-generation": { provider: "openai" },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig();

    const imageGen = (
      config.services as unknown as Record<
        string,
        { mode?: string; provider?: string }
      >
    )["image-generation"]!;
    expect(imageGen.provider).toBe("openai");
    expect(imageGen).not.toHaveProperty("mode");
  });

  test("IS_CLOUD=false, config file exists without services key → in-memory config keeps schema defaults (your-own except google/notion-oauth which are managed)", () => {
    // Sanity guard: deployment-context defaults are a no-op when IS_CLOUD
    // is not enabled, regardless of whether config.json existed. The Zod
    // schema defaults still apply, so google-oauth and notion-oauth resolve
    // to "managed" while the remaining services resolve to "your-own".
    process.env.IS_CLOUD = "false";

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          llm: {
            profiles: {
              balanced: { provider: "anthropic", model: "claude-sonnet-4.5" },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig();

    for (const svc of SCHEMA_YOUR_OWN_DEFAULT_SERVICES) {
      expect(
        (config.services as unknown as Record<string, { mode: string }>)[svc]!
          .mode,
      ).toBe("your-own");
    }
    for (const svc of SCHEMA_MANAGED_DEFAULT_SERVICES) {
      expect(
        (config.services as unknown as Record<string, { mode: string }>)[svc]!
          .mode,
      ).toBe("managed");
    }
  });
});
