/**
 * Session-scoped diagnostic event recorder — the app bundle's minimal
 * counterpart of the web bundle's diagnostics ring. Records timestamped
 * diagnostic events to a sessionStorage ring buffer so a streaming
 * failure's timeline survives navigation but not tab close. Only the
 * low-frequency lifecycle ring the streaming watchdog needs is kept;
 * the web bundle's high-volume per-delta rings stay web-side.
 */

const RING_KEY = "mycadet-app-lifecycle-diagnostics";
const MAX_EVENTS = 200;

export interface DiagnosticsEvent {
  ts: string;
  kind: string;
  details: Record<string, unknown>;
}

function loadRing(): DiagnosticsEvent[] {
  try {
    const raw = sessionStorage.getItem(RING_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (event): event is DiagnosticsEvent =>
        !!event &&
        typeof event === "object" &&
        typeof (event as DiagnosticsEvent).kind === "string",
    );
  } catch {
    return [];
  }
}

function saveRing(events: DiagnosticsEvent[]): void {
  try {
    sessionStorage.setItem(RING_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // Storage-full or denied: diagnostics are best-effort, never load-bearing.
  }
}

/**
 * Append a discrete connection / app-lifecycle transition to the durable
 * lifecycle ring (stream open / close / reconnect / watchdog).
 */
export function recordDiagnostic(
  kind: string,
  details: Record<string, unknown> = {},
): void {
  const events = loadRing();
  events.push({ ts: new Date().toISOString(), kind, details });
  saveRing(events);
}

/** Return a defensive copy of the lifecycle ring buffer. */
export function getDiagnosticsEvents(): DiagnosticsEvent[] {
  return [...loadRing()];
}
