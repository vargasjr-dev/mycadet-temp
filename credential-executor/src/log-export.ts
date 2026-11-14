/**
 * CES log export for the `export_logs` RPC method.
 *
 * Collects CES's own log files (optionally filtered by date range), archives
 * them as a tar.gz, and returns the archive base64-encoded. The gateway's
 * diagnostic log export calls this over the shared Unix socket — the
 * IPC-only replacement for the deleted HTTP `/v1/logs/export` route.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOG_FILE_PATTERN } from "./logger.js";
import { getCesLogDir } from "./paths.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum cumulative size of collected log files (5 MB). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface CesLogExport {
  /** tar.gz of the collected logs + manifest, base64-encoded. */
  archiveBase64: string;
  filesCollected: number;
  totalBytes: number;
}

/**
 * Collect CES log files into a staging directory, archive them, and return
 * the base64 archive. Files entirely outside the requested range are
 * skipped, as are files that would push the total past the size cap.
 */
export async function collectCesLogArchive(
  startTime?: number,
  endTime?: number,
): Promise<CesLogExport> {
  const logDir = getCesLogDir();
  const staging = join(
    tmpdir(),
    `ces-log-export-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const logsStaging = join(staging, "ces-logs");
  mkdirSync(logsStaging, { recursive: true });

  try {
    let totalBytes = 0;
    let filesCollected = 0;

    if (existsSync(logDir)) {
      for (const entry of readdirSync(logDir)) {
        const dateMatch = LOG_FILE_PATTERN.exec(entry);
        if (!dateMatch) continue;

        // Filter by date when startTime/endTime are provided. Parse the
        // date from the filename and compare start-of-day / end-of-day
        // against the time bounds.
        const fileDateStr = dateMatch[1]!;
        const fileDayStartMs = new Date(
          fileDateStr + "T00:00:00.000Z",
        ).getTime();
        const fileDayEndMs = new Date(fileDateStr + "T23:59:59.999Z").getTime();

        if (startTime !== undefined && fileDayEndMs < startTime) continue; // entire day before range
        if (endTime !== undefined && fileDayStartMs > endTime) continue; // entire day after range

        const filePath = join(logDir, entry);
        try {
          const stat = statSync(filePath);
          if (!stat.isFile()) continue;
          if (totalBytes + stat.size > MAX_LOG_BYTES) continue;

          const content = await Bun.file(filePath).arrayBuffer();
          await Bun.write(join(logsStaging, entry), content);
          totalBytes += stat.size;
          filesCollected++;
        } catch {
          // Skip unreadable files
        }
      }
    }

    // Always write a manifest so the consumer knows what was collected
    const manifest = {
      type: "ces-log-export",
      exportedAt: new Date().toISOString(),
      filesCollected,
      totalBytes,
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
    };
    await Bun.write(
      join(staging, "ces-export-manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    // Create tar.gz archive of the staging directory
    const proc = spawnSync("tar", ["czf", "-", "-C", staging, "."], {
      maxBuffer: MAX_LOG_BYTES * 2, // allow headroom for tar overhead
      timeout: 30_000,
      windowsHide: true,
    });

    if (proc.status !== 0) {
      const stderr = proc.stderr
        ? Buffer.isBuffer(proc.stderr)
          ? proc.stderr.toString("utf-8")
          : String(proc.stderr)
        : "unknown error";
      throw new Error(`Failed to create archive: ${stderr}`);
    }

    return {
      archiveBase64: Buffer.from(proc.stdout).toString("base64"),
      filesCollected,
      totalBytes,
    };
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
