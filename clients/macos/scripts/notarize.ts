/**
 * Submit the Electron DMG to Apple's notary service and wait for the verdict.
 *
 * Extracted from the dev-release workflow's inline script. The submit runs
 * WITHOUT `--wait`: it returns once Apple accepts the upload, and the
 * processing wait is a timestamped poll below. The inline version captured
 * notarytool's entire output in a variable, so a slow wait produced zero log
 * lines — run #118's submit sat silent for 24 minutes before the job's
 * 30-minute timeout killed it, with nothing saying whether the upload or
 * Apple's queue was slow.
 *
 * Usage: bun scripts/notarize.ts <dmg-path>
 * Env: ASC_KEY_P8, ASC_KEY_ID, ASC_ISSUER_ID.
 * Exits non-zero on any not-Accepted outcome, fetching the submission's
 * notarization log for the failure record.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dmgPath = process.argv[2];
if (!dmgPath) {
  console.error("Usage: bun scripts/notarize.ts <dmg-path>");
  process.exit(1);
}
const ascKeyId = process.env.ASC_KEY_ID;
const ascIssuerId = process.env.ASC_ISSUER_ID;
const ascKeyP8 = process.env.ASC_KEY_P8;
if (!ascKeyId || !ascIssuerId || !ascKeyP8) {
  console.error("ASC_KEY_P8, ASC_KEY_ID and ASC_ISSUER_ID are all required.");
  process.exit(1);
}

// The API key lives in a short-lived temp dir, never the repo checkout.
const keyDir = mkdtempSync(join(tmpdir(), "notary-"));
const keyPath = join(keyDir, `AuthKey_${ascKeyId}.p8`);
writeFileSync(keyPath, ascKeyP8);

const notaryArgs = [
  "--key",
  keyPath,
  "--key-id",
  ascKeyId,
  "--issuer",
  ascIssuerId,
];

/** The UUID notarytool reports for a submission, for `info`/`log` calls. */
const SUBMISSION_ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

function runNotary(args: string[]): { code: number | null; output: string } {
  const proc = Bun.spawnSync(["xcrun", "notarytool", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
  return { code: proc.exitCode, output };
}

/** Apple's terminal verdicts; anything else keeps the poll spinning. */
const TERMINAL_STATUSES = ["Accepted", "Invalid", "Rejected"];

try {
  console.log("Submitting Electron DMG for notarization...");
  const submit = runNotary(["submit", dmgPath, ...notaryArgs]);
  console.log(submit.output.trim());
  if (submit.code !== 0) {
    console.error("::error::Electron notarization submit failed");
    process.exit(1);
  }
  const submissionId = SUBMISSION_ID_PATTERN.exec(submit.output)?.[0];
  if (!submissionId) {
    console.error("::error::Electron notarization produced no submission id");
    process.exit(1);
  }

  // Apple's queue is normally a few minutes; poll with timestamps so the
  // wait is visible and bounded (25 polls ~= 19 minutes) instead of a
  // silent black box.
  let status = "";
  for (let poll = 0; poll < 25; poll++) {
    await new Promise((resolve) => setTimeout(resolve, 45_000));
    const info = runNotary(["info", submissionId, ...notaryArgs]);
    status =
      info.output
        .split("\n")
        .find((line) => line.startsWith("Status:"))
        ?.slice("Status:".length)
        .trim() ?? "";
    console.log(
      `${new Date().toISOString()} notarization status: ${status || "unknown"}`,
    );
    if (TERMINAL_STATUSES.includes(status)) break;
  }

  if (status !== "Accepted") {
    console.error(
      `::error::Electron notarization failed (status: ${status || "none"})`,
    );
    const log = runNotary(["log", submissionId, ...notaryArgs]);
    const logOutput = log.output.trim();
    if (logOutput) {
      console.log(logOutput);
    } else {
      console.log("::warning::Could not fetch notarization log");
    }
    process.exit(1);
  }
} finally {
  rmSync(keyDir, { recursive: true, force: true });
}
