import { app } from "electron";

/**
 * The app-lifecycle seam every desktop client shares: acquire the
 * single-instance lock, then run the client's startup sequence once Electron
 * is ready, logging "ready" on the way in and swallowing nothing on the way
 * out — a failed setup lands in the same `[app] whenReady setup failed`
 * report on every platform instead of three hand-rolled copies of the catch.
 *
 * Setup receives no arguments and may be async; early-return (or resolve) to
 * skip the rest when the instance should not set up — e.g. the loser of the
 * single-instance race, or a packaged first launch that is about to relocate
 * itself and relaunch.
 */
export const runWhenReady = (
  log: { info: (message: string, ...rest: unknown[]) => void; error: (message: string, ...rest: unknown[]) => void },
  setup: () => void | Promise<void>,
): void => {
  void app
    .whenReady()
    .then(async () => {
      log.info("[app] ready");
      await setup();
    })
    .catch((err: unknown) => {
      log.error("[app] whenReady setup failed:", err);
    });
};
