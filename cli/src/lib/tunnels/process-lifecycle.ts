import { clearIngressUrl, getDefaultWorkspaceDir } from "../ingress-config.js";
import { stopProcess } from "../process.js";
import type { ProviderStopOptions } from "../tunnel.js";

/** Stop only an identified provider process and retain state on termination failure. */
export async function stopOwnedTunnelAgent(
  opts: ProviderStopOptions,
  matches: (pid: number) => boolean,
  label: string,
): Promise<boolean> {
  let stopped = false;
  if (matches(opts.record.pid)) {
    stopped = await stopProcess(opts.record.pid, "tunnel");
    if (!stopped && matches(opts.record.pid)) {
      throw new Error(
        `Could not stop ${label} process ${opts.record.pid}; saved tunnel state was retained.`,
      );
    }
  }
  clearIngressUrl(getDefaultWorkspaceDir());
  return stopped;
}
