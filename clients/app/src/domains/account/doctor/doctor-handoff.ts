/**
 * Doctor hand-off state — a one-shot inbox the chat `/doctor <message>`
 * slash command writes to and the Doctor page reads from on load.
 *
 * Why sessionStorage instead of a query param: the first message is
 * arbitrary user-authored text. Carrying it in the URL would place it in
 * browser history and in navigation breadcrumbs captured by telemetry.
 * sessionStorage keeps the prompt out of the URL entirely while still
 * surviving the CROSS-BUNDLE navigation the hand-off now rides: the chat
 * lives in the web bundle (the assistant frame) and the Doctor lives on
 * the app's `/account/doctor` page, so the old module-singleton store
 * cannot bridge them — same origin, same tab, sessionStorage can.
 *
 * One-shot semantics — `consumePendingDoctorPrompt` returns and clears.
 * If a second `/doctor` is submitted before consumption, the latest
 * prompt wins (silent overwrite). Tab closes blow this away — by design,
 * the hand-off is a transient signal.
 *
 * The WRITE side lives in the web bundle
 * (`clients/web/src/lib/doctor-handoff-writer.ts`); the storage key and
 * the JSON shape are the contract between the two bundles.
 */

const HANDOFF_KEY = "mycadet-doctor-handoff";

/** Park the first message the Doctor page should send once it mounts. */
export function parkPendingDoctorPrompt(prompt: string): void {
  try {
    sessionStorage.setItem(
      HANDOFF_KEY,
      JSON.stringify({ prompt, parkedAt: Date.now() }),
    );
  } catch {
    // Storage denied: the Doctor page just opens empty.
  }
}

/** Read the pending prompt WITHOUT clearing it (the auto-start race guard). */
export function peekPendingDoctorPrompt(): string | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { prompt?: unknown }).prompt === "string"
    ) {
      return (parsed as { prompt: string }).prompt;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read and clear the pending prompt. Returns `null` if none was set. */
export function consumePendingDoctorPrompt(): string | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(HANDOFF_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { prompt?: unknown }).prompt === "string"
    ) {
      return (parsed as { prompt: string }).prompt;
    }
    return null;
  } catch {
    return null;
  }
}
