/**
 * Tests for the retention-derived cadence of the scheduled cleanup jobs.
 *
 * `maybeEnqueueScheduledCleanupJobs` enqueues each prune job on a cadence
 * equal to that job's own retention window, and throttles each job
 * independently: LLM-request-log pruning follows `llmRequestLogRetentionMs`,
 * conversation pruning follows `conversationRetentionDays`, and audit-log
 * (`tool_invocations`) pruning follows `auditLog.retentionDays`.
 *
 * The real cleanup-schedule-state module (pure, in-memory, no DB) provides the
 * per-job throttle; jobs-store's enqueue functions, the checkpoint store (which
 * persists each enqueue so the cadence survives restarts), and the logger are
 * mocked so we can observe which jobs were enqueued on each tick and what was
 * persisted.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { AssistantConfig } from "../config/schema.js";
import {
  deleteMemoryCheckpoint,
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../persistence/checkpoints.js";
import { resetCleanupScheduleThrottle } from "../persistence/cleanup-schedule-state.js";
import { getMemoryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { memoryJobs } from "../persistence/schema/index.js";

beforeAll(async () => {
  await initializeDb();
});
import {
  maybeEnqueueScheduledCleanupJobs,
  seedCleanupScheduleFromCheckpoints,
} from "../plugins/defaults/memory/jobs-worker.js";

const CONV_CHECKPOINT_KEY = "cleanup:last_enqueue:conversations";
const LLM_CHECKPOINT_KEY = "cleanup:last_enqueue:llm_request_logs";
const TOOL_CHECKPOINT_KEY = "cleanup:last_enqueue:tool_invocations";

// Enqueue decisions are observed through the REAL persisted artifacts: each
// firing stamps its per-job checkpoint with the tick's nowMs (a skipped job
// leaves its checkpoint untouched), and the retention argument lands on the
// deduped prune job row's payload.
const lastEnqueueMs = (key: string): number | null => {
  const raw = getMemoryCheckpoint(key);
  return raw === null ? null : Number(raw);
};

const jobPayload = (
  type:
    | "prune_old_conversations"
    | "prune_old_llm_request_logs"
    | "prune_old_tool_invocations",
): Record<string, unknown> => {
  const db = getMemoryDb();
  if (!db) {
    return {};
  }
  const row = db
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .get();
  if (!row) {
    return {};
  }
  try {
    return JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const HOUR = 60 * 60 * 1000;

// A realistic epoch-ms base. In production `nowMs` is `Date.now()`, which is
// always astronomically larger than any retention window, so after a throttle
// reset (last enqueue = 0) every due job fires on the first tick. Anchoring the
// tests at a real timestamp mirrors that; using 0 would make `now - last` too
// small to clear long retention windows.
const BASE = 1_700_000_000_000;

function makeConfig(opts: {
  enabled?: boolean;
  conversationRetentionDays?: number;
  llmRequestLogRetentionMs?: number | null;
  auditLogRetentionDays?: number;
}): AssistantConfig {
  return {
    memory: {
      cleanup: {
        enabled: opts.enabled ?? true,
        conversationRetentionDays: opts.conversationRetentionDays ?? 0,
        llmRequestLogRetentionMs:
          opts.llmRequestLogRetentionMs === undefined
            ? null
            : opts.llmRequestLogRetentionMs,
      },
    },
    auditLog: { retentionDays: opts.auditLogRetentionDays ?? 0 },
  } as unknown as AssistantConfig;
}

describe("maybeEnqueueScheduledCleanupJobs retention-derived cadence", () => {
  beforeEach(() => {
    // Real rows persist across tests — clear the three per-job checkpoints
    // so every test starts from a cold schedule.
    deleteMemoryCheckpoint(CONV_CHECKPOINT_KEY);
    deleteMemoryCheckpoint(LLM_CHECKPOINT_KEY);
    deleteMemoryCheckpoint(TOOL_CHECKPOINT_KEY);
    resetCleanupScheduleThrottle();
  });

  test("LLM-log prune fires once per retention window", () => {
    const config = makeConfig({ llmRequestLogRetentionMs: HOUR });

    // First tick fires immediately (throttle starts at 0).
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE)).toBe(true);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE);
    expect(jobPayload("prune_old_llm_request_logs").retentionMs).toBe(HOUR);

    // Half a window later: not due, nothing enqueued.
    expect(
      maybeEnqueueScheduledCleanupJobs(config, BASE + 30 * 60 * 1000),
    ).toBe(false);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE);

    // Just past the full window: due again.
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE + HOUR + 1)).toBe(
      true,
    );
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE + HOUR + 1);
  });

  test("each prune throttles independently on its own retention", () => {
    const config = makeConfig({
      conversationRetentionDays: 1, // 1 day
      llmRequestLogRetentionMs: HOUR, // 1 hour
    });

    // t=0: both due.
    maybeEnqueueScheduledCleanupJobs(config, BASE);
    expect(lastEnqueueMs(CONV_CHECKPOINT_KEY)).toBe(BASE);
    expect(jobPayload("prune_old_conversations").retentionDays).toBe(1);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE);

    // t=2h: LLM window (1h) elapsed, conversation window (1d) has not.
    maybeEnqueueScheduledCleanupJobs(config, BASE + 2 * HOUR);
    expect(lastEnqueueMs(CONV_CHECKPOINT_KEY)).toBe(BASE);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE + 2 * HOUR);

    // t=25h: conversation window now elapsed too.
    maybeEnqueueScheduledCleanupJobs(config, BASE + 25 * HOUR);
    expect(lastEnqueueMs(CONV_CHECKPOINT_KEY)).toBe(BASE + 25 * HOUR);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE + 25 * HOUR);
  });

  test("tool_invocations prune follows auditLog.retentionDays", () => {
    const config = makeConfig({ auditLogRetentionDays: 1 }); // 1 day

    maybeEnqueueScheduledCleanupJobs(config, BASE);
    expect(lastEnqueueMs(TOOL_CHECKPOINT_KEY)).toBe(BASE);
    expect(jobPayload("prune_old_tool_invocations").retentionDays).toBe(1);

    // 12h later: within the 1-day window.
    maybeEnqueueScheduledCleanupJobs(config, BASE + 12 * HOUR);
    expect(lastEnqueueMs(TOOL_CHECKPOINT_KEY)).toBe(BASE);

    // 25h later: past the window.
    maybeEnqueueScheduledCleanupJobs(config, BASE + 25 * HOUR);
    expect(lastEnqueueMs(TOOL_CHECKPOINT_KEY)).toBe(BASE + 25 * HOUR);
  });

  test("disabled cleanup enqueues nothing", () => {
    const config = makeConfig({
      enabled: false,
      conversationRetentionDays: 1,
      llmRequestLogRetentionMs: HOUR,
      auditLogRetentionDays: 1,
    });

    expect(maybeEnqueueScheduledCleanupJobs(config, BASE)).toBe(false);
    expect(lastEnqueueMs(CONV_CHECKPOINT_KEY)).toBeNull();
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBeNull();
    expect(lastEnqueueMs(TOOL_CHECKPOINT_KEY)).toBeNull();
  });

  test("null LLM-log retention keeps logs forever (no prune enqueued)", () => {
    const config = makeConfig({ llmRequestLogRetentionMs: null });

    expect(maybeEnqueueScheduledCleanupJobs(config, BASE)).toBe(false);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBeNull();
  });

  test("zero LLM-log retention disables pruning and never busy-loops", () => {
    // A retention of 0 makes the cadence interval 0, so `isDue` would be true
    // on every tick. Guard against the resulting runaway enqueue loop: 0 must
    // enqueue nothing, on the first tick and on every subsequent one.
    const config = makeConfig({ llmRequestLogRetentionMs: 0 });

    expect(maybeEnqueueScheduledCleanupJobs(config, BASE)).toBe(false);
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE + 1)).toBe(false);
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE + 60_000)).toBe(false);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBeNull();
  });

  test("zero conversation retention disables pruning and never busy-loops", () => {
    // Same 0-window cadence trap as LLM logs: interval 0 → `isDue` always
    // true. The `> 0` guard must hold across ticks so nothing is enqueued.
    const config = makeConfig({ conversationRetentionDays: 0 });

    expect(maybeEnqueueScheduledCleanupJobs(config, BASE)).toBe(false);
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE + 1)).toBe(false);
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE + 60_000)).toBe(false);
    expect(lastEnqueueMs(CONV_CHECKPOINT_KEY)).toBeNull();
  });

  test("zero audit-log retention disables pruning and never busy-loops", () => {
    // Same 0-window cadence trap for tool_invocations (auditLog.retentionDays).
    const config = makeConfig({ auditLogRetentionDays: 0 });

    expect(maybeEnqueueScheduledCleanupJobs(config, BASE)).toBe(false);
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE + 1)).toBe(false);
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE + 60_000)).toBe(false);
    expect(lastEnqueueMs(TOOL_CHECKPOINT_KEY)).toBeNull();
  });

  test("resetCleanupScheduleThrottle makes every job due on the next tick", () => {
    const config = makeConfig({
      conversationRetentionDays: 30,
      llmRequestLogRetentionMs: HOUR,
      auditLogRetentionDays: 30,
    });

    maybeEnqueueScheduledCleanupJobs(config, BASE);
    expect(lastEnqueueMs(CONV_CHECKPOINT_KEY)).toBe(BASE);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE);
    expect(lastEnqueueMs(TOOL_CHECKPOINT_KEY)).toBe(BASE);

    // Without a reset, a tick a minute later re-enqueues nothing (all windows
    // are far from elapsed).
    maybeEnqueueScheduledCleanupJobs(config, BASE + 60_000);
    expect(lastEnqueueMs(CONV_CHECKPOINT_KEY)).toBe(BASE);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE);
    expect(lastEnqueueMs(TOOL_CHECKPOINT_KEY)).toBe(BASE);

    // A retention-settings change resets the throttle; the very next tick
    // re-enqueues every job regardless of its window.
    resetCleanupScheduleThrottle();
    maybeEnqueueScheduledCleanupJobs(config, BASE + 120_000);
    expect(lastEnqueueMs(CONV_CHECKPOINT_KEY)).toBe(BASE + 120_000);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE + 120_000);
    expect(lastEnqueueMs(TOOL_CHECKPOINT_KEY)).toBe(BASE + 120_000);
  });
});

describe("cleanup schedule persistence across restarts", () => {
  beforeEach(() => {
    // Real rows persist across tests — clear the three per-job checkpoints
    // so every test starts from a cold schedule.
    deleteMemoryCheckpoint(CONV_CHECKPOINT_KEY);
    deleteMemoryCheckpoint(LLM_CHECKPOINT_KEY);
    deleteMemoryCheckpoint(TOOL_CHECKPOINT_KEY);
    resetCleanupScheduleThrottle();
  });

  test("each enqueue persists its timestamp to a per-job checkpoint", () => {
    const config = makeConfig({
      conversationRetentionDays: 1,
      llmRequestLogRetentionMs: HOUR,
      auditLogRetentionDays: 1,
    });

    maybeEnqueueScheduledCleanupJobs(config, BASE);

    expect(getMemoryCheckpoint(CONV_CHECKPOINT_KEY)).toBe(String(BASE));
    expect(getMemoryCheckpoint(LLM_CHECKPOINT_KEY)).toBe(String(BASE));
    expect(getMemoryCheckpoint(TOOL_CHECKPOINT_KEY)).toBe(String(BASE));
  });

  test("seeding from checkpoints resumes the cadence instead of re-firing", () => {
    // Simulate a prior run at BASE that persisted its checkpoint, then a
    // restart: reset the in-memory throttle (as a fresh process would start)
    // and seed from the persisted checkpoint.
    setMemoryCheckpoint(LLM_CHECKPOINT_KEY, String(BASE));
    resetCleanupScheduleThrottle();
    seedCleanupScheduleFromCheckpoints();

    const config = makeConfig({ llmRequestLogRetentionMs: HOUR });

    // 30 min after the persisted enqueue: still within the window, so a boot
    // tick does NOT re-fire (the pre-persistence behavior would have fired
    // because the throttle started at 0).
    expect(
      maybeEnqueueScheduledCleanupJobs(config, BASE + 30 * 60 * 1000),
    ).toBe(false);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE);

    // Past the window: due again.
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE + HOUR + 1)).toBe(
      true,
    );
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE + HOUR + 1);
  });

  test("a job with no checkpoint fires on the first tick (never run yet)", () => {
    // No checkpoints present — seeding is a no-op and the throttle stays 0.
    seedCleanupScheduleFromCheckpoints();

    const config = makeConfig({ conversationRetentionDays: 30 });

    expect(maybeEnqueueScheduledCleanupJobs(config, BASE)).toBe(true);
    expect(jobPayload("prune_old_conversations").retentionDays).toBe(30);
    expect(getMemoryCheckpoint(CONV_CHECKPOINT_KEY)).toBe(String(BASE));
  });

  test("seeding ignores malformed or non-positive checkpoint values", () => {
    setMemoryCheckpoint(LLM_CHECKPOINT_KEY, "not-a-number");
    setMemoryCheckpoint(CONV_CHECKPOINT_KEY, "0");
    resetCleanupScheduleThrottle();
    seedCleanupScheduleFromCheckpoints();

    const config = makeConfig({
      conversationRetentionDays: 30,
      llmRequestLogRetentionMs: HOUR,
    });

    // Both seeds were rejected, so the throttle is still 0 and both fire.
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE)).toBe(true);
    expect(lastEnqueueMs(CONV_CHECKPOINT_KEY)).toBe(BASE);
    expect(lastEnqueueMs(LLM_CHECKPOINT_KEY)).toBe(BASE);
  });
});
