/**
 * Typed persistence for the workflow orchestration engine.
 *
 * Two tables (created by migration 282):
 *
 * - `workflow_runs` — one row per orchestration run (a sandboxed script that
 *   spawns parallel leaf agents), tracking lifecycle status and token usage.
 * - `workflow_journal` — append-only `(run_id, seq)` log of every leaf call
 *   (agent / host function / nested workflow). On resume after a daemon
 *   restart, the engine replays cached results for the unchanged call prefix
 *   instead of re-spawning agents.
 *
 * This module is pure persistence — no `workflows` feature-flag logic. Callers
 * (the engine, a later PR) own gating.
 */

import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { rawChanges } from "../persistence/raw-query.js";
import { workflowJournal } from "../persistence/schema/workflows.js";
import { workflowRuns } from "../persistence/schema/workflows.js";

export type WorkflowRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "cap_exceeded"
  | "interrupted";

/**
 * The journal records leaf-agent calls (`"agent"`) and nested `workflow()`
 * resolutions (`"workflow"`). A `"workflow"` entry snapshots the resolved child
 * source under its own `seq` so a resumed run re-executes the SAME child code
 * the original launch did, even if the saved workflow was since edited or
 * deleted. The column stays TEXT so adding kinds later needs no migration.
 */
export type WorkflowJournalKind = "agent" | "workflow";

/** A persisted workflow run row, with JSON columns parsed into values. */
export interface WorkflowRun {
  id: string;
  name: string | null;
  scriptSource: string;
  scriptHash: string;
  args: unknown;
  capabilities: unknown;
  status: WorkflowRunStatus;
  conversationId: string | null;
  /**
   * Originating trust context (parsed), or null for legacy rows written before
   * the column existed. Reconstructed on resume so a run never resumes with more
   * trust than it started under — see {@link CreateRunInput.trust}.
   */
  trust: unknown;
  agentsSpawned: number;
  inputTokens: number;
  outputTokens: number;
  result: unknown;
  error: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  finishedAt: number | null;
}

/** A persisted journal entry, with JSON columns parsed into values. */
export interface WorkflowJournalEntry {
  runId: string;
  seq: number;
  callHash: string;
  kind: WorkflowJournalKind;
  request: unknown;
  result: unknown;
  status: string;
  /** Per-leaf token usage for a completed agent leaf; undefined otherwise. */
  inputTokens?: number;
  outputTokens?: number;
  createdAt: number | null;
}

export interface CreateRunInput {
  id: string;
  name?: string | null;
  scriptSource: string;
  scriptHash: string;
  args?: unknown;
  capabilities?: unknown;
  status?: WorkflowRunStatus;
  conversationId?: string | null;
  /**
   * Originating trust context (trust metadata — `{ sourceChannel, trustClass,
   * ... }`, no secret material), serialized so a crash-orphaned run can
   * reconstruct the exact trust class it started under when resumed. Omit on
   * legacy callers; resume then falls back to low trust, never guardian.
   */
  trust?: unknown;
}

export interface UpdateRunInput {
  status?: WorkflowRunStatus;
  agentsSpawned?: number;
  inputTokens?: number;
  outputTokens?: number;
  conversationId?: string | null;
}

export interface FinishRunInput {
  status: WorkflowRunStatus;
  result?: unknown;
  error?: string | null;
}

export interface AppendJournalEntryInput {
  runId: string;
  seq: number;
  callHash: string;
  kind: WorkflowJournalKind;
  request?: unknown;
  result?: unknown;
  status: string;
  /** Per-leaf token usage; set for a completed agent leaf, omitted otherwise. */
  inputTokens?: number;
  outputTokens?: number;
}

// ---------------------------------------------------------------------------
// Row shapes + mappers
// ---------------------------------------------------------------------------

type WorkflowRunRow = typeof workflowRuns.$inferSelect;
type WorkflowJournalRow = typeof workflowJournal.$inferSelect;

