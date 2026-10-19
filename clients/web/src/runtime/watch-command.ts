import type { WatchCaptureTarget } from "@mycadet/ipc-contract";

import { toggleWatch } from "@/domains/chat/watch/watch-controller";

/**
 * The `toggleWatch` command's whole body: start or stop a watch session.
 *
 * A module of its own rather than a closure in `root-layout.tsx`, because this
 * is the door into a session that reads the user's screen and a door is worth
 * being able to test. Everything else the layout registers is a navigation or a
 * dialog; this one is the last thing standing between an IPC message and a
 * capture starting.
 *
 * `target` is what the session should read, when the press chose: it rides
 * the command from the companion's picker and is only ever read on the start
 * edge, since a stop has nothing to aim.
 *
 * Nothing is navigated and the app is deliberately not raised, unlike
 * `startVoice`. The session reads the user's screen, so the work in front of
 * them is its subject: bringing Cadet forward would cover the very thing the
 * session exists to watch.
 */
export function handleToggleWatchCommand(target?: WatchCaptureTarget): void {
  void toggleWatch(target === undefined ? {} : { target });
}
