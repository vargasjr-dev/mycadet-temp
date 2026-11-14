/**
 * The cloud upgrade leg: the cloud's upgrade call plus the poll-and-
 * confirm wait (the web UI's Software Updates flow — poll the DB-backed
 * `current_release_version`, since the gateway bounces during the restart).
 * Narration rides the caller's reporter; failures throw `UpgradeError` for
 * the command layer to map onto the CLI's error taxonomy.
 */
import { cloudAuthHeaders, loopbackSafeFetch, readCloudToken } from "../..";
import type { LockfileAssistant } from "../../lockfile-contract";
import { getGatewayUrl } from "../../lockfile-contract";
import {
  broadcastUpgradeEvent,
  buildCompleteEvent,
  UpgradeError,
} from "../../upgrade-lifecycle";
import type { LifecycleReporter } from "../../lifecycle-reporter";
import { checkHealth } from "../../daemon-readiness";
import {
  evaluateUpgradePoll,
  resolveUpgradeTarget,
} from "../../upgrade-preflight";
import { fetchReleases } from "../../cloud-releases";
import { z } from "zod";
import { getCloudBaseUrl } from "@mycadet/shared";

const CLOUD_FETCH_TIMEOUT_MS = 10_000;

const AssistantDetailResponseSchema = z.object({
  current_release_version: z.string().nullable().optional(),
});

const InProgressResponseSchema = z.object({
  in_progress: z.boolean().optional(),
});

export interface CloudAssistantDetail {
  currentReleaseVersion: string | null;
}

export interface CloudAssistantDetail {
  currentReleaseVersion: string | null;
}

/**
 * Fetch a single assistant's upgrade-relevant fields from
 * `GET /v1/assistants/{id}/`. Returns null on any failure (best-effort
 * pre-flight / polling helper — never throws).
 */
