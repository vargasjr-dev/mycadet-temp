import { createServer, Socket } from "node:net";

import { SEEDS, type PortMap } from "@mycadet/environments";

import { resolveEnvironmentName } from "./environment";

/**
 * The default port set for an environment, and the port allocators the
 * lifecycle operations share (hatch's placement, wake's port heal, the
 * daemon/gateway starts). Environment-scoped seeds shift the base blocks
 * (non-prod environments get separate ranges so multi-env setups never
 * collide); the allocators walk upward from a base so sibling instances
 * land on legible consecutive ports.
 */
export const DEFAULT_PORTS: Readonly<PortMap> = {
  daemon: 7821,
  gateway: 7830,
  qdrant: 6333,
  ces: 8090,
  outboundProxy: 8080,
  tcp: 8765,
};

/** Default port set for the current environment (seed overrides applied). */
export function getDefaultPorts(): PortMap {
  const seed = SEEDS[resolveEnvironmentName()];
  return {
    ...DEFAULT_PORTS,
    ...(seed?.portsOverride ?? {}),
  };
}

/** Named constants derived from {@link DEFAULT_PORTS}: the ports the
 * assistant and gateway services bind inside their container or process,
 * stable across environments. */
export const ASSISTANT_INTERNAL_PORT = DEFAULT_PORTS.daemon;
export const GATEWAY_INTERNAL_PORT = DEFAULT_PORTS.gateway;

const PROBE_TIMEOUT_MS = 750;

/** Whether something is listening on `port` (a connect probe). */
export function probePort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/**
 * Walks upward from `preferred` and returns the first host port that the
 * kernel will let us bind to. Used by `hatchDocker` to pick the gateway's
 * host-side port instead of always grabbing the env-default (e.g. 7830 /
 * 20100), which collides with any other local assistant — eval-spawned or
 * otherwise — already bound there.
 *
 * Walks linearly from `preferred` upward rather than asking the kernel for
 * an arbitrary ephemeral port (`listen(0)`) so the resulting port stays
 * legible to operators — three local assistants land on N, N+1, N+2
 * instead of three random numbers in the 32768-60999 range.
 */
export async function findOpenPort(
  preferred: number,
  options: { maxAttempts?: number; host?: string; exclude?: number[] } = {},
): Promise<number> {
  const maxAttempts = options.maxAttempts ?? 50;
  const host = options.host ?? "0.0.0.0";
  const exclude = new Set(options.exclude ?? []);

  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) {
    throw new Error(
      `findOpenPort: preferred port ${preferred} is not a valid TCP port`,
    );
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      `findOpenPort: maxAttempts ${maxAttempts} must be a positive integer`,
    );
  }

  let lastError: Error | null = null;
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = preferred + offset;
    if (port > 65535) break;
    if (exclude.has(port)) continue;
    try {
      await probeBindPort(port, host);
      return port;
    } catch (err) {
      lastError = err as Error;
      if (!isPortInUseError(err)) {
        // EACCES / EPERM / etc. are not "try the next port" signals — those
        // are configuration problems an operator needs to see immediately.
        throw err;
      }
    }
  }
  throw new Error(
    `findOpenPort: no open port in range [${preferred}, ${preferred + maxAttempts - 1}]` +
      (lastError ? ` (last error: ${lastError.message})` : ""),
  );
}

/**
 * Resolves if `port` on `host` can be bound right now. Rejects with the
 * server's `error` event (typically `EADDRINUSE`) otherwise. Always closes
 * the probe server before resolving so we don't leak the port we just
 * proved was free.
 */
function probeBindPort(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const cleanup = (cb: () => void): void => {
      server.removeAllListeners();
      server.close(() => cb());
    };
    server.once("error", (err) => {
      // close() on a server that never listened is a no-op; calling it
      // anyway keeps cleanup uniform.
      cleanup(() => reject(err));
    });
    server.once("listening", () => {
      cleanup(() => resolve());
    });
    server.listen(port, host);
  });
}

function isPortInUseError(err: unknown): boolean {
  if (err instanceof Error && "code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EADDRINUSE" || code === "EADDRNOTAVAIL";
  }
  return false;
}

/**
 * Scan upward from `basePort` to find an available port. A port is considered
 * available when `probePort()` returns false (nothing listening). Scans up to
 * 100 ports above the base before giving up.
 */
export async function findAvailablePort(basePort: number): Promise<number> {
  const maxOffset = 100;
  for (let offset = 0; offset < maxOffset; offset++) {
    const port = basePort + offset;
    const inUse = await probePort(port);
    if (!inUse) return port;
  }
  throw new Error(
    `Could not find an available port scanning from ${basePort} to ${basePort + maxOffset - 1}`,
  );
}
