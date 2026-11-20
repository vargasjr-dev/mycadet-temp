/**
 * Docker hatch harness for the release integration suite.
 *
 * Boots the exact production topology — the declarative statefulset spec
 * (assistant container owning a bridge network, gateway and
 * credential-executor sidecars sharing its network namespace, the shared
 * volumes) — from three image refs supplied by the environment, waits for
 * the gateway's `/readyz`, and hands the running hatch to the tests.
 *
 * Every boot uses a fresh instance name, so the volumes are fresh — this is
 * what reproduces the fresh-volume failure class (a volume mode or socket
 * permission bug never exists at image build time; it only exists when a
 * fresh volume meets a non-root process at container start).
 *
 * Image refs come from the environment (`QA_ASSISTANT_IMAGE`,
 * `QA_GATEWAY_IMAGE`, `QA_CES_IMAGE`). The release pipeline passes digest
 * refs of the images it just pushed; PR QA passes locally built tags.
 *
 * Error discipline mirrors local-mode's exec: never include the docker argv
 * in a thrown message — run args carry `-e` env flags that may hold
 * provider keys when the host exports them. Step name plus stderr tail only.
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

import { dockerResourceNames } from "@mycadet/local-mode/docker-resource-names";
import {
  buildServiceRunArgs,
  DOCKER_STATEFUL_SET_SPEC,
  resolveAvatarDevicePath,
  type ServiceName,
} from "@mycadet/local-mode/docker-hatch-spec";

/** The env keys the harness reads image refs from, per service. */
const IMAGE_ENV_KEYS: Record<ServiceName, string> = {
  assistant: "QA_ASSISTANT_IMAGE",
  gateway: "QA_GATEWAY_IMAGE",
  "credential-executor": "QA_CES_IMAGE",
};

const SERVICES = Object.keys(IMAGE_ENV_KEYS) as ServiceName[];

/**
 * The image refs the hatch should boot, or null when the environment does
 * not supply them (a local `bun test .` without the QA_* env — the suite
 * skips; in CI the workflow fails the job before the tests run, so a null
 * here can never silently pass a release).
 */
export function resolveQaImageRefs(): Record<ServiceName, string> | null {
  const refs = {} as Record<ServiceName, string>;
  let complete = true;
  for (const svc of SERVICES) {
    const value = process.env[IMAGE_ENV_KEYS[svc]]?.trim() ?? "";
    if (value.length === 0) complete = false;
    refs[svc] = value;
  }
  return complete ? refs : null;
}

/** A running hatch, plus everything teardown needs. */
export interface QaHatch {
  instanceName: string;
  res: ReturnType<typeof dockerResourceNames>;
  containers: Record<ServiceName, string>;
  gatewayPort: number;
}

interface DockerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function docker(args: string[]): DockerResult {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = (r.stderr ?? "").toString();
  const stdout = (r.stdout ?? "").toString();
  const failed = r.error !== undefined || (r.status ?? 1) !== 0;
  return { ok: !failed, stdout, stderr };
}

/** Never include argv — docker args may carry env values (see module docs). */
function dockerOrThrow(args: string[], what: string): string {
  const r = docker(args);
  if (!r.ok) {
    const tail = (r.stderr || r.stdout)
      .trim()
      .split("\n")
      .slice(-10)
      .join("\n");
    throw new Error(`qa hatch: ${what} failed\n${tail}`);
  }
  return r.stdout;
}

/**
 * A free loopback port for the gateway's host edge (the assistant HTTP API
 * binds loopback-only, mirroring the production hatch's placement).
 */
function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close(() =>
        port > 0 ? resolve(port) : reject(new Error("port allocation failed")),
      );
    });
  });
}