/** Parse a nullable JSON column; malformed values collapse to null. */
function parseJsonColumn(value: string | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Serialize a value for a nullable JSON column. `undefined` stores as null. */
function serializeJsonColumn(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    name: row.name,
    scriptSource: row.scriptSource,
    scriptHash: row.scriptHash,
    args: parseJsonColumn(row.argsJson),
    capabilities: parseJsonColumn(row.capabilitiesJson),
    status: row.status as WorkflowRunStatus,
    conversationId: row.conversationId,
    trust: parseJsonColumn(row.trustJson),
    agentsSpawned: row.agentsSpawned,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    result: parseJsonColumn(row.resultJson),
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

function rowToJournalEntry(row: WorkflowJournalRow): WorkflowJournalEntry {
  return {
    runId: row.runId,
    seq: row.seq,
    callHash: row.callHash,
    kind: row.kind as WorkflowJournalKind,
    request: parseJsonColumn(row.requestJson),
    result: parseJsonColumn(row.resultJson),
    status: row.status,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Runs — write
// ---------------------------------------------------------------------------

/** Insert a new workflow run. Defaults status to `running`. */
export function createRun(input: CreateRunInput): WorkflowRun {
  const now = Date.now();
  const status = input.status ?? "running";
  getDb()
    .insert(workflowRuns)
    .values({
      id: input.id,
      name: input.name ?? null,
      scriptSource: input.scriptSource,
      scriptHash: input.scriptHash,
      argsJson: serializeJsonColumn(input.args),
      capabilitiesJson: serializeJsonColumn(input.capabilities),
      status,
      conversationId: input.conversationId ?? null,
      trustJson: serializeJsonColumn(input.trust),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getRun(input.id)!;
}

/**
 * Patch mutable fields on a run and bump `updated_at`. Only the fields present
 * in `input` are written. Returns the updated run, or null if it doesn't exist.
 */
export function updateRun(
  runId: string,
  input: UpdateRunInput,
): WorkflowRun | null {
  // Drizzle skips columns whose value is `undefined`, so only the fields
  // present in `input` (plus the updated_at bump) are written.
  getDb()
    .update(workflowRuns)
    .set({
      status: input.status,
      agentsSpawned: input.agentsSpawned,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      conversationId: input.conversationId,
      updatedAt: Date.now(),
    })
    .where(eq(workflowRuns.id, runId))
    .run();
  return getRun(runId);
}

/**
 * Mark a run terminal: set its final status, result/error payload, and stamp
 * both `updated_at` and `finished_at`. Returns the updated run, or null if it
 * doesn't exist.
 */
export function finishRun(
  runId: string,
  input: FinishRunInput,
): WorkflowRun | null {
  const now = Date.now();
  getDb()
    .update(workflowRuns)
    .set({
      status: input.status,
      resultJson: serializeJsonColumn(input.result),
      error: input.error ?? null,
      updatedAt: now,
      finishedAt: now,
    })
    .where(eq(workflowRuns.id, runId))
    .run();
  return getRun(runId);
}

// ---------------------------------------------------------------------------
// Journal — write
// ---------------------------------------------------------------------------

/**
 * Append a leaf-call entry to a run's journal, upserting on `(run_id, seq)`.
 *
 * A genuine duplicate re-append (same hash/result — the crash-recovery case
 * where a write replays after a crash between the call and its journal write)
 * is idempotent: the conflicting row is overwritten with identical values.
 *
 * On resume, a leaf whose input CHANGED re-runs and produces a new
 * hash/result/status at the same `seq`; the UPSERT rewrites the stale first-run
 * row so the persisted journal agrees with the value the engine returned (and
 * the call doesn't re-run on every future resume). `created_at` is left at its
 * original value on conflict so the row keeps its first-write timestamp.
 */
export function appendJournalEntry(
  input: AppendJournalEntryInput,
): WorkflowJournalEntry {
  getDb()
    .insert(workflowJournal)
    .values({
      runId: input.runId,
      seq: input.seq,
      callHash: input.callHash,
      kind: input.kind,
      requestJson: serializeJsonColumn(input.request),
      resultJson: serializeJsonColumn(input.result),
      status: input.status,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      createdAt: Date.now(),
    })
    // `created_at` is deliberately absent from the update set so the row
    // keeps its first-write timestamp on conflict.
    .onConflictDoUpdate({
      target: [workflowJournal.runId, workflowJournal.seq],
      set: {
        callHash: sql`excluded.call_hash`,
        kind: sql`excluded.kind`,
        requestJson: sql`excluded.request_json`,
        resultJson: sql`excluded.result_json`,
        status: sql`excluded.status`,
        inputTokens: sql`excluded.input_tokens`,
        outputTokens: sql`excluded.output_tokens`,
      },
    })
    .run();
  return getJournalEntry(input.runId, input.seq)!;
}

// ---------------------------------------------------------------------------
// Runs + journal — read
// ---------------------------------------------------------------------------

/** Fetch a single run by id, or null if it doesn't exist. */
export function getRun(runId: string): WorkflowRun | null {
  const row = getDb()
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .get();
  return row ? rowToRun(row) : null;
}

/** Fetch a run's full journal in sequence order for resume replay. */
export function getJournal(runId: string): WorkflowJournalEntry[] {
  return getDb()
    .select()
    .from(workflowJournal)
    .where(eq(workflowJournal.runId, runId))
    .orderBy(asc(workflowJournal.seq))
    .all()
    .map(rowToJournalEntry);
}

export interface ListRunsOptions {
  limit: number;
  status?: WorkflowRunStatus;
}

/** List runs newest-first, optionally filtered by status. */
export function listRuns(options: ListRunsOptions): WorkflowRun[] {
  const rows = options.status
    ? getDb()
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.status, options.status))
        .orderBy(desc(workflowRuns.createdAt))
        .limit(options.limit)
        .all()
    : getDb()
        .select()
        .from(workflowRuns)
        .orderBy(desc(workflowRuns.createdAt))
        .limit(options.limit)
        .all();
  return rows.map(rowToRun);
}

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

/**
 * Flip every `running` run to `interrupted`. Called once at daemon startup: a
 * row left in `running` means the process died mid-run (nothing else can leave
 * a row `running` after the engine exits, which always finishes it). Marking it
 * `interrupted` makes it eligible for an explicit resume.
 *
 * STATUS ONLY — `agents_spawned`/`input_tokens`/`output_tokens` are NOT touched.
 * The run row is the source of truth for ACCOUNTING (it seeds the resumed run's
 * cap counters) while the journal is the source of truth for REPLAY; rewriting
 * the counters here would drift the cap accounting. Returns the number of rows
 * reconciled.
 */
export function markRunningAsInterrupted(): number {
  getDb()
    .update(workflowRuns)
    .set({ status: "interrupted", updatedAt: Date.now() })
    .where(eq(workflowRuns.status, "running"))
    .run();
  return rawChanges();
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Set of genuinely TERMINAL run statuses — the only rows `pruneRuns` may reap.
 * A run is non-terminal (and therefore retained regardless of age) when it is
 * still `running` OR `interrupted`: an `interrupted` run is a crash-orphaned
 * row awaiting an explicit resume, so pruning it would destroy resumability.
 */
const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  "completed",
  "failed",
  "aborted",
  "cap_exceeded",
];

/**
 * Delete TERMINAL runs older than `retentionDays` (by `created_at`) and their
 * journal entries. Non-terminal runs are never pruned, regardless of age:
 * `running` rows could be reaped out from under the engine, and `interrupted`
 * rows are crash-orphaned and still resumable — deleting either would destroy
 * an in-flight or resumable run. Returns the number of runs deleted.
 */
export function pruneRuns(retentionDays: number): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const terminalRuns = getDb()
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        inArray(workflowRuns.status, [...TERMINAL_RUN_STATUSES]),
        isNotNull(workflowRuns.createdAt),
        lt(workflowRuns.createdAt, cutoff),
      ),
    );
  getDb()
    .delete(workflowJournal)
    .where(inArray(workflowJournal.runId, terminalRuns))
    .run();
  getDb()
    .delete(workflowRuns)
    .where(inArray(workflowRuns.id, terminalRuns))
    .run();
  return rawChanges();
}

/** Fetch a single journal entry by its `(run_id, seq)` key, or null. */
export function getJournalEntry(
  runId: string,
  seq: number,
): WorkflowJournalEntry | null {
  const row = getDb()
    .select()
    .from(workflowJournal)
    .where(and(eq(workflowJournal.runId, runId), eq(workflowJournal.seq, seq)))
    .get();
  return row ? rowToJournalEntry(row) : null;
}
