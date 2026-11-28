/**
 * Degraded-mode coverage for the relocated per-turn memory log tables: with
 * the dedicated memory database unavailable, writes are best-effort no-ops
 * and reads return empty/zero results — nothing throws mid-turn.
 *
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as dbConnection from "../../../../persistence/db-connection.js";
import {
  backfillMemoryRecallLogMessageId,
  getMemoryRecallLogByMessageIds,
  recordMemoryRecallLog,
} from "../memory-recall-log-store.js";
import {
  backfillMemoryV2ActivationMessageId,
  getMemoryV2ActivationLogByMessageIds,
  recordMemoryV2ActivationLog,
} from "../v2/activation-log-store.js";
import { getConceptFrequencySummary } from "../v2/concept-frequency.js";
import { extractOracleTurns } from "../v2/harness/oracle.js";
import { recordInjected } from "../v3/ever-injected-store.js";
import { planPrune } from "../v3/prune.js";
import {
  sampleConcepts,
  sampleConfig,
} from "./fixtures/memory-v2-activation-fixtures.js";

// listPages returns [] for a workspace with no concepts directory.
const WORKSPACE = "/tmp/memory-log-stores-degraded-nonexistent-workspace";

let memorySqliteSpy: ReturnType<typeof mockUnavailableMemory>;

function mockUnavailableMemory() {
  return spyOn(dbConnection, "getMemorySqlite").mockReturnValue(null);
}

beforeEach(() => {
  memorySqliteSpy = mockUnavailableMemory();
});

afterEach(() => {
  memorySqliteSpy.mockRestore();
});

describe("memory log stores without a memory database", () => {
  test("activation-log writes no-op and reads return null", () => {
    expect(() =>
      recordMemoryV2ActivationLog({
        conversationId: "conv-1",
        turn: 1,
        mode: "per-turn",
        concepts: sampleConcepts,
        config: sampleConfig,
      }),
    ).not.toThrow();
    expect(() =>
      backfillMemoryV2ActivationMessageId("conv-1", "msg-1"),
    ).not.toThrow();
    expect(getMemoryV2ActivationLogByMessageIds(["msg-1"])).toBeNull();
  });

  test("recall-log writes no-op and reads return null", () => {
    expect(() =>
      recordMemoryRecallLog({
        conversationId: "conv-1",
        enabled: true,
        degraded: false,
        semanticHits: 1,
        mergedCount: 1,
        selectedCount: 1,
        tier1Count: 1,
        tier2Count: 0,
        hybridSearchLatencyMs: 50,
        sparseVectorUsed: false,
        injectedTokens: 100,
        latencyMs: 80,
        topCandidatesJson: [],
      }),
    ).not.toThrow();
    expect(() =>
      backfillMemoryRecallLogMessageId("conv-1", "msg-1"),
    ).not.toThrow();
    expect(getMemoryRecallLogByMessageIds(["msg-1"])).toBeNull();
  });

  test("concept-frequency degrades to zero counts", async () => {
    const result = await getConceptFrequencySummary(WORKSPACE);
    expect(result.totals).toEqual({ logCount: 0, conceptOccurrences: 0 });
    expect(result.concepts).toEqual([]);
    expect(result.neverEvaluatedSlugs).toEqual([]);
  });

  test("oracle extraction returns no turns", () => {
    expect(extractOracleTurns(dbConnection.getDb())).toEqual([]);
  });
});

describe("memory-v3 prune valve without a memory database", () => {
  // The valve's candidate accounting (`memory_v3_injected_sections`) lives on
  // the memory connection too, degraded by the outer beforeEach. With no
  // resident candidates the valve cannot plan a prune, so it no-ops rather than
  // throwing.
  test("planPrune no-ops (returns null) when candidate accounting is unavailable", () => {
    // The record write is a no-op (memory DB down), so the valve reads no
    // resident entries.
    recordInjected(
      "conv-degraded-prune",
      [{ slug: "domain-a/page-old", key: "", bytes: 600 }],
      1_000,
    );

    let plan: ReturnType<typeof planPrune> | undefined;
    expect(() => {
      plan = planPrune(
        { maxResidentBytes: 1_000, targetResidentBytes: 500 },
        "conv-degraded-prune",
      );
    }).not.toThrow();
    expect(plan).toBeNull();
  });
});
