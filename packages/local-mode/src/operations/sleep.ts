import type { LockfileAssistant } from "../lockfile-contract";
import { cliCommand } from "../environment";
import { sleepLocal, type SleepServiceStop } from "../remotes/local/sleep";
import { sleepDocker } from "../remotes/docker/sleep";

/**
 * The sleep OPERATION: the headless core of `cadet sleep`, moved out of the
 * CLI command so the serving hosts answer the scoped surface's sleep POST in
 * process. The command keeps the UX (flag parsing, target resolution, the
 * `--all` loop, narration, exit codes) and delegates; the route in
 * `operations/routes.ts` hands it lockfile entries the host can stop.
 *
 * The operation resolves its own credentials — the drain phase leases a
 * guardian access token through the shared seam (which refreshes a due
 * token against the entry's trusted URL) — callers never thread a token
 * through, mirroring the retire operation's contract.
 */

export type SleepResult =
  | {
      ok: true;
      cancelled?: false;
      kind: "services";
      services: Record<"assistant" | "gateway" | "ces", SleepServiceStop>;
      /** Degradation notes (a skipped drain, an unreachable API) for the UX. */
      notes: string[];
    }
  | { ok: true; cancelled?: false; kind: "containers" }
  | { ok: true; cancelled: true; kind?: undefined }
  | { ok: false; status: number; error: string };

export type { SleepServiceStop };

export interface SleepOptions {
  /** Stop even when an active phone-call keepalive lease holds the assistant. */
  force?: boolean;
  /** Wait for in-flight background work before stopping. */
  wait?: boolean;
  /** Bound for the wait in ms; null waits as long as it takes. */
  waitMs?: number | null;
  /** Aborts the drain — the CLI's Ctrl-C. */
  signal?: AbortSignal;
  /** Progress narration for the long drain wait (headless hosts omit it). */
  log?: (line: string) => void;
}

/**
 * Entry clouds THIS machine can sleep directly: the host owns their process
 * tree (pid-file stops) or their containers. Every other entry (apple-container's
 * app-managed lifecycle, cloud/custom/baseten hosts) is not this host's to
 * stop — the route passes through and the pre-existing chain answers.
 */
export function isHostExecutableSleepEntry(entry: LockfileAssistant): boolean {
  return entry.cloud === "local" || entry.cloud === "docker";
}

/**
 * Sleep one assistant entry: per-cloud stop (the local leg drains then
 * stops the process tree; the docker leg SIGTERMs the containers). Never
 * throws and never exits the process — failures come back structured so
 * both the CLI's exit-code UX and the route's wire mapping render the same
 * detail.
 */
export async function sleepAssistant(
  entry: LockfileAssistant,
  options: SleepOptions = {},
): Promise<SleepResult> {
  try {
    if (entry.cloud === "docker") {
      await sleepDocker(entry.assistantId);
      return { ok: true, kind: "containers" };
    }
    if (entry.cloud === "local") {
      return await sleepLocal(entry, options);
    }
    return {
      ok: false,
      status: 400,
      error: `'${cliCommand()} sleep' only works with local and docker assistants. '${entry.assistantId}' is a ${entry.cloud} instance.`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
