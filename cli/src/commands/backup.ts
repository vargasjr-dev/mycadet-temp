import {
  cliCommandName as cliCommand,
  readCloudToken,
} from "@mycadet/local-mode";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { findAssistantByName } from "../lib/assistant-config.js";
import { formatSize, getBackupsDir } from "../lib/backup-ops.js";
import { isCloudHome } from "../lib/cloud-values.js";
import { createRootBackup } from "../lib/root-backup.js";
import { createPlatformBackup } from "../lib/teleport-backup.js";

export const backup = Object.assign(
  async function backup(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`Usage: ${cliCommand()} backup <name>`);
      console.log(
        "Local/Docker: gracefully stop services, capture all persistent roots as tar.gz, then resume.",
      );
      console.log(
        "Cloud: create a backup through the cloud API using your cloud session.",
      );
      console.log(`Example: ${cliCommand()} backup my-assistant`);
      return;
    }
    const name = args[0];
    if (!name || name.startsWith("-"))
      throw new Error(`Usage: ${cliCommand()} backup <name>`);
    if (args.length > 1) throw new Error(`Unknown backup option: ${args[1]}`);
    const entry = findAssistantByName(name);
    if (!entry) throw new Error(`No assistant found with name '${name}'.`);
    if (isCloudHome(entry.cloud)) {
      const token = readCloudToken();
      if (!token)
        throw new Error(`Not logged in. Run '${cliCommand()} login' first.`);
      await createPlatformBackup(entry, token);
      console.log("Cloud backup is ready.");
      return;
    }
    if (entry.cloud && !["local", "docker"].includes(entry.cloud)) {
      throw new Error(
        `Backup for '${entry.cloud}' must run on its host; only local, Docker and cloud backups are supported.`,
      );
    }
    const path = join(
      getBackupsDir(),
      `${entry.assistantId}-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`,
    );
    await createRootBackup(entry, path);
    console.log(`Backup saved to ${path}`);
    console.log(`Size: ${formatSize((await stat(path)).size)}`);
  },
  {
    description:
      "Back up persistent local/Docker roots or create a cloud backup",
  },
);
