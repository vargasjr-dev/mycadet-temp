import { FN_CLAIMANTS, type FnClaimant } from "@mycadet/ipc-contract";

import { runningApps } from "@/runtime/running-apps";

/** The first known claimant of Fn that is running right now, if any. */
export async function findRunningFnClaimant(): Promise<FnClaimant | null> {
  const running = await runningApps(FN_CLAIMANTS.map((app) => app.bundleId));
  return FN_CLAIMANTS.find((app) => running.includes(app.bundleId)) ?? null;
}
