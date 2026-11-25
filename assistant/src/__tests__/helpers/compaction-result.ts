import type { ContextWindowResult } from "../../plugins/defaults/compaction/window-manager.js";

export function makeCompactionResult(
  overrides: Partial<ContextWindowResult> = {},
): ContextWindowResult {
  return {
    messages: [],
    compacted: false,
    previousEstimatedInputTokens: 0,
    estimatedInputTokens: 0,
    maxInputTokens: 200_000,
    thresholdTokens: 160_000,
    compactedMessages: 0,
    compactedPersistedMessages: 0,
    summaryCalls: 0,
    summaryInputTokens: 0,
    summaryOutputTokens: 0,
    summaryModel: "",
    summaryText: "",
    ...overrides,
  };
}
