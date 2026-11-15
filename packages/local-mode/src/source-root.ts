/**
 * The cadet source tree the local service resolvers run from, reported by
 * the process's entrypoint because bundled hosts have no file position.
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
