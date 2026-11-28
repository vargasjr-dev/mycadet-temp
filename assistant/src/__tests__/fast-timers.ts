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

  // The microtask has no native timer to cancel. Return an inert handle for
  // code that clears the timer or calls methods such as unref().
  const handle = realSetTimeout(() => {}, 0);
  clearTimeout(handle);
  const runOnNextMicrotask = (
    _target: typeof realSetTimeout | typeof realSetInterval,
    _receiver: unknown,
    [handler, , ...args]: Parameters<typeof realSetTimeout>,
  ) => {
    if (typeof handler === "function") {
      void Promise.resolve().then(() => handler(...args));
    }
    return handle;
  };

  globalThis.setTimeout = new Proxy<typeof realSetTimeout>(realSetTimeout, {
    apply: runOnNextMicrotask,
  });
  // An accelerated interval fires once. Tests that need true repetition
  // should use the native clock.
  globalThis.setInterval = new Proxy<typeof realSetInterval>(realSetInterval, {
    apply: runOnNextMicrotask,
  });

  return () => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  };
}