async function waitForReady(
  origin: string,
  readiness: { endpoint: string; timeoutMs: number; intervalMs: number },
): Promise<boolean> {
  const deadline = Date.now() + readiness.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${origin}${readiness.endpoint}`, {
        signal: AbortSignal.timeout(readiness.intervalMs),
      });
      if (r.ok) return true;
    } catch {
      // Not ready yet — poll until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, readiness.intervalMs));
  }
  return false;
}

function tailLogs(hatch: QaHatch): string {
  const parts: string[] = [];
  for (const [svc, container] of Object.entries(hatch.containers)) {
    const logs = docker(["logs", "--tail", "40", container]);
    parts.push(
      `── ${svc} (${container}) ──\n${(logs.stderr || logs.stdout).trim()}`,
    );
  }
  return parts.join("\n");
}

/**
 * Boot the three just-built images as a docker hatch: fresh network, fresh
 * volumes (the six the recreate path pre-creates — ces-data relies on
 * docker's auto-create in production too), assistant first, then the
 * sidecars, then the gateway's `/readyz` per the spec's timeouts.
 */
export async function startQaHatch(
  log: (message: string) => void = () => {},
): Promise<QaHatch> {
  const imageRefs = resolveQaImageRefs();
  if (imageRefs === null) {
    throw new Error(
      `qa hatch: image refs missing — set ${SERVICES.map((s) => IMAGE_ENV_KEYS[s]).join(", ")}`,
    );
  }

  const instanceName = `qa-${randomUUID().slice(0, 8)}`;
  const res = dockerResourceNames(instanceName);
  const gatewayPort = await allocatePort();
  const device = randomUUID();

  log(`network: ${res.network}`);
  dockerOrThrow(["network", "create", res.network], "create network");

  // The six volumes the production recreate path pre-creates, in the same
  // order — fresh named volumes every boot.
  for (const volume of [
    res.socketVolume,
    res.assistantIpcVolume,
    res.gatewayIpcVolume,
    res.workspaceVolume,
    res.gatewaySecurityVolume,
    res.cesSecurityVolume,
  ]) {
    log(`volume: ${volume}`);
    dockerOrThrow(["volume", "create", volume], `create volume ${volume}`);
  }

  const runArgs = buildServiceRunArgs({
    extraAssistantEnv: { CADET_DEVICE_ID: device },
    extraGatewayEnv: { CADET_DEVICE_ID: device },
    gatewayPort,
    imageTags: imageRefs,
    instanceName,
    res,
    avatarDevicePath: resolveAvatarDevicePath(),
  });

  const containers: Record<ServiceName, string> = {
    assistant: res.assistantContainer,
    gateway: res.gatewayContainer,
    "credential-executor": res.cesContainer,
  };

  // The assistant owns the instance's network namespace, so it starts first
  // — the same ordering startAssistantThenSidecars enforces in production.
  log(`starting ${containers.assistant}`);
  dockerOrThrow(["run", ...runArgs.assistant()], "start assistant container");
  log(`starting ${containers.gateway}, ${containers["credential-executor"]}`);
  await Promise.all([
    (async () =>
      dockerOrThrow(["run", ...runArgs.gateway()], "start gateway sidecar"))(),
    (async () =>
      dockerOrThrow(
        ["run", ...runArgs["credential-executor"]()],
        "start credential-executor sidecar",
      ))(),
  ]);

  const hatch: QaHatch = {
    instanceName,
    res,
    containers,
    gatewayPort,
  };

  const ready = await waitForReady(
    `http://127.0.0.1:${gatewayPort}`,
    DOCKER_STATEFUL_SET_SPEC.readiness,
  );
  if (!ready) {
    throw new Error(
      `qa hatch: containers did not become ready within ${DOCKER_STATEFUL_SET_SPEC.readiness.timeoutMs}ms\n${tailLogs(hatch)}`,
    );
  }
  log(`hatch ready on gateway port ${gatewayPort}`);
  return hatch;
}

/** Best-effort teardown: containers, volumes, network. Never throws. */
export function stopQaHatch(hatch: QaHatch): void {
  for (const container of Object.values(hatch.containers)) {
    docker(["rm", "-f", container]);
  }
  for (const volume of [
    hatch.res.socketVolume,
    hatch.res.assistantIpcVolume,
    hatch.res.gatewayIpcVolume,
    hatch.res.workspaceVolume,
    hatch.res.gatewaySecurityVolume,
    hatch.res.cesSecurityVolume,
    `${hatch.instanceName}-ces-data`,
  ]) {
    docker(["volume", "rm", "-f", volume]);
  }
  docker(["network", "rm", hatch.res.network]);
}
