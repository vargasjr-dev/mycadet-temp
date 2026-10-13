import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { pruneOldConversationsJob } from "../persistence/job-handlers/cleanup.js";
import type { MemoryJob } from "../persistence/jobs-store.js";
import { conversations, toolInvocations } from "../persistence/schema/index.js";

// Prune fires the `conversation-deleted` hook per pruned id; the memory
// plugin's hook is what purges the relocated per-conversation tables. That
// cascade is covered directly in the memory plugin's
// `conversation-memory-purge.test.ts`, so this suite only asserts the
// persistence-owned deletes.
await initializeDb();

const STALE_ID = "conv-prune-job-stale";
const FRESH_ID = "conv-prune-job-fresh";

const JOB = { payload: {} } as unknown as MemoryJob;
const CONFIG = {
  memory: { cleanup: { conversationRetentionDays: 30 } },
} as unknown as AssistantConfig;

function seedConversation(id: string, updatedAt: number): void {
  const db = getDb();
  db.insert(conversations)
    .values({ id, title: "test", createdAt: updatedAt, updatedAt })
    .run();
  db.insert(toolInvocations)
    .values({
      id: `ti-${id}`,
      conversationId: id,
      toolName: "calendar_list_events",
      input: "{}",
      result: "{}",
      decision: "allow",
      riskLevel: "low",
      durationMs: 12,
      createdAt: updatedAt,
    })
    .run();
}

function countRows(conversationId: string): { invocations: number } {
  const db = getDb();
  return {
    invocations: db
      .select()
      .from(toolInvocations)
      .all()
      .filter((r) => r.conversationId === conversationId).length,
  };
}

describe("pruneOldConversationsJob", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(toolInvocations).run();
    db.delete(conversations).run();
  });

  test("deletes non-cascading rows for pruned conversations only", () => {
    const staleUpdatedAt = Date.now() - 60 * 86_400_000;
    seedConversation(STALE_ID, staleUpdatedAt);
    seedConversation(FRESH_ID, Date.now());

    pruneOldConversationsJob(JOB, CONFIG);

    expect(countRows(STALE_ID)).toEqual({ invocations: 0 });
    expect(countRows(FRESH_ID)).toEqual({ invocations: 1 });
    const remaining = getDb().select().from(conversations).all();
    expect(remaining.map((c) => c.id)).toEqual([FRESH_ID]);
  });

  test("retentionDays of 0 is a no-op (keep forever)", () => {
    const ancientUpdatedAt = Date.now() - 999 * 86_400_000;
    seedConversation(STALE_ID, ancientUpdatedAt);

    pruneOldConversationsJob(JOB, {
      memory: { cleanup: { conversationRetentionDays: 0 } },
    } as unknown as AssistantConfig);

    const remaining = getDb().select().from(conversations).all();
    expect(remaining.map((c) => c.id)).toEqual([STALE_ID]);
  });
});
