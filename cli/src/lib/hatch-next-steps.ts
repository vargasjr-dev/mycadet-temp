export function logHatchNextSteps(
  log: (message: string) => void,
  instanceName: string,
): void {
  log("Next steps:");
  log("  cadet client");
  log('  cadet message "hello"');
  log("  cadet events");
  log("  cadet ps");
  log(`  cadet use ${instanceName}`);
  log("");
}
