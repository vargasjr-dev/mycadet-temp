import { beforeEach, describe, expect, mock, test } from "bun:test";

import { z } from "zod";

// Mock the shared `runBackgroundJob` runner so the scheduler's fresh-bootstrap
// talk-mode path stays observable in unit tests. Each invocation creates a new
// conversation row (so `getLastScheduleConversationId` lookups reflect reality)
// and pushes onto a shared log mirrored by the per-test `processMessage`
// callback used for the reuse path — that way assertions don't have to know
// which path a given run took.
const processedMessages: { conversationId: string; message: string }[] = [];
const runBackgroundJobOptions: Array<{
  conversationType?: string;
  scheduleJobId?: string;
  groupId?: string;
  suppressFailureNotifications?: boolean;
  onConversationCreated?: (id: string) => void;
}> = [];
let runBackgroundJobShouldFail = false;
let runBackgroundJobBootstrapFails = false;
// USD of LLM spend the stubbed run records against its cron run, the way real
// usage rows are stamped with `cron_run_id`.
let runBackgroundJobSpendUsd = 0;
mock.module("../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: {
    prompt: string;
    groupId?: string;
    conversationType?: "background" | "scheduled";
    scheduleJobId?: string;
    suppressFailureNotifications?: boolean;
    onConversationCreated?: (id: string) => void;
    cronRunId?: string;
  }) => {
    runBackgroundJobOptions.push({
      conversationType: opts.conversationType,
      scheduleJobId: opts.scheduleJobId,
      groupId: opts.groupId,
      suppressFailureNotifications: opts.suppressFailureNotifications,
      onConversationCreated: opts.onConversationCreated,
    });
    // Bootstrap-failure path: the real runner returns conversationId: ""
    // when `bootstrapConversation` throws before assignment. Skip the
    // callback (it was never reached) and surface the empty id to the
    // scheduler so it can exercise the sentinel guard.
    if (runBackgroundJobBootstrapFails) {
      return {
        conversationId: "",
        ok: false,
        error: new Error("Bootstrap failure"),
        errorKind: "exception" as const,
      };
    }
    const { createConversation } =
      await import("../persistence/conversation-crud.js");
    const conv = createConversation({
      title: "(test stub)",
      conversationType: opts.conversationType ?? "background",
      source: "schedule",
      ...(opts.groupId ? { groupId: opts.groupId } : {}),
      ...(opts.scheduleJobId ? { scheduleJobId: opts.scheduleJobId } : {}),
    });
    // Mirror the real runner's contract: fire the SSE callback synchronously
    // BEFORE the job's processMessage finishes, with the bootstrap-returned
    // conversation id.
    opts.onConversationCreated?.(conv.id);
    processedMessages.push({ conversationId: conv.id, message: opts.prompt });
    if (runBackgroundJobSpendUsd > 0 && opts.cronRunId) {
      const { getSqlite } = await import("../persistence/db-connection.js");
      getSqlite().run(
        `INSERT INTO llm_usage_events
           (id, created_at, cron_run_id, actor, provider, model,
            input_tokens, output_tokens, estimated_cost_usd, pricing_status)
         VALUES (?, ?, ?, 'main_agent', 'test', 'test-model', 0, 0, ?, 'priced')`,
        [
          crypto.randomUUID(),
          Date.now(),
          opts.cronRunId,
          runBackgroundJobSpendUsd,
        ],
      );
    }
    if (runBackgroundJobShouldFail) {
      return {
        conversationId: conv.id,
        ok: false,
        error: new Error("Simulated failure"),
        errorKind: "exception" as const,
      };
    }
    return { conversationId: conv.id, ok: true };
  },
}));

