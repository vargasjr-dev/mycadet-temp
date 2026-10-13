import { getCurrentEnvironment } from "./environments/resolve.js";

function cliCommand(): string {
  // Production keeps the bare `cadet` binary; every non-production
  // environment installs as `cadet-<env>` (the same rule as the config and
  // state dirs — see environments/paths.ts).
  const env = getCurrentEnvironment();
  return env.name === "production" ? "cadet" : `cadet-${env.name}`;
}

export function logHatchNextSteps(log: (message: string) => void): void {
  const command = cliCommand();
  log("Next steps:");
  log(
    `  - Run \`${command} client\` to interact with your cadet via the terminal`,
  );
  log(
    `  - Run \`${command} tunnel\` to make your cadet publicly accessible and interact with it via the browser`,
  );
  log("");
}
