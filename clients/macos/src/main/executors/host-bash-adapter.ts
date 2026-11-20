/**
 * macOS host_bash adapter: runs the wire-contract command strings through
 * Bash via the shared host shell executor.
 */

import { createHostShellExecutor } from "@mycadet/electron-desktop";

export const hostBashExecutor = createHostShellExecutor({
  buildSpawn: (command) => ({ file: "/bin/bash", args: ["-c", "--", command] }),
});
