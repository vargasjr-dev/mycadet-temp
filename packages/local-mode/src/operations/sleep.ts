import type { LockfileAssistant } from "../lockfile-contract";
import { cliCommand } from "../environment";
import { isAssistantHealthy } from "../daemon-readiness";
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
      wasRunning: boolean;
    }
  | { ok: true; cancelled?: false; kind: "containers"; wasRunning: boolean }
  | { ok: true; cancelled: true; kind?: undefined; wasRunning: boolean }
  | { ok: false; status: number; error: string; wasRunning: boolean };

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
  // The was-running signal is the gateway's own health probe — remote
  // agnostic — taken once, above the switch, before the stop; every result
  // variant (and the raised structured error) carries it so callers never
  // probe separately.
  const wasRunning = await isAssistantHealthy(entry);
  try {
    if (entry.cloud === "docker") {
      await sleepDocker(entry);
      return { ok: true, kind: "containers", wasRunning };
    }
    if (entry.cloud === "local") {
      return { ...(await sleepLocal(entry, options)), wasRunning };
    }
    return {
      ok: false,
      status: 400,
      error: `'${cliCommand()} sleep' is unsupported for a ${entry.cloud} assistant.`,
      wasRunning,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
      wasRunning,
    };
  }
}
