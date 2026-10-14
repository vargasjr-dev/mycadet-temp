import { stat } from "node:fs/promises";
import { join } from "node:path";
import { findAssistantByName } from "../lib/assistant-config.js";
import { formatSize, getBackupsDir } from "../lib/backup-ops.js";
import { readCloudToken } from "../lib/cloud-client.js";
import { isCloudHome } from "../lib/cloud-values.js";
import { createRootBackup } from "../lib/root-backup.js";
import { createPlatformBackup } from "../lib/teleport-backup.js";

export const backup = Object.assign(
  async function backup(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log("Usage: cadet backup <name> [--output <path>]");
      console.log(
        "Local/Docker: gracefully stop services, capture all persistent roots as tar.gz, then resume.",
      );
      console.log(
        "Cloud: create a backup through the cloud API using your cloud session.",
      );
      console.log("Example: cadet backup my-assistant --output backup.tar.gz");
      return;
    }
    const name = args[0];
    if (!name || name.startsWith("-"))
      throw new Error("Usage: cadet backup <name> [--output <path>]");
    let output: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (
        args[i] === "--output" &&
        args[i + 1] &&
        !args[i + 1]!.startsWith("-")
      )
        output = args[++i];
      else throw new Error(`Unknown or incomplete backup option: ${args[i]}`);
    }
    const entry = findAssistantByName(name);
    if (!entry) throw new Error(`No assistant found with name '${name}'.`);
    if (isCloudHome(entry.cloud)) {
      if (output)
        throw new Error(
          "Cloud backups are stored by the cloud API; --output is supported for local/Docker backups.",
        );
      const token = readCloudToken();
      if (!token) throw new Error("Not logged in. Run 'cadet login' first.");
      await createPlatformBackup(entry, token);
      console.log("Cloud backup is ready.");
      return;
    }
    if (entry.cloud && !["local", "docker"].includes(entry.cloud)) {
      throw new Error(
        `Backup for '${entry.cloud}' must run on its host; only local, Docker and cloud backups are supported.`,
      );
    }
    const path =
      output ??
      join(
        getBackupsDir(),
        `${entry.assistantId}-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`,
      );
    if (/\.vbundle(?:\.enc)?$/i.test(path))
      throw new Error(
        "Backups use root tar archives; choose a .tar.gz output path.",
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