// The scheduler's reuse path dispatches into the existing conversation through
// `processMessage`; capture those calls into the same shared log as the
// fresh-bootstrap runner so assertions don't need to know which path ran. The
// real `processMessage` resolves to `{ messageId, turnFailure? }`, so the mock
// mirrors that shape — the scheduler destructures `turnFailure` off it.
type ProcessMessageResult = {
  messageId: string;
  turnFailure?: { failureCode?: string };
};
const captureProcessedMessage = async (
  conversationId: string,
  message: string,
): Promise<ProcessMessageResult> => {
  processedMessages.push({ conversationId, message });
  return { messageId: "test-message-id" };
};
let processMessageImpl: (
  conversationId: string,
  message: string,
) => Promise<ProcessMessageResult> = captureProcessedMessage;
mock.module("../daemon/process-message.js", () => ({
  processMessage: (conversationId: string, message: string) =>
    processMessageImpl(conversationId, message),
}));

import { loadRawConfig, saveRawConfig } from "../config/loader.js";
import { deleteConversation } from "../persistence/conversation-crud.js";
import { getDb, getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  createSchedule,
  getSchedule,
  getScheduleRuns,
  updateSchedule,
} from "../schedule/schedule-store.js";
import { runDueSchedulesOnce } from "../schedule/scheduler.js";

await initializeDb();

/** Access the underlying bun:sqlite Database for raw parameterized queries. */
function getRawDb(): import("bun:sqlite").Database {
  return getSqlite();
}

/** Force a schedule to be due by setting next_run_at in the past. */
function forceScheduleDue(scheduleId: string): void {
  getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
    Date.now() - 1000,
    scheduleId,
  ]);
}

// Build an RRULE expression anchored at the given start date, recurring every minute.
function buildEveryMinuteRrule(dtstart: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ds = `${dtstart.getUTCFullYear()}${pad(dtstart.getUTCMonth() + 1)}${pad(
    dtstart.getUTCDate(),
  )}T${pad(dtstart.getUTCHours())}${pad(dtstart.getUTCMinutes())}${pad(
    dtstart.getUTCSeconds(),
  )}Z`;
  return `DTSTART:${ds}\nRRULE:FREQ=MINUTELY;INTERVAL=1`;
}

