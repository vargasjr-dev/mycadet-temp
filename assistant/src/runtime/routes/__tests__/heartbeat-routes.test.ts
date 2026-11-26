/**
 * Asserts `setHeartbeatConfig` persists only user-set heartbeat fields to
 * `config.json` and surfaces the resolved (post-default) values via the
 * response payload.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { z } from "zod";

import { invalidateConfigCache } from "../../../config/loader.js";
import { ROUTES } from "../heartbeat-routes.js";
import type { RouteDefinition } from "../types.js";

// ─── Module mocks ──────────────────────────────────────────────────────────

// Stub the heartbeat service so the response-path's getInstance() returns
// undefined (no scheduler running in tests).
mock.module("../../../heartbeat/heartbeat-service.js", () => ({
  HeartbeatService: {
    getInstance: () => undefined,
  },
}));

mock.module("../../../schedule/schedule-timezone.js", () => ({
  resolveScheduleTimezone: (explicit: string | null | undefined) =>
    explicit ?? "America/Los_Angeles",
}));

// ─── Setup ─────────────────────────────────────────────────────────────────

let workspaceDir: string;
let origWorkspaceDir: string | undefined;
let configPath: string;

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cadet-hbr-"));
  origWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
  process.env.CADET_WORKSPACE_DIR = workspaceDir;
  configPath = join(workspaceDir, "config.json");
  invalidateConfigCache();
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.CADET_WORKSPACE_DIR;
  } else {
    process.env.CADET_WORKSPACE_DIR = origWorkspaceDir;
  }
  invalidateConfigCache();
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("setHeartbeatConfig handler", () => {
  test("persists only user-set fields when starting from a config with no heartbeat block", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "anthropic" }, null, 2) + "\n",
    );

    const handler = findHandler("updateHeartbeatConfig");
    const result = z
      .looseObject({
        enabled: z.boolean(),
        intervalMs: z.number(),
        activeHoursStart: z.union([z.null(), z.number()]),
        activeHoursEnd: z.union([z.null(), z.number()]),
        success: z.boolean(),
      })
      .parse(await handler({ body: { enabled: true } }));

    // On-disk: only user-set heartbeat fields, no schema defaults baked in.
    const onDisk = readConfig();
    expect(onDisk).toEqual({
      provider: "anthropic",
      heartbeat: { enabled: true },
    });

    // Response: schema-default intervalMs surfaces, proving cache
    // invalidation + getConfig() read picked up the new on-disk state.
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.intervalMs).toBe(60 * 60_000);
    expect(result.activeHoursStart).toBe(8);
    expect(result.activeHoursEnd).toBe(22);
  });

  test("merges patch into existing heartbeat block instead of overwriting", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ heartbeat: { intervalMs: 60000 } }, null, 2) + "\n",
    );

    const handler = findHandler("updateHeartbeatConfig");
    await handler({ body: { enabled: true } });

    const onDisk = readConfig();
    expect(onDisk).toEqual({
      heartbeat: { intervalMs: 60000, enabled: true },
    });
  });
});

describe("getHeartbeatConfig handler", () => {
  test("returns the resolved timezone separately from the stored override", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ heartbeat: { enabled: true } }, null, 2) + "\n",
    );
    invalidateConfigCache();

    const handler = findHandler("getHeartbeatConfig");
    const result = z
      .looseObject({
        timezone: z.union([z.null(), z.string()]),
        effectiveTimezone: z.union([z.null(), z.string()]),
      })
      .parse(await handler({}));

    expect(result.timezone).toBeNull();
    expect(result.effectiveTimezone).toBe("America/Los_Angeles");
  });
});
