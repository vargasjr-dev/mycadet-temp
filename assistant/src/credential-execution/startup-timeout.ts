import { CesRpcClient as CesClient } from "@mycadet/ces-client/rpc-client";

export const DEFAULT_CES_STARTUP_TIMEOUT_MS = 20_000;

export async function awaitCesClientWithTimeout(
  clientPromise: Promise<CesClient | undefined>,
  options: { timeoutMs?: number; onTimeout?: () => void } = {},
): Promise<CesClient | undefined> {
  const { timeoutMs = DEFAULT_CES_STARTUP_TIMEOUT_MS, onTimeout = () => {} } =
    options;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      clientPromise,
      new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(() => {
          onTimeout();
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