describe("scheduler conversation reuse", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM task_runs");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    processedMessages.length = 0;
    processMessageImpl = captureProcessedMessage;
    runBackgroundJobOptions.length = 0;
    runBackgroundJobShouldFail = false;
    runBackgroundJobBootstrapFails = false;
  });

  test("recurring schedule with reuseConversation=true reuses conversation across runs", async () => {
    /**
     * When a recurring schedule has reuseConversation enabled, the second run
     * should reuse the conversation created by the first run.
     */

    // GIVEN a recurring schedule with reuseConversation enabled
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "Reuse Test",
      cronExpression: rruleExpr,
      message: "Reuse conversation message",
      syntax: "rrule",
      expression: rruleExpr,
      reuseConversation: true,
    });

    // WHEN the schedule fires for the first time
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    // THEN a conversation is created and recorded
    expect(processedMessages).toHaveLength(1);
    const firstConversationId = processedMessages[0].conversationId;
    expect(firstConversationId).toBeTruthy();

    // AND a successful run is recorded
    const runs1 = getScheduleRuns(schedule.id);
    expect(runs1.length).toBe(1);
    expect(runs1[0].status).toBe("ok");
    expect(runs1[0].conversationId).toBe(firstConversationId);

    // WHEN the schedule fires for the second time
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;

    await runDueSchedulesOnce();

    // THEN the same conversation is reused
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].conversationId).toBe(firstConversationId);

    // AND the run references the reused conversation
    const runs2 = getScheduleRuns(schedule.id);
    expect(runs2.length).toBe(2);
    expect(runs2[0].conversationId).toBe(firstConversationId);
  });

  test("recurring schedule defaults to reuseConversation=false", async () => {
    /**
     * When no explicit reuseConversation is provided, recurring schedules
     * default to false — each run gets a fresh conversation. This keeps a
     * weak model's per-run context bounded instead of accumulating a long,
     * self-similar transcript that primes it to repeat or drift; durable
     * cross-run state belongs in workspace files and memory, not history.
     */

    // GIVEN a recurring schedule with no explicit reuseConversation
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "Default Reuse Test",
      cronExpression: rruleExpr,
      message: "Default reuse message",
      syntax: "rrule",
      expression: rruleExpr,
      // no explicit reuseConversation — should default to false
    });

    // WHEN the schedule fires for the first time
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(processedMessages).toHaveLength(1);
    const firstConversationId = processedMessages[0].conversationId;
    expect(firstConversationId).toBeTruthy();

    // WHEN the schedule fires for the second time
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;

    await runDueSchedulesOnce();

    // THEN a fresh conversation is created instead of reusing the first
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].conversationId).not.toBe(firstConversationId);
  });

  test("recurring schedule with reuseConversation=false creates new conversation each run", async () => {
    /**
     * When explicitly opted out, each run creates a brand-new conversation.
     */

    // GIVEN a recurring schedule with reuseConversation explicitly disabled
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "No Reuse Test",
      cronExpression: rruleExpr,
      message: "New conv each run",
      syntax: "rrule",
      expression: rruleExpr,
      reuseConversation: false, // explicitly opt out of conversation reuse
    });

    // WHEN the schedule fires for the first time
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(processedMessages).toHaveLength(1);
    const firstConversationId = processedMessages[0].conversationId;

    // WHEN the schedule fires for the second time
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;

    await runDueSchedulesOnce();

    // THEN a different conversation is created
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].conversationId).not.toBe(firstConversationId);
  });

  test("reuseConversation creates a new conversation when prior one is deleted", async () => {
    /**
     * If the conversation from the last successful run has been deleted,
     * a fresh conversation should be bootstrapped.
     */

    // GIVEN a recurring schedule with reuseConversation enabled that has already run once
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "Deleted Conv Test",
      cronExpression: rruleExpr,
      message: "Handle deleted conv",
      syntax: "rrule",
      expression: rruleExpr,
      reuseConversation: true,
    });

    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(processedMessages).toHaveLength(1);
    const firstConversationId = processedMessages[0].conversationId;

    // AND the conversation is deleted
    deleteConversation(firstConversationId);

    // WHEN the schedule fires again
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;

    await runDueSchedulesOnce();

    // THEN a new conversation is created (not the deleted one)
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].conversationId).not.toBe(firstConversationId);
  });

  test("one-shot schedule ignores reuseConversation flag", async () => {
    /**
     * One-shot schedules always create a new conversation regardless of the
     * reuseConversation flag since they only fire once.
     */

    // GIVEN a one-shot schedule with reuseConversation enabled
    const schedule = await createSchedule({
      name: "One-shot Reuse Ignored",
      message: "One-shot with reuse flag",
      mode: "execute",
      nextRunAt: Date.now() - 1000,
      reuseConversation: true,
      // No expression = one-shot
    });

    // WHEN the schedule fires
    await runDueSchedulesOnce();

    // THEN the message is processed with a new conversation
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].conversationId).toBeTruthy();

    // AND the schedule is marked as fired
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("ok");
  });

  test("reuseConversation uses the conversation from the most recent successful run", async () => {
    /**
     * When multiple runs exist, reuseConversation should pick the conversation
     * from the most recent successful run (not a failed one).
     */

    // GIVEN a recurring schedule with reuseConversation enabled
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "Most Recent Success Test",
      cronExpression: rruleExpr,
      message: "Pick latest success",
      syntax: "rrule",
      expression: rruleExpr,
      reuseConversation: true,
    });

    // AND a first successful run
    forceScheduleDue(schedule.id);

    let shouldFail = false;
    processMessageImpl = async (conversationId, message) => {
      processedMessages.push({ conversationId, message });
      if (shouldFail) {
        throw new Error("Simulated failure");
      }
      return { messageId: "test-message-id" };
    };

    await runDueSchedulesOnce();

    expect(processedMessages).toHaveLength(1);
    const successConversationId = processedMessages[0].conversationId;

    // AND a second run that fails
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;
    shouldFail = true;

    await runDueSchedulesOnce();

    // The failed run created a different conversation (since it failed
    // before the run could reuse — actually it does reuse the same one
    // because the lookup happens before the error). Let's verify the next
    // successful run still uses the original successful conversation.

    // AND a third run that succeeds
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;
    shouldFail = false;

    await runDueSchedulesOnce();

    // THEN the third run reuses the conversation from the first successful run
    // (the lookup queries for status="ok", so it picks the first run's conversation)
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].conversationId).toBe(successConversationId);
  });

  test("reuse path records an error when the turn fails without throwing", async () => {
    /**
     * Regression: an execute-mode LLM call that fails (e.g. an invalid
     * provider) ends the turn without throwing — `processMessage` resolves
     * normally and reports the failure via `turnFailure`. The scheduler must
     * record the run as an error, not "ok".
     */

    // GIVEN a recurring reuse schedule whose first run succeeds
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "Turn Failure Reuse",
      cronExpression: rruleExpr,
      message: "Do the thing",
      syntax: "rrule",
      expression: rruleExpr,
      reuseConversation: true,
    });

    forceScheduleDue(schedule.id);
    await runDueSchedulesOnce();

    const runs1 = getScheduleRuns(schedule.id);
    expect(runs1[0].status).toBe("ok");

    // WHEN the next run's turn fails at the LLM call (reported via turnFailure,
    // no exception thrown)
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;
    processMessageImpl = async (conversationId, message) => {
      processedMessages.push({ conversationId, message });
      return {
        messageId: "test-message-id",
        turnFailure: { failureCode: "provider_error" },
      };
    };

    await runDueSchedulesOnce();

    // THEN the run is recorded as an error (not "ok") and carries the code
    const runs2 = getScheduleRuns(schedule.id);
    expect(runs2.length).toBe(2);
    expect(runs2[0].status).toBe("error");
    expect(runs2[0].error).toContain("provider_error");
  });

  test("reuse path times out a turn that never finishes", async () => {
    /**
     * A wedged reused-conversation turn is bounded by the schedule turn
     * timeout, so it cannot hold the worker (and every other schedule) forever.
     */

    // GIVEN a recurring reuse schedule whose first run succeeds
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "Stuck Reuse",
      cronExpression: rruleExpr,
      message: "Do the thing",
      syntax: "rrule",
      expression: rruleExpr,
      reuseConversation: true,
    });
    forceScheduleDue(schedule.id);
    await runDueSchedulesOnce();

    // AND a 1s turn timeout
    const originalConfig = loadRawConfig();
    saveRawConfig({
      ...originalConfig,
      timeouts: {
        ...z.object({}).passthrough().optional().parse(originalConfig.timeouts),
        scheduleTurnTimeoutSec: 1,
      },
    });

    try {
      // WHEN the next run's turn never finishes
      forceScheduleDue(schedule.id);
      processMessageImpl = () => new Promise<never>(() => {});

      await runDueSchedulesOnce();

      // THEN the run is recorded as a timeout error
      const runs = getScheduleRuns(schedule.id);
      expect(runs.length).toBe(2);
      expect(runs[0].status).toBe("error");
    } finally {
      saveRawConfig(originalConfig);
    }
  }, 10_000);
});

