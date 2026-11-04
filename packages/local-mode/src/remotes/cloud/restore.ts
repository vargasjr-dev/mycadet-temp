/**
 * The cloud restore leg: push a root archive through the cloud's migration
 * API and let the platform own the restore. The bundle uploads through a
 * signed URL, then a preflight (the dry-run) or the import runs server-side
 * — the import may be async (202 + job id), in which case the leg polls the
 * job to completion. The client never opens cloud storage and never reads
 * cloud state directly: every platform call rides the entry's gateway
 * address, which proxies the migration routes.
 */

import { readFileSync } from "node:fs";

import type { LockfileAssistant } from "../../lockfile-contract";
import { getGatewayUrl } from "../../lockfile-contract";
import { readCloudToken } from "../../cloud-auth";
import { cliCommand } from "../../environment";
import { validateRootArchive } from "../../root-backup";
import {
  cloudPollJobStatus,
  cloudRequestSignedUrl,
  platformImportBundleFromGcs,
  platformImportPreflightFromGcs,
  platformUploadToSignedUrl,
  VersionMismatchError,
} from "./migrations";

/** The dry-run report: what a real import would change. */
export interface CloudRestorePreflight {
  filesToCreate: number;
  filesToOverwrite: number;
  filesUnchanged: number;
  totalFiles: number;
  conflicts: string[];
  files: { path: string; action: string }[];
}

/** The import report: what the restore changed. */
export interface CloudRestoreImport {
  filesCreated: number;
  filesOverwritten: number;
  filesSkipped: number;
  backupsCreated: number;
  warnings: string[];
}

export type CloudRestoreResult =
  | { ok: true; dryRun: true; preflight: CloudRestorePreflight }
  | { ok: true; dryRun: false; import: CloudRestoreImport }
  | { ok: false; status: number; error: string };

interface StructuredError {
  code: string;
  message: string;
  path?: string;
}

interface PreflightResponse {
  can_import: boolean;
  validation?: { is_valid: false; errors: StructuredError[] };
  files?: { path: string; action: string }[];
  summary?: {
    files_to_create: number;
    files_to_overwrite: number;
    files_unchanged: number;
    total_files: number;
  };
  conflicts?: StructuredError[];
}

interface ImportResponse {
  success: boolean;
  reason?: string;
  message?: string;
  errors?: StructuredError[];
  warnings?: string[];
  summary?: {
    total_files: number;
    files_created: number;
    files_overwritten: number;
    files_skipped: number;
    backups_created: number;
  };
}

const LOGIN_REFRESH_ERROR = () =>
  `Authentication failed. Run '${cliCommand()} login' to refresh.`;

/**
 * Map the platform's per-call failure codes onto the structured refusal the
 * operation hands its callers (the CLI's exit UX and any host's wire
 * mapping render the same detail).
 */
function platformFailure(
  statusCode: number,
  name: string,
): { ok: false; status: number; error: string } {
  if (statusCode === 401 || statusCode === 403) {
    return { ok: false, status: 401, error: LOGIN_REFRESH_ERROR() };
  }
  if (statusCode === 404) {
    return {
      ok: false,
      status: 404,
      error: "No cloud assistant found. Ensure your assistant is running.",
    };
  }
  if (statusCode === 409) {
    return {
      ok: false,
      status: 409,
      error:
        "Multiple assistants found. This is a Cadet Cloud configuration issue.",
    };
  }
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return {
      ok: false,
      status: statusCode,
      error: `Assistant is unreachable. Try '${cliCommand()} wake ${name}' first.`,
    };
  }
  return {
    ok: false,
    status: statusCode,
    error: `Cloud restore failed (${statusCode}).`,
  };
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

/**
 * The cloud restore leg. `fromPath` is a validated root archive; the leg
 * uploads it and drives the platform's preflight-or-import. `log` carries
 * long-wait narration (poll retries, elapsed time) — the CLI's UX line.
 * Structured refusals only — failures never throw except for the terminal
 * version mismatch (the caller's wizard surfaces it verbatim).
 */
