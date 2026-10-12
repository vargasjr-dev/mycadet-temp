/**
 * Boot-time provider_connection backfill: an existing user connection for
 * the entry's provider must win over the mode-derived default.
 *
 * On managed (cloud-hosted) installs the mode default is the billed
 * `cadet` connection — stamping it onto a connection-less BYOK-intent
 * profile permanently routes the user's own-key setup through managed
 * billing. On your-own installs the mode default creates a parallel
 * `<provider>-personal` row with an empty credential slot even when a
 * custom-named connection already exists.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { loadRawConfig } from "../config/loader.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { providerConnections } from "../persistence/schema/index.js";
import { runProviderConnectionsBackfill } from "../providers/inference/backfill.js";
import {
  createConnection,
  getConnection,
  listConnections,
} from "../providers/inference/connections.js";

await initializeDb();

const originalIsPlatform = process.env.IS_CLOUD;

function seedConfig(profiles: Record<string, unknown>): void {
  writeFileSync(
    join(process.env.CADET_WORKSPACE_DIR!, "config.json"),
    JSON.stringify({ llm: { profiles } }),
  );
}

function backfilledConnection(profileName: string): unknown {
  const llm = loadRawConfig().llm as {
    profiles?: Record<string, Record<string, unknown>>;
  };
  return llm.profiles?.[profileName]?.provider_connection;
}

beforeEach(() => {
  getDb().delete(providerConnections).run();
});

afterEach(() => {
  if (originalIsPlatform === undefined) {
    delete process.env.IS_CLOUD;
  } else {
    process.env.IS_CLOUD = originalIsPlatform;
  }
});

test("managed mode prefers an existing user connection over the cadet default", () => {
  process.env.IS_CLOUD = "true";
  const created = createConnection(getDb(), {
    name: "anthropic-personal",
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
  });
  expect(created.ok).toBe(true);
  seedConfig({ byok: { provider: "anthropic", model: "claude-fable-5" } });

  runProviderConnectionsBackfill(getDb());

  expect(backfilledConnection("byok")).toBe("anthropic-personal");
});

test("managed mode still stamps cadet when no user connection exists", () => {
  process.env.IS_CLOUD = "true";
  seedConfig({ byok: { provider: "anthropic", model: "claude-fable-5" } });

  runProviderConnectionsBackfill(getDb());

  expect(backfilledConnection("byok")).toBe("cadet");
});

test("cadet-provider entries take no connection stamp; user entries bind their own", () => {
  process.env.IS_CLOUD = "true";
  const created = createConnection(getDb(), {
    name: "anthropic-personal",
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
  });
  expect(created.ok).toBe(true);
  seedConfig({
    balanced: {
      provider: "cadet",
      model: "claude-sonnet-4-6",
    },
    // A cadet-provider entry is managed-owned: the cadet stamp survives any
    // user connection.
    "quality-optimized": {
      provider: "cadet",
      model: "claude-opus-4-8",
    },
    // A non-cadet provider on a canonical name is a shadow the user took
    // ownership of — the preference applies.
    "cost-optimized": {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    },
    byok: { provider: "anthropic", model: "claude-fable-5" },
  });

  runProviderConnectionsBackfill(getDb());

  // The cadet provider is its own routing identity — no connection stamp;
  // dispatch resolves the row per-request.
  expect(backfilledConnection("balanced")).toBeUndefined();
  expect(backfilledConnection("quality-optimized")).toBeUndefined();
  expect(backfilledConnection("cost-optimized")).toBe("anthropic-personal");
  expect(backfilledConnection("byok")).toBe("anthropic-personal");
});

test("routing-identity providers are never stamped with a connection", () => {
  process.env.IS_CLOUD = "true";
  seedConfig({
    managedRoute: { provider: "cadet", model: "claude-fable-5" },
    subscription: { provider: "chatgpt", model: "gpt-5.5" },
  });

  runProviderConnectionsBackfill(getDb());

  expect(backfilledConnection("managedRoute")).toBeUndefined();
  expect(backfilledConnection("subscription")).toBeUndefined();
});

test("your-own mode reuses a custom-named connection instead of creating -personal", () => {
  delete process.env.IS_CLOUD;
  const created = createConnection(getDb(), {
    name: "my-anthropic",
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
  });
  expect(created.ok).toBe(true);
  seedConfig({ byok: { provider: "anthropic", model: "claude-fable-5" } });

  runProviderConnectionsBackfill(getDb());

  expect(backfilledConnection("byok")).toBe("my-anthropic");
  expect(getConnection(getDb(), "anthropic-personal")).toBeNull();
  // Exactly the user's connection — no parallel row was created.
  expect(
    listConnections(getDb(), { provider: "anthropic" }).map((c) => c.name),
  ).toEqual(["my-anthropic"]);
});
