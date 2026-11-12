/**
 * Dotted-path get/set helpers for the CLI.
 *
 * These two functions are byte-for-byte equivalent to the implementations in
 * `config/loader.ts` (see `getNestedValue` / `setNestedValue` there). They
 * are inlined here so the IPC-tagged `config` command can walk dotted paths
 * without importing `config/loader.js`, which has module-level side effects
 * (config cache, file watcher, etc.) inappropriate for the CLI process.
 *
 * Loader and CLI both call `setNestedValue("a.b.c", v)`-style helpers - if
 * the behavior needs to change in one place, change it in both.
 */

export function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
