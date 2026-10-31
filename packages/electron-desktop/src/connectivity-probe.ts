import { app, BrowserWindow, net, powerMonitor } from "electron";

import { readLockfile } from "@mycadet/local-mode";
import { setBackendReachable } from "./status";

const PROBE_INTERVAL_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

let probeTimer: ReturnType<typeof setInterval> | null = null;
let probing = false;

/**
 * The active assistant's loopback gateway healthz URL, or undefined when
 * there is nothing on this machine to probe: no active entry, a non-loopback
 * cloud (its health rides the platform's operational-status polling), or an
 * entry whose gateway port is not recorded.
 */
function activeLoopbackGatewayHealthz(): string | undefined {
  const { assistants, activeAssistant } = readLockfile();
  const entry = assistants.find((a) => a.assistantId === activeAssistant);
  // Cloud wins over resources: merges can leave a stale gatewayPort on a
  // non-local entry, and it must not be loopback-probed.
  if (!entry || (entry.cloud !== "local" && entry.cloud !== "docker")) {
    return undefined;
  }
  if (!entry.port) {
    return undefined;
  }
  return `http://127.0.0.1:${entry.port}/healthz`;
}

async function runProbeOnce(): Promise<void> {
  if (probing) {
    return;
  }
  probing = true;
  try {
    const url = activeLoopbackGatewayHealthz();
    if (!url) {
      return;
    }
    const ok = await net
      .fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      .then((r) => r.ok)
      .catch(() => false);
    setBackendReachable(ok);
  } finally {
    probing = false;
  }
}

function hasVisibleWindow(): boolean {
  return BrowserWindow.getAllWindows().some(
    (w) => !w.isDestroyed() && w.isVisible(),
  );
}

function startProbing(): void {
  if (probeTimer) {
    return;
  }
  void runProbeOnce();
  probeTimer = setInterval(() => void runProbeOnce(), PROBE_INTERVAL_MS);
}

function stopProbing(): void {
  if (!probeTimer) {
    return;
  }
  clearInterval(probeTimer);
  probeTimer = null;
}

export function installConnectivityProbe(): () => Promise<void> {
  // Returns the probe's promise so the manual-retry IPC handler can await
  // completion before reporting the post-probe state back to the renderer.
  const runProbe = () => runProbeOnce();

  powerMonitor.on("suspend", stopProbing);
  powerMonitor.on("resume", () => startProbing());

  app.on("browser-window-focus", () => {
    if (!probeTimer) {
      startProbing();
    }
  });

  app.on("browser-window-blur", () => {
    if (!hasVisibleWindow()) {
      stopProbing();
    }
  });

  startProbing();
  return runProbe;
}
