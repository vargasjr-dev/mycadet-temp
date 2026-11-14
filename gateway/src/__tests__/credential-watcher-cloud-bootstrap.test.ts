import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeAssistantIpc } from "./fake-assistant-ipc.js";
import { startTestCesRecordServer } from "@mycadet/ces-client/test-support";

const testDir = join(tmpdir(), `gw-managed-${Date.now()}-${Math.random()}`);
const cesSocketDir = join(testDir, "ces-ipc");

const __dirname = dirname(fileURLToPath(import.meta.url));
const gatewayRoot = join(__dirname, "..", "..");
const gatewayEntry = join(gatewayRoot, "src", "index.ts");

let gatewayProc: ChildProcess | null = null;
let gatewayPort = 0;
let fakeCes: ReturnType<typeof startTestCesRecordServer> | null = null;
let fakeAssistantIpc: Server | null = null;

/** Ask the OS for a free port by briefly binding to port 0. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to get free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Wait for a child process to exit, with a safety timeout. */
function waitForExit(proc: ChildProcess, timeoutMs = 5_000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startGateway(): Promise<void> {
  gatewayPort = await getFreePort();

  const workspaceDir = join(testDir, ".cadet", "workspace");
  fakeAssistantIpc = startFakeAssistantIpc(workspaceDir);

  gatewayProc = spawn("bun", ["run", gatewayEntry], {
    env: {
      ...process.env,
      GATEWAY_SECURITY_DIR: join(testDir, ".cadet", "protected"),
      CADET_WORKSPACE_DIR: workspaceDir,
      GATEWAY_PORT: String(gatewayPort),
      IS_CONTAINERIZED: "true",
      CES_SOCKET_DIR: cesSocketDir,
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_WEBHOOK_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Collect stderr for diagnostics on failure.
  const stderrChunks: Buffer[] = [];
  gatewayProc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  // Track early exit so we can fail fast instead of polling for 30s.
  let earlyExitCode: number | null = null;
  let earlyExitSignal: string | null = null;
  gatewayProc.on("exit", (code, signal) => {
    earlyExitCode = code;
    earlyExitSignal = signal;
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // If the process already died, fail immediately with stderr.
    if (earlyExitCode !== null || earlyExitSignal !== null) {
      const stderr = Buffer.concat(stderrChunks).toString().slice(-2000);
      throw new Error(
        `Gateway exited early (code=${earlyExitCode}, signal=${earlyExitSignal})\n${stderr}`,
      );
    }
    try {
      const res = await fetch(`http://localhost:${gatewayPort}/healthz`);
      if (res.ok) return;
    } catch {
      // Gateway not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const stderr = Buffer.concat(stderrChunks).toString().slice(-2000);
  throw new Error(
    `Gateway failed to start within 30 seconds\nstderr: ${stderr}`,
  );
}

/** Seed the fake CES sidecar with the two telegram credentials. */
function seedTelegramCredentials(): void {
  if (!fakeCes) {
    throw new Error("fake CES not started");
  }
  const records = [
    recordForAccount("credential/telegram/bot_token"),
    recordForAccount("credential/telegram/webhook_secret"),
  ];
  for (const { account, record } of records) {
    fakeCes.records.set(account, record);
  }
  fakeCes.secrets.set("credential/telegram/bot_token", "fake-bot-token:ABC123");
  fakeCes.secrets.set(
    "credential/telegram/webhook_secret",
    "fake-webhook-secret",
  );
}

function recordForAccount(account: string) {
  const parts = account.split("/");
  const service = parts[1] ?? "unknown";
  const field = parts.slice(2).join("/") || "unknown";
  return {
    account,
    record: {
      credentialId: `cred-${account}`,
      service,
      field,
      allowedTools: [] as string[],
      allowedDomains: [] as string[],
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

/**
 * Bind the fake CES sidecar on the socket dir the gateway child already
 * dials. Accounts are listed from the record catalog; credential values are
 * read from the secret store, so seeding them later simulates "CES is up but
 * the configured reads are not ready yet".
 */
function startFakeCes(): void {
  fakeCes = startTestCesRecordServer({ socketDir: cesSocketDir });
}

afterEach(async () => {
  fakeAssistantIpc?.close();
  fakeAssistantIpc = null;
  await fakeCes?.stop();
  fakeCes = null;
  gatewayPort = 0;

  if (gatewayProc) {
    const proc = gatewayProc;
    gatewayProc = null;
    proc.kill("SIGKILL");
    // Wait for the process to actually exit so ports and file handles are
    // fully released before the next test starts.
    await waitForExit(proc);
  }

  rmSync(testDir, { recursive: true, force: true });
});

describe("gateway cloud credential bootstrap retry", () => {
  test("reloads Telegram after CES becomes reachable without a metadata rewrite", async () => {
    mkdirSync(testDir, { recursive: true });

    // The gateway starts while CES is still absent — the managed bootstrap
    // keeps polling the socket dir until the fake sidecar appears below.
    await startGateway();

    const base = `http://localhost:${gatewayPort}`;
    const before = await fetch(`${base}/webhooks/telegram`, { method: "POST" });
    expect(before.status).toBe(503);

    startFakeCes();
    seedTelegramCredentials();

    const deadline = Date.now() + 5_000;
    let status = before.status;
    while (Date.now() < deadline) {
      const resp = await fetch(`${base}/webhooks/telegram`, {
        method: "POST",
      });
      status = resp.status;
      if (status === 401) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(status).toBe(401);
  }, 45_000);

  test("keeps retrying until configured credential reads succeed after CES list is already available", async () => {
    mkdirSync(testDir, { recursive: true });

    // CES is up from the start and lists the configured services, but the
    // credential reads are not ready — only the record catalog is seeded.
    startFakeCes();
    for (const account of [
      "credential/telegram/bot_token",
      "credential/telegram/webhook_secret",
    ]) {
      const { account: name, record } = recordForAccount(account);
      fakeCes!.records.set(name, record);
    }

    await startGateway();

    const base = `http://localhost:${gatewayPort}`;
    const before = await fetch(`${base}/webhooks/telegram`, { method: "POST" });
    expect(before.status).toBe(503);

    // The reads succeed: the secrets land and telegram becomes healthy.
    fakeCes!.secrets.set(
      "credential/telegram/bot_token",
      "fake-bot-token:ABC123",
    );
    fakeCes!.secrets.set(
      "credential/telegram/webhook_secret",
      "fake-webhook-secret",
    );

    const deadline = Date.now() + 5_000;
    let status = before.status;
    while (Date.now() < deadline) {
      const resp = await fetch(`${base}/webhooks/telegram`, {
        method: "POST",
      });
      status = resp.status;
      if (status === 401) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(status).toBe(401);
  }, 45_000);
});
