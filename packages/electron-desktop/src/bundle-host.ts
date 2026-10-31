import {
  getGatewayUrl,
  getGuardianAccessToken,
  readLockfile,
  resolveConfigDir,
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
    const { assistants, activeAssistant } = readLockfile();
    if (!activeAssistant) {
      return null;
    }

    const entry = assistants.find(
      (assistant) => assistant.assistantId === activeAssistant,
    );
    if (
      !entry ||
      entry.cloud === "cloud" ||
      entry.cloud === "custom" ||
      entry.cloud === "baseten" ||
      !entry.port
    ) {
      return null;
    }
    return {
      assistantId: entry.assistantId,
      gatewayUrl: getGatewayUrl(entry),
    };
  },
  acquireGatewayToken: async (assistantId) => {
    try {
      const invocation = await resolveInvocation();
      const result = await getGuardianAccessToken(
        assistantId,
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
