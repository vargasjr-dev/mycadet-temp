/**
 * Shared test helpers for the `acp_session_history` table.
 *
 * Several suites (session-manager resume/persistence, the ACP route
 * handlers) seed and read history rows directly via SQL; this module
 * consolidates the copy-pasted row shape + insert/read/clear helpers.
 * Tests must run `initializeDb()` themselves before calling these.
 */

import { eq } from "drizzle-orm";

import { getDb, getSqlite } from "../../../persistence/db-connection.js";
import { acpSessionHistory } from "../../../persistence/schema/acp.js";

/** Raw column snapshot of an `acp_session_history` row. */
export interface HistoryRow {
  id: string;
  agent_id: string;
  acp_session_id: string;
  parent_conversation_id: string;
  started_at: number;
  completed_at: number | null;
  status: string;
  stop_reason: string | null;
  error: string | null;
  event_log_json: string;
  cwd: string | null;
  task: string | null;
  parent_tool_use_id: string | null;
  used_tokens: number | null;
  context_size: number | null;
  cost_amount: number | null;
  cost_currency: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  auth_error_code: string | null;
  auth_error_credential: string | null;
}

export function clearHistory(): void {
  getSqlite().run("DELETE FROM acp_session_history");
}

/**
 * Inserts a history row. Every field except `id` defaults to the values
 * the resume suites were built around (a completed claude run in
 * /tmp/proj); pass explicit values to override, including `null` where the
 * column is nullable (e.g. `cwd: null` for legacy rows).
 */
export function insertHistoryRow(row: {
  id: string;
  agentId?: string;
  acpSessionId?: string;
  parentConversationId?: string;
  startedAt?: number;
  completedAt?: number | null;
  status?: string;
  stopReason?: string | null;
  error?: string | null;
  eventLogJson?: string;
  cwd?: string | null;
  task?: string | null;
  parentToolUseId?: string | null;
  usedTokens?: number | null;
  contextSize?: number | null;
  costAmount?: number | null;
  costCurrency?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  authErrorCode?: string | null;
  authErrorCredential?: string | null;
}): void {
  getSqlite()
    .query(
      `INSERT INTO acp_session_history (
         id, agent_id, acp_session_id, parent_conversation_id,
         started_at, completed_at, status, stop_reason, error,
         event_log_json, cwd, task, parent_tool_use_id,
         used_tokens, context_size, cost_amount, cost_currency,
         input_tokens, output_tokens, auth_error_code, auth_error_credential
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.agentId ?? "claude",
      row.acpSessionId ?? "proto-old",
      row.parentConversationId ?? "conv-1",
      row.startedAt ?? 1234,
      row.completedAt === undefined ? 5678 : row.completedAt,
      row.status ?? "completed",
      row.stopReason === undefined ? "end_turn" : row.stopReason,
      row.error ?? null,
      row.eventLogJson ?? "[]",
      row.cwd === undefined ? "/tmp/proj" : row.cwd,
      row.task ?? null,
      row.parentToolUseId ?? null,
      row.usedTokens ?? null,
      row.contextSize ?? null,
      row.costAmount ?? null,
      row.costCurrency ?? null,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      row.authErrorCode ?? null,
      row.authErrorCredential ?? null,
    );
}

export function readHistoryRow(id: string): HistoryRow | null {
  return (
    getDb()
      .select({
        id: acpSessionHistory.id,
        agent_id: acpSessionHistory.agentId,
        acp_session_id: acpSessionHistory.acpSessionId,
        parent_conversation_id: acpSessionHistory.parentConversationId,
        started_at: acpSessionHistory.startedAt,
        completed_at: acpSessionHistory.completedAt,
        status: acpSessionHistory.status,
        stop_reason: acpSessionHistory.stopReason,
        error: acpSessionHistory.error,
        event_log_json: acpSessionHistory.eventLogJson,
        cwd: acpSessionHistory.cwd,
        task: acpSessionHistory.task,
        parent_tool_use_id: acpSessionHistory.parentToolUseId,
        used_tokens: acpSessionHistory.usedTokens,
        context_size: acpSessionHistory.contextSize,
        cost_amount: acpSessionHistory.costAmount,
        cost_currency: acpSessionHistory.costCurrency,
        input_tokens: acpSessionHistory.inputTokens,
        output_tokens: acpSessionHistory.outputTokens,
        auth_error_code: acpSessionHistory.authErrorCode,
        auth_error_credential: acpSessionHistory.authErrorCredential,
      })
      .from(acpSessionHistory)
      .where(eq(acpSessionHistory.id, id))
      .get() ?? null
  );
}
