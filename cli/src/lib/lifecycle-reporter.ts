/**
 * Sink for the human-facing output of long-running lifecycle operations
 * (hatch, retire). Injecting it lets an in-process caller (e.g. a desktop main
 * process embedding these functions) observe progress without the operation
 * writing to the terminal, while the CLI keeps its existing stdout.
 */
export interface LifecycleReporter {
  /** Coarse step progress, rendered as a `[step/total] label` line. */
  progress(step: number, total: number, label: string): void;
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Reporter used by the CLI commands: human-readable lines to the console.
 */
export const consoleLifecycleReporter: LifecycleReporter = {
  // Plain terminals get an active status line per step — without this the
  // startup goes silent between prompts.
  progress: (step, total, label) => {
    console.log(`[${step}/${total}] ${label}`);
  },
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
