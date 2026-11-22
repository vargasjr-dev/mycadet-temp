import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// can restore them — bun runs every test file in one process with a shared
// loader, and `mock.restore()` does not undo `mock.module()`.
const realExecModule = { ...(await import("../exec")) };
const realDockerCommon = {
  ...(await import("../remotes/docker/common")),
};
const realHatch = { ...(await import("../remotes/docker/hatch")) };
const realDaemonReadiness = { ...(await import("../daemon-readiness")) };

/**
 * The recreate arm under test: `wakeDocker` starts the three service
 * containers; a "No such container" failure (a migrated install whose
 * volumes hold data but whose containers were never created) is healed by
 * recreating the group from the entry's recorded images and retrying the
 * start once. The exec fake answers every docker command the recreate path
 * runs — start, rm, inspect, create, pull, run.
 */
type DockerCommand = { cmd: string; args: string[] };
let dockerCalls: DockerCommand[] = [];
let startFailures: (string | undefined)[];
let recreateFailure: Error | undefined;

const execModuleMock = mock(
  async (cmd: string, args: string[] = []): Promise<void> => {
    if (cmd === "docker") {
      dockerCalls.push({ cmd, args: [...args] });
      if (args[0] === "start") {
        const failure = startFailures.shift();
        if (failure) throw new Error(failure);
        const container = args[1] ?? "";
        if (!runningSince.has(container)) {
          runningSince.set(container, "2026-11-22T12:00:00.123456789Z");
        }
        return;
      }
      if (recreateFailure) throw recreateFailure;
      return;
    }
  },
);
const execOutputModuleMock = mock(
  async (_cmd: string, args: string[] = []): Promise<string> => {
    if (args[0] === "inspect" && args[2] === "{{.Config.Image}}") {
      dockerCalls.push({ cmd: "docker", args: [...args] });
      // Answer per container so the probe's service-by-service comparison
      // sees each service's own image (the default beforeEach sets "no
      // drift": every container reports its lockfile image).
      const container = args[3] ?? "";
      if (container.endsWith("-gateway")) {
        return "mycadet/mycadet-gateway:v0.12.7";
      }
      if (container.endsWith("-credential-executor")) {
        return "mycadet/mycadet-credential-executor:v0.12.7";
      }
      return inspectedImage;
    }
    if (args[0] === "container" && args[2] === "--format") {
      const since = runningSince.get(args[4] ?? "");
      return since ? `true ${since}` : "false 0001-01-01T00:00:00Z";
    }
    throw new Error(`unexpected execOutput: ${args.join(" ")}`);
  },
);
/** The image the drift probe sees on the existing containers. */
let inspectedImage: string;
/** Which containers are running, and when they started. */
let runningSince: Map<string, string>;
let logSpy: ReturnType<typeof spyOn>;

mock.module("../exec", () => ({
  ...realExecModule,
  exec: execModuleMock,
  execOutput: execOutputModuleMock,
}));
mock.module("../remotes/docker/common", () => ({
  ...realDockerCommon,
  ensureDockerDaemonRunning: async () => {},
}));
mock.module("../remotes/docker/hatch", () => ({
  ...realHatch,
  pullImage: async () => {},
}));
// The wake always waits for the gateway's /readyz — answer from here instead
// of a real loopback fetch (nothing listens on the entry's port in tests).
let readyResult: boolean;
const waitForReadyMock = mock(
  async (_runtimeUrl: string): Promise<boolean> => readyResult,
);
mock.module("../daemon-readiness", () => ({
  ...realDaemonReadiness,
  waitForReady: waitForReadyMock,
}));

afterAll(() => {
  mock.module("../exec", () => realExecModule);
  mock.module("../remotes/docker/common", () => realDockerCommon);
  mock.module("../remotes/docker/hatch", () => realHatch);
  mock.module("../daemon-readiness", () => realDaemonReadiness);
});

import type { DockerAssistant } from "../lockfile-contract";
import { wakeDocker } from "../remotes/docker/wake";

const NO_SUCH_CONTAINER =
  "Error response from daemon: No such container: docker-1-assistant";

function makeEntry(): DockerAssistant {
  return {
    assistantId: "docker-1",
    cloud: "docker",
    port: 7830,
    containerInfo: {
      assistantImage: "mycadet/mycadet-assistant:v0.12.7",
      gatewayImage: "mycadet/mycadet-gateway:v0.12.7",
      cesImage: "mycadet/mycadet-credential-executor:v0.12.7",
    },
  };
}

const startedContainers = (): number =>
  dockerCalls.filter(({ args }) => args[0] === "start").length;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  dockerCalls = [];
  startFailures = [];
  recreateFailure = undefined;
  // Default: the existing containers run exactly what the lockfile says —
  // the plain-start wake. Drift tests override this.
  inspectedImage = "mycadet/mycadet-assistant:v0.12.7";
  runningSince = new Map();
  readyResult = true;
  waitForReadyMock.mockClear();
});

afterEach(() => {
  logSpy.mockRestore();
});

