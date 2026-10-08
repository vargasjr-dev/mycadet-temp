import { SEEDS } from "@mycadet/environments";
import { resolveEnvironmentSource } from "../lib/environments/resolve.js";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

function printUsage(): void {
  console.log("Usage: cadet env <subcommand>");
  console.log("");
  console.log("Show the CLI's environment. Environments cannot be switched:");
  console.log("each client is tied to the environment denoted by its version");
  console.log(
    "(a dev CLI targets dev, a stable CLI targets production, etc.).",
  );
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  get          Show the current environment and how it was resolved",
  );
  console.log("");
  console.log(`Known environments: ${Object.keys(SEEDS).join(", ")}`);
  console.log("");
  console.log("Examples:");
  console.log("  $ cadet env get          # show resolved environment");
}

function envGet(): void {
  const { name, source } = resolveEnvironmentSource();
  const sourceLabels: Record<typeof source, string> = {
    env: "CADET_ENVIRONMENT env var",
    version: `CLI version ${cliPkg?.version ? `v${cliPkg.version}` : "(unknown)"}`,
  };
  console.log(`${name} (from ${sourceLabels[source]})`);
}

export async function env(): Promise<void> {
  const args = process.argv.slice(3);
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    return;
  }

  switch (sub) {
    case "get":
      envGet();
      break;
    case "set":
    case "clear":
      console.error(
        `cadet env ${sub} was removed: environments cannot be switched. ` +
          `Each client is tied to the environment denoted by its version — ` +
          `install a CLI built for the environment you want to target.`,
      );
      process.exitCode = 1;
      break;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printUsage();
      process.exitCode = 1;
  }
}
