/**
 * Sink for the human-facing and structured output of long-running lifecycle
 * operations (hatch, retire). Injecting it lets an in-process caller (e.g. a
 * desktop main process embedding these functions) observe progress without
 * the operation writing to the terminal, while the CLI keeps its existing
 * stdout (its log tee patches `console.*`, so the default sink rides the
 * tee).
 */
export interface LifecycleReporter {
  /**
   * Coarse step progress. The CLI reporter mirrors this to the desktop
   * `HATCH_PROGRESS:` stdout channel.
   */
  progress(step: number, total: number, label: string): void;
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * The default reporter: human-readable lines to the console. Retire's legs
 * only use `log`/`warn`/`error`.
 */
export const consoleLifecycleReporter: LifecycleReporter = {
  progress: (step, total, label) => {
    console.log(`[${step}/${total}] ${label}`);
  },
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