describe("scheduler talk-mode runner option propagation", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    processedMessages.length = 0;
    processMessageImpl = captureProcessedMessage;
    runBackgroundJobOptions.length = 0;
    runBackgroundJobShouldFail = false;
    runBackgroundJobBootstrapFails = false;
  });

  test("talk-mode propagates conversationType=scheduled and scheduleJobId", async () => {
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "Quiet Talk Mode",
      cronExpression: rruleExpr,
      message: "Background work",
      syntax: "rrule",
      expression: rruleExpr,
      quiet: true,
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(runBackgroundJobOptions).toHaveLength(1);
    const opts = runBackgroundJobOptions[0]!;
    expect(opts.conversationType).toBe("scheduled");
    expect(opts.scheduleJobId).toBe(schedule.id);
    expect(opts.groupId).toBe("system:scheduled");
  });

  test("talk-mode always suppresses the runner's per-attempt failure emission", async () => {
    // The retry policy owns the single user-facing alert for a failing
    // schedule (fired once, at exhaustion), so the runner must stay quiet
    // per attempt whether or not the schedule itself is quiet.
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "Loud Talk Mode",
      cronExpression: rruleExpr,
      message: "Background work",
      syntax: "rrule",
      expression: rruleExpr,
      // quiet defaults to false
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(runBackgroundJobOptions).toHaveLength(1);
    expect(runBackgroundJobOptions[0]!.suppressFailureNotifications).toBe(true);
  });

  test("talk-mode bootstrap failure writes sentinel conversationId, not empty string", async () => {
    /**
     * Regression: `runBackgroundJob` returns `{ conversationId: "", ok: false }`
     * when bootstrap throws before the conversation row is assigned. The
     * scheduler previously stored that empty string in the cron_runs DB row.
     * Guard ensures we substitute a recognizable sentinel.
     */
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "Bootstrap Failure",
      cronExpression: rruleExpr,
      message: "x",
      syntax: "rrule",
      expression: rruleExpr,
    });
    forceScheduleDue(schedule.id);
    runBackgroundJobBootstrapFails = true;

    await runDueSchedulesOnce();

    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("error");
    // Critical: must NOT be empty — the DB column should carry a marker that
    // identifies this run as a bootstrap-failure case.
    expect(runs[0].conversationId).not.toBe("");
    expect(runs[0].conversationId).toBe(`bootstrap-error:${schedule.id}`);
  });

  test("talk-mode fires onScheduleConversationCreated synchronously via runner callback (BEFORE the runner returns)", async () => {
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "SSE timing",
      cronExpression: rruleExpr,
      message: "x",
      syntax: "rrule",
      expression: rruleExpr,
    });
    forceScheduleDue(schedule.id);

    const sseCalls: Array<{
      conversationId: string;
      scheduleJobId: string;
      title: string;
    }> = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        if (event.message.type === "schedule_conversation_created") {
          sseCalls.push({
            conversationId: event.message.conversationId,
            scheduleJobId: event.message.scheduleJobId,
            title: event.message.title,
          });
        }
      },
    });
    await runDueSchedulesOnce();
    subscription.dispose();

    expect(sseCalls).toHaveLength(1);
    expect(sseCalls[0]).toMatchObject({
      scheduleJobId: schedule.id,
      title: "SSE timing",
    });
    // The mock runner fires the callback synchronously after creating the
    // conversation row, so the conversationId must be the same id the runner
    // ultimately reports.
    expect(processedMessages).toHaveLength(1);
    expect(sseCalls[0].conversationId).toBe(
      processedMessages[0].conversationId,
    );
  });
});

