/**
 * Direct terminals for tool-execution auditing.
 *
 * The executor and its permission/approval collaborators call these functions
 * inline as each tool call reaches a terminal outcome (executed / error /
 * denied). Each function owns exactly one side effect:
 *
 *   - `recordToolExecuted` / `recordToolError` / `recordToolDenied` write the
 *     always-on `tool_invocations` audit row (redacting secrets from the
 *     stored input/result).
 *   - `logToolFailure` emits the operator-facing failure log.
 *
 * The payload-size + model-attribution columns are part of the local audit
 * row — `tool_invocations` is a local always-on audit log and nothing in it
 * ever leaves the device.
 */

import { redactJsonStringLeaves } from "../security/redact-json.js";
import { redactSensitiveFields } from "../security/redaction.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { stringifyToolInput } from "../tools/types.js";
import {
  toAttributionColumns,
  type UsageAttributionColumns,
  type UsageAttributionSnapshot,
} from "../usage/attribution.js";
import { getLogger } from "../util/logger.js";
import {
  recordToolInvocation,
  type ToolInvocationRecord,
} from "./tool-usage-store.js";

const RESULT_PREVIEW_LIMIT = 1000;
const log = getLogger("tool-audit");

interface ExecutedAuditEntry {
  conversationId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Raw (pre-sanitization) result content shown to the model. */
  resultContent: string;
  /**
   * Byte size of the RAW result content, measured before sensitive-output
   * extraction rewrites it. Only the size leaves the device, never the payload.
   */
  resultBytes: number;
  decision: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
  /** Model attribution at invocation time; `null` when unavailable. */
  attribution: UsageAttributionSnapshot | null;
}

interface ErrorAuditEntry {
  conversationId: string;
  requestId?: string;
  toolName: string;
  input: Record<string, unknown>;
  errorMessage: string;
  /** True for anticipated failures (abort, permission denial, tool errors). */
  isExpected: boolean;
  errorName?: string;
  errorStack?: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
  attribution: UsageAttributionSnapshot | null;
}

interface DeniedAuditEntry {
  conversationId: string;
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
}

/** Record an audit row for a tool that ran to completion. */
export function recordToolExecuted(entry: ExecutedAuditEntry): void {
  const rawInput = stringifyToolInput(entry.input);
  safeRecord({
    conversationId: entry.conversationId,
    toolName: entry.toolName,
    // Inputs can carry secrets the model typed verbatim (e.g.
    // `export OPENAI_API_KEY=...` in a bash command) — redact before the row
    // reaches the audit store, like the result below.
    input: redactToolInput(entry.input, rawInput),
    result: redactSecrets(entry.resultContent).slice(0, RESULT_PREVIEW_LIMIT),
    decision: entry.decision,
    riskLevel: entry.riskLevel,
    matchedTrustRuleId: entry.matchedTrustRuleId,
    durationMs: entry.durationMs,
    ...telemetryColumns(entry.attribution, rawInput, entry.resultBytes),
  });
}

/** Record an audit row and operator log for a tool that failed. */
export function recordToolError(entry: ErrorAuditEntry): void {
  const rawInput = stringifyToolInput(entry.input);
  const result = `error: ${entry.errorMessage}`;
  safeRecord({
    conversationId: entry.conversationId,
    toolName: entry.toolName,
    input: redactToolInput(entry.input, rawInput),
    result,
    decision: "error",
    riskLevel: entry.riskLevel,
    matchedTrustRuleId: entry.matchedTrustRuleId,
    durationMs: entry.durationMs,
    // The error string is built here and never goes through sensitive-output
    // sanitization, so sizing it directly is already raw.
    ...telemetryColumns(
      entry.attribution,
      rawInput,
      Buffer.byteLength(result, "utf8"),
    ),
  });

  logToolFailure(entry);
}

/** Record an audit row for a tool call blocked before execution. */
export function recordToolDenied(entry: DeniedAuditEntry): void {
  safeRecord({
    conversationId: entry.conversationId,
    toolName: entry.toolName,
    input: redactToolInput(entry.input, stringifyToolInput(entry.input)),
    result: formatDeniedResult(entry.reason),
    decision: "denied",
    riskLevel: entry.riskLevel,
    matchedTrustRuleId: entry.matchedTrustRuleId,
    durationMs: entry.durationMs,
    // No telemetry columns: the tool never executed, and denied rows are
    // filtered out of the tool_executed projection anyway.
  });
}

/** Operator-facing failure log: warn for expected failures, error otherwise. */
function logToolFailure(entry: ErrorAuditEntry): void {
  const meta = {
    tool: entry.toolName,
    execDurationMs: entry.durationMs,
    riskLevel: entry.riskLevel,
    decision: "error",
    error: entry.errorMessage,
    errorName: entry.errorName,
    errorStack: entry.errorStack,
    isExpected: entry.isExpected,
    conversationId: entry.conversationId,
    requestId: entry.requestId,
  };
  if (entry.isExpected) {
    log.warn(meta, "Tool execution failed (expected)");
    return;
  }
  log.error(meta, "Tool execution error");
}

function safeRecord(record: ToolInvocationRecord): void {
  try {
    recordToolInvocation(record);
  } catch (err) {
    log.warn(
      { err, toolName: record.toolName },
      "Failed to record tool invocation",
    );
  }
}

/**
 * Redact secrets from a tool input while keeping the stored audit string
 * parseable JSON. Two passes, both structural (before stringification, so the
 * markers land inside JSON string values with their quotes escaped):
 *
 *  1. Field-key redaction (`redactSensitiveFields`): values under sensitive
 *     KEYS (`password`, `token`, `apiKey`, …) are replaced regardless of
 *     whether the value itself matches a secret pattern — e.g. `password:
 *     "hunter2"` or `value: "…"`, which a pattern scan alone would miss.
 *  2. Pattern redaction (`redactJsonStringLeaves`): secret-shaped values in the
 *     remaining string leaves (API keys, tokens the model typed verbatim).
 *
 * `rawInput` is the canonical pre-redaction serialization (also used for the
 * `argBytes` telemetry fallback — byte sizes must reflect the full payload
 * before truncation and redaction). It is returned untouched when neither pass
 * changed anything, keeping benign inputs byte-identical, and is redacted as
 * plain text if the input can't be walked or re-serialized (e.g. cyclic
 * structures).
 */
function redactToolInput(
  input: Record<string, unknown>,
  rawInput: string,
): string {
  try {
    const fieldRedacted = redactSensitiveFields(input);
    const { value } = redactJsonStringLeaves(fieldRedacted);
    const serialized = JSON.stringify(value);
    return serialized === rawInput ? rawInput : serialized;
  } catch {
    return redactSecrets(rawInput);
  }
}

type TelemetryColumns = Pick<ToolInvocationRecord, "argBytes" | "resultBytes"> &
  UsageAttributionColumns;

/**
 * Payload sizes + model attribution, part of the local audit row.
 */
function telemetryColumns(
  attribution: UsageAttributionSnapshot | null,
  rawInput: string,
  resultBytes: number,
): TelemetryColumns {
  return {
    argBytes: Buffer.byteLength(rawInput, "utf8"),
    resultBytes,
    ...toAttributionColumns(attribution),
  };
}

function formatDeniedResult(reason: string): string {
  if (reason.startsWith("Blocked by deny rule:")) {
    return `denied: ${reason}`;
  }
  return "denied";
}
