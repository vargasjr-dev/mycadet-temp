export function logHatchNextSteps(log: (message: string) => void): void {
  log("Next steps:");
  log("  - Run `cadet client` to interact with your cadet via the terminal");
  log(
    "  - Run `cadet tunnel` to make your cadet publicly accessible and interact with it via the browser",
  );
  log("");
}
