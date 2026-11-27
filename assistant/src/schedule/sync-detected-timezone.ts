/**
 * Persist a valid inbound client zone into `config.ui.detectedTimezone`.
 *
 * The scheduler's zone chain (`resolveScheduleTimezone`) ends in the host
 * clock — UTC on a managed container — when a schedule names no zone and the
 * user has no configured zone and `ui.detectedTimezone` was never synced.
 * Only the web app syncs that field (its headless `TimezoneSync` component);
 * every other client — CLI, Slack, desktop — reports a zone per message and
 * lets it drop, so their recurring schedules keep firing on UTC.
 *
 * Every inbound message already carries the sender's zone (request body,
 * source metadata, or the conversation record). Persisting it here keeps the
 * chain off the host clock for every client, not just the web app.
 *
 * Mirrors TimezoneSync's doctrine: ONLY `detectedTimezone` is written —
 * `ui.userTimezone` is the authoritative manual override and is never touched
 * here. Writes are deduped (a no-op when the zone is unchanged) and
 * last-writer-wins, matching the web sync's serialization model. The heartbeat
 * reschedules through the same hook the config PATCH route uses, so a detected
 * zone change takes effect on the next cron evaluation.
 */

import {
  getConfigReadOnly,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../config/loader.js";
import { canonicalizeTimeZone } from "../daemon/date-context.js";
import { rescheduleHeartbeatIfTimezoneChanged } from "../heartbeat/heartbeat-service.js";

export function persistDetectedClientTimezone(
  clientTimezone: string | null | undefined,
): void {
  const zone = canonicalizeTimeZone(clientTimezone);
  if (!zone) {
    return;
  }
  const current = getConfigReadOnly().ui?.detectedTimezone ?? null;
  if (canonicalizeTimeZone(current) === zone) {
    return;
  }
  const preWrite = loadRawConfig();
  const nextRaw = loadRawConfig();
  const existingUi =
    typeof nextRaw.ui === "object" && nextRaw.ui !== null ? nextRaw.ui : {};
  nextRaw.ui = { ...existingUi, detectedTimezone: zone };
  saveRawConfig(nextRaw);
  invalidateConfigCache();
  rescheduleHeartbeatIfTimezoneChanged(preWrite, nextRaw);
}
