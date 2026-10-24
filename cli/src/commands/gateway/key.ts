import { randomBytes } from "node:crypto";

import { cliCommand } from "../../lib/cli-name.js";
import {
  type LockfileAssistant,
  resolveTargetAssistant,
} from "../../lib/assistant-config.js";
import { getLocalInstanceDir } from "../../lib/assistant-config.js";
import { persistRootSigningKey } from "../../lib/root-signing-key.js";

function printUsage(): void {
  console.log(
    `Usage: ${cliCommand()} gateway key reset [assistantId]`,
  );
  console.log("");
  console.log("Replace an assistant's gateway signing key.");
  console.log("");
  console.log(
    "The gateway is the only holder of the signing key — this is the escape",
    "hatch for a lost or corrupt key material. Stop the assistant first",
    "(`cadet sleep <name>`); the replacement takes effect on the next start.",
    "Every paired client must authenticate again afterwards.",
  );
}

/**
 * Rotate the gateway's signing key in place: a fresh key persisted into the
 * instance's gateway security root, taking effect on the next gateway start.
 * The gateway regenerates nothing on its own when a key file exists, so this
 * is the only deliberate rotation path — and the only consumer of
 * `persistRootSigningKey` outside backup/restore.
 */
export const key = Object.assign(
  async function key(args: string[]): Promise<void> {
    if (args.includes("--help") || args.includes("-h")) {
      printUsage();
      process.exit(0);
    }
    if (args.length > 0 && !args[0]!.startsWith("-")) {
      // fallthrough — resolveTargetAssistant takes the name
    }
    const entry: LockfileAssistant = resolveTargetAssistant(args[0]);
    if (entry.cloud === "docker") {
      console.error(
        "Error: key reset applies to local instances. Docker assistants re-key by recreating their gateway-security volume.",
      );
      process.exit(1);
    }
    if (!entry.resources) {
      console.error(
        `Error: local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
      );
      process.exit(1);
    }

    const fresh = randomBytes(32).toString("hex");
    persistRootSigningKey(getLocalInstanceDir(entry.resources), fresh);
    console.log(
      `Signing key replaced for '${entry.assistantId}'. Start the assistant to apply it — every paired client must authenticate again.`,
    );
  },
  { description: "Replace an assistant's gateway signing key" },
);