describe("scheduler per-run spending limit", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM llm_usage_events");
    processedMessages.length = 0;
    processMessageImpl = captureProcessedMessage;
    runBackgroundJobOptions.length = 0;
    runBackgroundJobShouldFail = false;
    runBackgroundJobBootstrapFails = false;
    runBackgroundJobSpendUsd = 0;
  });

  async function createRecurringSchedule(name: string) {
    const rruleExpr = buildEveryMinuteRrule();
    return createSchedule({
      name,
      cronExpression: rruleExpr,
      message: "Summarize the day",
      syntax: "rrule",
      expression: rruleExpr,
    });
  }

  test("a run that spends past its limit fails and pauses the schedule instead of retrying", async () => {
    // GIVEN a recurring schedule limited to $1.00 per run
    const schedule = await createRecurringSchedule("Costly digest");
    await updateSchedule(schedule.id, { maxRunCostUsd: 1 });

    // WHEN a run spends $2.50
    runBackgroundJobSpendUsd = 2.5;
    forceScheduleDue(schedule.id);
    await runDueSchedulesOnce();

    // THEN the run is recorded as an error naming the spend and the limit
    const runs = getScheduleRuns(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("error");
    expect(runs[0].error).toContain("$2.50");
    expect(runs[0].error).toContain("$1.00");

    // AND the schedule is paused, so it does not run again even when due
    expect(getSchedule(schedule.id)?.enabled).toBe(false);
    forceScheduleDue(schedule.id);
    await runDueSchedulesOnce();
    expect(getScheduleRuns(schedule.id)).toHaveLength(1);
  });

  test("a run within its limit completes normally", async () => {
    // GIVEN a recurring schedule limited to $5.00 per run
    const schedule = await createRecurringSchedule("Cheap digest");
    await updateSchedule(schedule.id, { maxRunCostUsd: 5 });

    // WHEN a run spends $2.00
    runBackgroundJobSpendUsd = 2;
    forceScheduleDue(schedule.id);
    await runDueSchedulesOnce();

    // THEN the run succeeds and the schedule stays enabled
    expect(getScheduleRuns(schedule.id)[0].status).toBe("ok");
    expect(getSchedule(schedule.id)?.enabled).toBe(true);
  });

  test("a schedule without a limit is never stopped for spend", async () => {
    // GIVEN a recurring schedule with no limit
    const schedule = await createRecurringSchedule("Unlimited digest");
    expect(schedule.maxRunCostUsd).toBeNull();

    // WHEN a run spends $100.00
    runBackgroundJobSpendUsd = 100;
    forceScheduleDue(schedule.id);
    await runDueSchedulesOnce();

    // THEN the run succeeds and the schedule stays enabled
    expect(getScheduleRuns(schedule.id)[0].status).toBe("ok");
    expect(getSchedule(schedule.id)?.enabled).toBe(true);
  });

  test("a run that times out and overspends keeps the timeout as the first error", async () => {
    /**
     * First error wins: the overspend is read after the run ends, so a run
     * that already failed for another reason keeps that reason. The overspend
     * text must not overwrite it, and the timeout path — not the cost stop —
     * owns the outcome.
     */

    // GIVEN a recurring reuse schedule limited to $1.00 per run whose first
    // run succeeds and creates the reused conversation
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = await createSchedule({
      name: "Timeout overspend",
      cronExpression: rruleExpr,
      message: "Do the thing",
      syntax: "rrule",
      expression: rruleExpr,
      reuseConversation: true,
    });
    await updateSchedule(schedule.id, { maxRunCostUsd: 1 });
    forceScheduleDue(schedule.id);
    await runDueSchedulesOnce();

    // AND a 1s turn timeout for the next firing
    const originalConfig = loadRawConfig();
    saveRawConfig({
      ...originalConfig,
      timeouts: {
        ...z.object({}).passthrough().optional().parse(originalConfig.timeouts),
        scheduleTurnTimeoutSec: 1,
      },
    });

    try {
      // WHEN the next run's turn never finishes but spends $2.50 while it runs
      processMessageImpl = async (conversationId: string) => {
        const { getSqlite } = await import("../persistence/db-connection.js");
        const runId = getScheduleRuns(schedule.id)[0]?.id;
        if (runId) {
          getSqlite().run(
            `INSERT INTO llm_usage_events
               (id, created_at, cron_run_id, actor, provider, model,
                input_tokens, output_tokens, estimated_cost_usd, pricing_status)
             VALUES (?, ?, ?, 'main_agent', 'test', 'test-model', 0, 0, ?, 'priced')`,
            [crypto.randomUUID(), Date.now(), runId, 2.5],
          );
        }
        processedMessages.push({ conversationId, message: "Do the thing" });
        return new Promise<never>(() => {});
      };

      forceScheduleDue(schedule.id);
      await runDueSchedulesOnce();

      // THEN the recorded error is the timeout, not the overspend
      const runs = getScheduleRuns(schedule.id);
      expect(runs).toHaveLength(2);
      expect(runs[0].status).toBe("error");
      expect(runs[0].error).toContain("time limit");
      expect(runs[0].error).not.toContain("$2.50");

      // AND the schedule is not paused — the cost stop never took the run
      expect(getSchedule(schedule.id)?.enabled).toBe(true);
    } finally {
      saveRawConfig(originalConfig);
      processMessageImpl = captureProcessedMessage;
    }
  }, 10_000);
});