export async function restoreCloud(
  entry: LockfileAssistant,
  opts: {
    fromPath: string;
    dryRun: boolean;
    /** Progress narration for the long import wait (headless hosts omit it). */
    log?: (line: string) => void;
  },
): Promise<CloudRestoreResult> {
  const token = readCloudToken();
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: `Not logged in. Run '${cliCommand()} login' first.`,
    };
  }

  try {
    await validateRootArchive(opts.fromPath);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const gatewayUrl = getGatewayUrl(entry);
  const bundleData = readFileSync(opts.fromPath);

  // Upload the root archive through the cloud API; it owns cloud restore.
  let bundleKey: string;
  try {
    const { url, bundleKey: key } = await cloudRequestSignedUrl(
      {
        operation: "upload",
        contentType: "application/gzip",
        contentLength: bundleData.length,
      },
      token,
      gatewayUrl,
    );
    bundleKey = key;
    await platformUploadToSignedUrl(url, new Uint8Array(bundleData));
  } catch (err) {
    if (err instanceof VersionMismatchError) throw err;
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (opts.dryRun) {
    let preflightResult: {
      statusCode: number;
      body: Record<string, unknown>;
    };
    try {
      preflightResult = await platformImportPreflightFromGcs(
        bundleKey,
        token,
        gatewayUrl,
      );
    } catch (err) {
      if (isTimeout(err)) {
        return {
          ok: false,
          status: 504,
          error: "Preflight request timed out after 30 minutes.",
        };
      }
      return {
        ok: false,
        status: 502,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (preflightResult.statusCode !== 200) {
      return platformFailure(preflightResult.statusCode, entry.assistantId);
    }

    const result = preflightResult.body as unknown as PreflightResponse;
    if (!result.can_import) {
      const details = [
        ...(result.validation?.errors ?? []).map(
          (e) => `${e.message}${e.path ? ` (${e.path})` : ""}`,
        ),
        ...(result.conflicts ?? []).map(
          (c) => `${c.message}${c.path ? ` (${c.path})` : ""}`,
        ),
      ];
      return {
        ok: false,
        status: 409,
        error: `Import blocked: ${details.join("; ")}`,
      };
    }

    const summary = result.summary ?? {
      files_to_create: 0,
      files_to_overwrite: 0,
      files_unchanged: 0,
      total_files: 0,
    };
    return {
      ok: true,
      dryRun: true,
      preflight: {
        filesToCreate: summary.files_to_create,
        filesToOverwrite: summary.files_to_overwrite,
        filesUnchanged: summary.files_unchanged,
        totalFiles: summary.total_files,
        conflicts: (result.conflicts ?? []).map((c) => c.message),
        files: result.files ?? [],
      },
    };
  }

  // Data import — may be async (202 + job id), in which case poll.
  let importResult: { statusCode: number; body: Record<string, unknown> };
  try {
    importResult = await platformImportBundleFromGcs(
      bundleKey,
      token,
      gatewayUrl,
    );
  } catch (err) {
    if (isTimeout(err)) {
      return {
        ok: false,
        status: 504,
        error: "Import request timed out after 30 minutes.",
      };
    }
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (
    importResult.statusCode !== 202 &&
    (importResult.statusCode < 200 || importResult.statusCode >= 300)
  ) {
    return platformFailure(importResult.statusCode, entry.assistantId);
  }

  if (importResult.statusCode === 202) {
    const jobId = (importResult.body as { job_id?: string }).job_id;
    if (!jobId) {
      return {
        ok: false,
        status: 502,
        error: "Import accepted but no job ID returned.",
      };
    }

    const POLL_INTERVAL_MS = 5_000;
    const TIMEOUT_MS = 10 * 60 * 1_000;
    const startTime = Date.now();
    const deadline = startTime + TIMEOUT_MS;
    let completed = false;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      let status: Awaited<ReturnType<typeof cloudPollJobStatus>>;
      try {
        status = await cloudPollJobStatus(jobId, token, gatewayUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Terminal: missing job, auth failures, any 4xx. Transient
        // (5xx, network) failures retry until the deadline.
        if (
          msg.includes("not found") ||
          msg.includes("401") ||
          msg.includes("403")
        ) {
          return {
            ok: false,
            status: 502,
            error: `Import job failed: ${msg}`,
          };
        }
        const statusMatch = msg.match(/status check failed: (\d+)/);
        if (
          statusMatch &&
          parseInt(statusMatch[1]!, 10) >= 400 &&
          parseInt(statusMatch[1]!, 10) < 500
        ) {
          return {
            ok: false,
            status: 502,
            error: `Import job failed: ${msg}`,
          };
        }
        opts.log?.(`Polling failed: ${msg}. Retrying...`);
        continue;
      }

      if (status.status === "complete") {
        importResult = {
          statusCode: 200,
          body: (status.result as Record<string, unknown>) ?? {},
        };
        completed = true;
        break;
      }

      if (status.status === "failed") {
        return {
          ok: false,
          status: 502,
          error: `Import failed: ${status.error ?? "unknown error"}`,
        };
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      opts.log?.(`Importing... ${elapsed}s elapsed`);
    }

    if (!completed) {
      return {
        ok: false,
        status: 504,
        error: "Import timed out after 10 minutes.",
      };
    }
  }

  const result = importResult.body as unknown as ImportResponse;
  if (!result.success) {
    const details = (result.errors ?? [])
      .map((e) => `${e.message}${e.path ? ` (${e.path})` : ""}`)
      .join("; ");
    return {
      ok: false,
      status: 502,
      error: `Import failed — ${result.message ?? result.reason ?? "unknown reason"}${details ? `: ${details}` : ""}`,
    };
  }

  const summary = result.summary ?? {
    files_created: 0,
    files_overwritten: 0,
    files_skipped: 0,
    backups_created: 0,
  };
  return {
    ok: true,
    dryRun: false,
    import: {
      filesCreated: summary.files_created,
      filesOverwritten: summary.files_overwritten,
      filesSkipped: summary.files_skipped,
      backupsCreated: summary.backups_created,
      warnings: result.warnings ?? [],
    },
  };
}
