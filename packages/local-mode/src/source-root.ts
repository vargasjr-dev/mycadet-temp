/**
 * Where the cadet SOURCE tree lives on this machine, as the local remote
 * resolvers (assistant index, gateway dir, CES dir) see it.
 *
 * Local-mode is consumed from two kinds of hosts: the CLI — running under
 * bun from source or npm, where a module can find the tree relative to its
 * own file — and bundled hosts (the desktop's electron main, the compiled
 * CLI binary), where a module's file position is meaningless or absent and
 * `import.meta.dir` resolves to nothing. So the resolvers no longer ask
 * the module system where they are: the entrypoint that launches the
 * process REPORTS the tree once at startup, and every resolver consults
 * the report before its filesystem probes (packaged runtime installs,
 * npm siblings, cwd walks).
 *
 * `CADET_SOURCE_ROOT` carries the same value across subprocess spawns so
 * a host that already knows the root (the desktop's dev flow) can hand it
 * to every CLI child without each one rediscovering it.
 */
let configuredSourceRoot: string | undefined;

export function setLocalSourceRoot(root: string): void {
  configuredSourceRoot = root;
}

export function getLocalSourceRoot(): string | undefined {
  if (configuredSourceRoot !== undefined) return configuredSourceRoot;
  const fromEnv = process.env.CADET_SOURCE_ROOT;
  if (fromEnv) {
    configuredSourceRoot = fromEnv;
    return configuredSourceRoot;
  }
  return undefined;
}

/** Test seam: drop the configured root so a case exercises the probes. */
export function resetLocalSourceRoot(): void {
  configuredSourceRoot = undefined;
  delete process.env.CADET_SOURCE_ROOT;
}
