import { Socket } from "node:net";

const PROBE_TIMEOUT_MS = 750;

/**
 * Whether something is listening on `port` (a connect probe). Its own module
 * so the allocators that call it keep a mockable seam — a same-module call
 * could never be intercepted by the tests that fake the network.
 */
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