export async function fetchAssistantDetail(
  token: string,
  assistantId: string,
): Promise<CloudAssistantDetail | null> {
  const resolvedUrl = getCloudBaseUrl();
  const url = `${resolvedUrl}/v1/assistants/${encodeURIComponent(assistantId)}/`;

  try {
    const response = await loopbackSafeFetch(url, {
      signal: AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
      headers: await cloudAuthHeaders(token),
    });

    if (!response.ok) return null;

    const parsed = AssistantDetailResponseSchema.safeParse(
      await response.json(),
    );
    const body = parsed.success ? parsed.data : {};
    return {
      currentReleaseVersion: body.current_release_version ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Check whether the cloud reports an upgrade in progress for the
 * assistant via `GET /v1/assistants/{id}/upgrade-status/`. Returns null
 * when the endpoint is unavailable (404 on older cloud builds, network
 * error) so callers can skip the check. Never throws.
 */
export async function fetchUpgradeInProgress(
  token: string,
  assistantId: string,
): Promise<boolean | null> {
  const resolvedUrl = getCloudBaseUrl();
  const url = `${resolvedUrl}/v1/assistants/${encodeURIComponent(assistantId)}/upgrade-status/`;

  try {
    const response = await loopbackSafeFetch(url, {
      signal: AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
      headers: await cloudAuthHeaders(token),
    });

    if (!response.ok) return null;

    const parsed = InProgressResponseSchema.safeParse(await response.json());
    return parsed.success && parsed.data.in_progress !== undefined
      ? parsed.data.in_progress
      : null;
  } catch {
    return null;
  }
}

interface UpgradeApiResponse {
  detail: string;
  version: string | null;
}

export interface UpgradeCloudParams {
  entry: LockfileAssistant;
  /** The explicit target version; null/undefined = let the cloud resolve. */
  version?: string | null;
  /** Wait for the cloud to confirm completion (the CLI's --no-wait turns this off). */
  wait?: boolean;
  reporter: LifecycleReporter;
}

const CLOUD_POLL_INTERVAL_MS = 3_000;
const CLOUD_POLL_HEARTBEAT_MS = 30_000;
const CLOUD_HEALTH_CONFIRM_TIMEOUT_MS = 120_000;
const CLOUD_HEALTH_CONFIRM_INTERVAL_MS = 5_000;

const UPGRADE_IN_PROGRESS_MSG =
  "An upgrade is already in progress for this assistant. Check `cadet ps`.";

function cloudUpgradeTimeoutMs(): number {
  const override = process.env.CADET_CLOUD_UPGRADE_TIMEOUT_MS;
  if (override) {
    const parsed = parseInt(override, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 600_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCloudUpgrade(
  entry: LockfileAssistant,
  token: string,
  pollTarget: string | null,
  initialVersion: string | null,
  reporter: LifecycleReporter,
): Promise<void> {
  const log = (msg: string) => reporter.log(msg);
  const warn = (msg: string) => reporter.warn(msg);
  const gatewayUrl = getGatewayUrl(entry);
  const timeoutMs = cloudUpgradeTimeoutMs();
  const start = Date.now();
  let sawInProgress = false;
  let lastHeartbeat = start;
  let observedVersion: string | null = initialVersion;

  log(
    pollTarget
      ? `⏳ Waiting for the upgrade to ${pollTarget} to complete...`
      : "⏳ Waiting for the upgrade to complete...",
  );

  while (Date.now() - start < timeoutMs) {
    await sleep(CLOUD_POLL_INTERVAL_MS);

    // The in-progress lock is only needed when we don't know the target
    // version (server resolved "latest" without reporting it).
    const [detail, inProgress] = await Promise.all([
      fetchAssistantDetail(token, entry.assistantId),
      pollTarget
        ? Promise.resolve(null)
        : fetchUpgradeInProgress(token, entry.assistantId),
    ]);
    if (detail) observedVersion = detail.currentReleaseVersion;
    if (inProgress === true) sawInProgress = true;

    const verdict = evaluateUpgradePoll({
      targetVersion: pollTarget,
      initialVersion,
      observedVersion,
      inProgress,
      sawInProgress,
    });

    if (verdict === "complete") {
      const finalVersion = observedVersion ?? pollTarget ?? "unknown";
      const healthDeadline = Date.now() + CLOUD_HEALTH_CONFIRM_TIMEOUT_MS;
      while (Date.now() < healthDeadline) {
        const health = await checkHealth(entry);
        if (health.status === "healthy") {
          log(`✅ Upgraded to ${finalVersion} — assistant is healthy.`);
          return;
        }
        await sleep(CLOUD_HEALTH_CONFIRM_INTERVAL_MS);
      }
      warn(
        `⚠️  Upgraded to ${finalVersion}, but the health check did not confirm. Check \`cadet ps\`.`,
      );
      return;
    }

    if (Date.now() - lastHeartbeat >= CLOUD_POLL_HEARTBEAT_MS) {
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      log(`   Still upgrading... (${elapsedSec}s elapsed)`);
      lastHeartbeat = Date.now();
    }
  }

  const timeoutMin = Math.round(timeoutMs / 60_000);
  warn(
    `⚠️  Upgrade request was accepted but completion was not confirmed within ${timeoutMin} minutes. The cloud may still be working — check \`cadet ps\` or the web settings page.`,
  );
}

export async function upgradeCloud(params: UpgradeCloudParams): Promise<void> {
  const { reporter } = params;
  const log = (msg: string) => reporter.log(msg);
  const warn = (msg: string) => reporter.warn(msg);
  const err = (msg: string) => reporter.error(msg);
  const entry = params.entry;
  const version = params.version;
  const wait = params.wait;
  const gatewayUrl = getGatewayUrl(entry);
  log(`🔄 Upgrading cloud-hosted assistant '${entry.assistantId}'...\n`);

  const token = readCloudToken();
  if (!token) {
    throw new UpgradeError(
      "AUTH_FAILED",
      "Error: Not logged in. Run `cadet login --token <token>` first.",
    );
  }

  // Pre-flight (all best-effort except an explicit version that the
  // cloud doesn't know about): resolve the target, detect no-ops and
  // downgrades before POSTing, and bail if an upgrade is already running.
  const [assistantDetail, health] = await Promise.all([
    fetchAssistantDetail(token, entry.assistantId),
    checkHealth(entry),
  ]);
  // Health probe first, DB-backed field as the sleeping-assistant fallback.
  const currentVersion =
    health.version ?? assistantDetail?.currentReleaseVersion ?? undefined;

  // Target the same cloud as the detail/health/POST calls — the entry's
  // cloud may differ from the active lockfile default.
  const releases = await fetchReleases();

  const resolution = resolveUpgradeTarget({
    explicitVersion: version ?? null,
    releases,
    currentVersion,
  });

  if (resolution.kind === "version-not-found") {
    throw new UpgradeError(
      "MISSING_VERSION",
      `Version ${version} not found in Cadet Cloud releases.`,
    );
  }

  if (resolution.isNoOp && resolution.target) {
    log(`✅ Already on ${resolution.target}. Nothing to do.`);
    return;
  }

  if (resolution.isDowngrade && resolution.target && currentVersion) {
    throw new UpgradeError(
      "VERSION_DIRECTION",
      `Cannot upgrade to an older version (${resolution.target} < ${currentVersion}). Use \`cadet restore --from <backup-path> --version ${resolution.target}\` instead.`,
    );
  }

  if (resolution.kind === "no-releases") {
    warn(
      "⚠️  Cadet Cloud releases unavailable — requesting latest from server.",
    );
  }

  const inProgress = await fetchUpgradeInProgress(token, entry.assistantId);
  if (inProgress === true) {
    throw new UpgradeError("CLOUD_API_ERROR", UPGRADE_IN_PROGRESS_MSG);
  }

  if (currentVersion && resolution.target) {
    log(`   ${currentVersion} → ${resolution.target}\n`);
  }

  const headers = await cloudAuthHeaders(token);

  const url = `${gatewayUrl || getCloudBaseUrl()}/v1/assistants/${encodeURIComponent(entry.assistantId)}/upgrade/`;
  const body: { version?: string } = {};
  if (version) {
    body.version = version;
  }

  const response = await loopbackSafeFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (response.status === 401 || response.status === 403) {
    const text = await response.text();
    try {
      await broadcastUpgradeEvent(
        gatewayUrl,
        entry.assistantId,
        buildCompleteEvent("unknown", false),
      );
    } catch {
      // Best-effort — broadcast may fail if the assistant is unreachable
    }
    throw new UpgradeError("AUTH_FAILED", "Authentication failed", text);
  }

  if (response.status === 409) {
    const text = await response.text();
    throw new UpgradeError("CLOUD_API_ERROR", UPGRADE_IN_PROGRESS_MSG, text);
  }

  if (!response.ok) {
    const text = await response.text();
    try {
      await broadcastUpgradeEvent(
        gatewayUrl,
        entry.assistantId,
        buildCompleteEvent("unknown", false),
      );
    } catch {
      // Best-effort — broadcast may fail if the assistant is unreachable
    }
    throw new UpgradeError(
      "CLOUD_API_ERROR",
      `Cloud upgrade failed (${response.status})`,
      text,
    );
  }

  const result = (await response.json()) as UpgradeApiResponse;

  // The server resolves "latest" itself; a no-op response means nothing was
  // actually kicked off, so don't poll for a completion that will never come.
  if (result.detail?.includes("Already on the latest")) {
    warn(`⚠️  ${result.detail}`);
    return;
  }

  // NOTE: We intentionally do NOT broadcast a "complete" event here.
  // The cloud API returning 200 only means "upgrade request accepted" —
  // the service group has not yet restarted with the new version.  The
  // completion signal will come from the client's health-check
  // version-change detection (DaemonConnection.swift) once the new
  // version actually appears after the cloud restarts the service group.

  log(`✅ ${result.detail}`);
  if (result.version) {
    log(`   Version: ${result.version}`);
  }

  if (!wait) {
    return;
  }

  await waitForCloudUpgrade(
    entry,
    token,
    result.version ?? resolution.target ?? null,
    currentVersion ?? null,
    reporter,
  );
}
