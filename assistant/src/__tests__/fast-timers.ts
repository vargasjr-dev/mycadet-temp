/**
 * Accelerated clocks for tests: replaces the global timer functions so
 * `setTimeout`/`setInterval` callbacks fire as soon as the current await
 * yields, instead of waiting out real milliseconds.
 *
 * Call order is preserved (a timer scheduled before another fires first), so
 * "hold the turn open past the debounce, then read mid-hold" test patterns
 * keep their exact observable sequence — just without the wall-clock burn.
 *
 * Scope: each test file runs in its own bun process (the runner guarantees
 * this), so installing this is process-local and cannot leak into other
 * files. Bun has no built-in fake-clock mode (`--fake-clock` is a no-op on
 * 1.3.11), so this is the general mechanism for tests that would otherwise
 * wait out production pacing.
 */
export function installFastTimers(): () => void {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;

  const fastSetTimeout: typeof setTimeout = ((
    handler: (...args: unknown[]) => void,
    _ms?: number,
    ...args: unknown[]
  ) => {
    Promise.resolve().then(() =>
      typeof handler === "function" ? handler(...args) : undefined,
    );
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  const fastSetInterval: typeof setInterval = ((
    handler: (...args: unknown[]) => void,
    _ms?: number,
    ...args: unknown[]
  ) => {
    // Intervals in accelerated time still fire, but only once per await —
    // repeated firings come from whoever re-arms or polls. Tests that need
    // true repetition should not use fast timers.
    Promise.resolve().then(() =>
      typeof handler === "function" ? handler(...args) : undefined,
    );
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  globalThis.setTimeout = fastSetTimeout;
  globalThis.setInterval = fastSetInterval;

  return () => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  };
}
