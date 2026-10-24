import {
  getGuardianAccessToken,
  readLockfile,
  resolveConfigDir,
  resolveLockfilePaths,
  type CliInvocation,
} from "@mycadet/local-mode";

import type {
  ActiveBundleGateway,
  BundleHostProvider,
} from "./bundle-platform";
import { denyAllPermissions } from "./permissions";

/**
 * The lockfile-backed bundle host shared by both desktop shells: the active
 * local assistant's gateway and a guardian token for it, minted through the
 * `cadet` CLI.
 */
export const createBundleHostProvider = (
  resolveInvocation: () => Promise<CliInvocation>,
): BundleHostProvider => ({
  resolveActiveGateway: (): ActiveBundleGateway | null => {
    const { assistants, activeAssistant } = readLockfile(
      resolveLockfilePaths(process.env),
    );
    if (!activeAssistant) {
      return null;
    }

    const entry = assistants.find(
      (assistant) => assistant.assistantId === activeAssistant,
    );
    if (!entry?.resources?.gatewayPort) {
      return null;
    }
    return {
      assistantId: entry.assistantId,
      port: entry.resources.gatewayPort,
    };
  },
  acquireGatewayToken: async (assistantId) => {
    try {
      const invocation = await resolveInvocation();
      const result = await getGuardianAccessToken(
        assistantId,
        resolveConfigDir(process.env),
        invocation,
        true,
      );
      return result.ok ? result.accessToken : null;
    } catch {
      return null;
    }
  },
  denyAllPermissions,
});
