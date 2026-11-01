import { cliCommandName } from "@mycadet/local-mode";

export function logHatchNextSteps(log: (message: string) => void): void {
  const command = cliCommandName();
  log("Next steps:");
  log(
    `  - Run \`${command} client\` to interact with your cadet via the terminal`,
  );
  log(
    `  - Run \`${command} tunnel\` to make your cadet publicly accessible and interact with it via the browser`,
  );
  log("");
}