describe("wakeDocker — the docker wake leg", () => {
  test("starts the three containers and narrates once", async () => {
    const result = await wakeDocker(makeEntry());

    expect(result).toEqual({ ok: true });
    expect(startedContainers()).toBe(3);
    expect(logSpy).toHaveBeenCalledWith("Docker containers started.");
  });

  test("a crashed assistant restarts the sidecars still running on its old network", async () => {
    runningSince = new Map([
      ["docker-1-gateway", "2026-11-22T10:00:00.5Z"],
      ["docker-1-credential-executor", "2026-11-22T10:00:00.5Z"],
    ]);

    const result = await wakeDocker(makeEntry());

    expect(result).toEqual({ ok: true });
    const restarted = dockerCalls
      .filter(({ args }) => args[0] === "restart")
      .map(({ args }) => args[1]);
    expect(restarted).toEqual([
      "docker-1-gateway",
      "docker-1-credential-executor",
    ]);
  });

  test("a running assistant leaves its sidecars alone", async () => {
    runningSince = new Map([
      ["docker-1-assistant", "2026-11-22T10:00:00.1Z"],
      ["docker-1-gateway", "2026-11-22T10:00:00.2Z"],
      ["docker-1-credential-executor", "2026-11-22T10:00:00.2Z"],
    ]);

    await wakeDocker(makeEntry());

    expect(dockerCalls.some(({ args }) => args[0] === "restart")).toBe(false);
  });

  test("a never-created container group is recreated from the recorded images and the start retried", async () => {
    // The v0.0.10 run feedback: the containers were never created — the
    // first `docker start` round answers "No such container", the recreate
    // builds the group, and the retry brings it up.
    startFailures = [
      NO_SUCH_CONTAINER,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ];

    const result = await wakeDocker(makeEntry());

    expect(result).toEqual({ ok: true });
    // one aborted start + the retried round of three
    expect(startedContainers()).toBe(4);
    expect(logSpy).toHaveBeenCalledWith(
      "Containers for 'docker-1' don't exist yet — recreating from the recorded images...",
    );
    expect(logSpy).toHaveBeenCalledWith("Docker containers started.");
  });

  test("a partly missing group is removed before it is recreated", async () => {
    startFailures = [undefined, NO_SUCH_CONTAINER];

    await wakeDocker(makeEntry());

    const firstRun = dockerCalls.findIndex((c) => c.args[0] === "run");
    expect(dockerCalls.slice(0, firstRun)).toContainEqual({
      cmd: "docker",
      args: ["rm", "--force", "docker-1-assistant"],
    });
  });

  test("the wake waits for the gateway's /readyz before reporting ok", async () => {
    const result = await wakeDocker(makeEntry());

    expect(waitForReadyMock).toHaveBeenCalledWith("http://127.0.0.1:7830");
    expect(result.ok).toBe(true);
  });

  test("a ready wait that never comes answers 500", async () => {
    readyResult = false;

    const result = await wakeDocker(makeEntry());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.error).toBe(
      "Containers failed to become ready within the timeout.",
    );
  });

  test("a recreate failure comes back as a structured 500 — the leg never throws", async () => {
    startFailures = [
      NO_SUCH_CONTAINER,
      NO_SUCH_CONTAINER,
      NO_SUCH_CONTAINER,
      NO_SUCH_CONTAINER,
      NO_SUCH_CONTAINER,
      NO_SUCH_CONTAINER,
    ];
    recreateFailure = new Error("docker network create failed");

    const result = await wakeDocker(makeEntry());

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "docker network create failed",
    });
  });

  test("a real docker failure carries the error raw and never recreates", async () => {
    startFailures = ["Cannot connect to the Docker daemon"];

    const result = await wakeDocker(makeEntry());

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "Cannot connect to the Docker daemon",
    });
  });

  test("a container whose image drifted from the lockfile is recreated from the lockfile", async () => {
    // The hand-edited-lockfile case: `docker start` would resurrect the
    // creation-time image; the wake must pull and recreate instead.
    inspectedImage = "mycadet/mycadet-assistant:v0.13.0-dev";

    const result = await wakeDocker(makeEntry());

    expect(result).toEqual({ ok: true });
    expect(startedContainers()).toBe(3);
    expect(logSpy).toHaveBeenCalledWith(
      "Containers for 'docker-1' don't match the lockfile's images — recreating...",
    );
  });

  test("an unreadable image probe keeps the legacy plain-start wake", async () => {
    // Drift detection is best-effort: when the image probe cannot answer,
    // the leg falls back to `docker start` (whose own failure, if any,
    // surfaces raw).
    execOutputModuleMock.mockImplementation(async () => {
      throw new Error("docker inspect blew up");
    });

    const result = await wakeDocker(makeEntry());

    expect(result).toEqual({ ok: true });
    expect(startedContainers()).toBe(3);
    expect(logSpy).not.toHaveBeenCalledWith(
      "Containers for 'docker-1' don't match the lockfile's images — recreating...",
    );
  });
});
