export function logHatchNextSteps(
  log: (message: string) => void,
  verbose = false,
): void {
  log("Next steps:");
  log("  cadet client");
  if (verbose) {
    log('  cadet message "hello"');
    log("  cadet events");
  }
  log("");
}
