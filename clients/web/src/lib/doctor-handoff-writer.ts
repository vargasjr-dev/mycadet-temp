/**
 * The web bundle's write side of the doctor hand-off contract.
 *
 * The chat's `/doctor <message>` slash command and the doctor deep links
 * live here (the assistant frame), but the Doctor itself lives on the
 * app's `/account/doctor` page — a different bundle. The hand-off crosses
 * over same-origin sessionStorage (the prompt never rides the URL) and
 * the navigation crosses over the frame's host-navigation message, which
 * the app shell honors only for `/account/*` paths.
 *
 * The storage key and JSON shape are the contract with the app side's
 * `doctor-handoff.ts`; keep the two in lockstep.
 */

const HANDOFF_KEY = "mycadet-doctor-handoff";

export const DOCTOR_PAGE_PATH = "/account/doctor";

/** Park the prompt and ask the host shell to open the Doctor page. */
export function requestDoctorPage(prompt?: string): void {
  if (prompt) {
    try {
      sessionStorage.setItem(
        HANDOFF_KEY,
        JSON.stringify({ prompt, parkedAt: Date.now() }),
      );
    } catch {
      // Storage denied: the Doctor page just opens empty.
    }
  }
  // A standalone boot (no frame) is its own host — navigate directly.
  if (window.parent === window) {
    window.location.assign(DOCTOR_PAGE_PATH);
    return;
  }
  try {
    window.parent.postMessage(
      { source: "mycadet-web-host-nav", path: DOCTOR_PAGE_PATH },
      "*",
    );
  } catch {
    // A dead or denied parent must never break in-iframe flows.
  }
}
