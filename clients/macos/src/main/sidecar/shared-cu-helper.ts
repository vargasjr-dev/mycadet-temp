/**
 * Lazily-spawned helper instance dedicated to the host-proxy computer-use
 * and app-control executors.
 *
 * This is a separate client from the shared helper client in
 * `native-helper-client.ts`: the two drive disjoint JSON-RPC surfaces, and
 * keeping them apart means a crash in one supervisor circuit never tears
 * down the other — computer use runs well past the shared client's request
 * budget. The underlying process is the same signed binary, so the two
 * share the helper's Accessibility and Screen Recording grants. Those are
 * the helper's own, not the app's: the helper disclaims TCC responsibility, so
 * macOS lists and checks it apart from Cadet, and the app being allowed says
 * nothing about whether a capture here will be (see
 * `screen-recording-permission.ts`). The process is not
 * spawned until the first `cu.perform` call, so users
 * who never invoke computer use pay nothing.
 */

import log from "@mycadet/electron-desktop/app-logger";
import { NativeSidecarClient as MacHelperClient } from "@mycadet/native-sidecar/supervisor";

import { getSharedHelperPath } from "@mycadet/electron-desktop/native-helper-client";

// Computer-use / app-control actions run an accessibility-tree walk, a settle
// delay, and a screen capture before responding — well past the default 2s
// request budget. Some inputs legitimately take longer (computer_use_wait,
// long app_control_sequence, large text typing). Set this just above the
// daemon's 60s host-proxy request timeout so the daemon's timeout stays
// authoritative and the client never reports "did not respond" for an action
// the daemon would still accept; the client timeout only catches a genuinely
// hung helper.
const CU_HELPER_TIMEOUT_MS = 65_000;

let client: MacHelperClient | null = null;

export function getSharedCuHelper(): MacHelperClient {
  if (!client) {
    client = new MacHelperClient({
      resolveExecutablePath: getSharedHelperPath,
      logger: log,
      responseTimeoutMs: CU_HELPER_TIMEOUT_MS,
    });
  }
  return client;
}

export function shutdownSharedCuHelper(): void {
  client?.shutdown();
  client = null;
}
