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
        return;
      }
      if (recreateFailure) throw recreateFailure;
      return;
    }
  },
);
let logSpy: ReturnType<typeof spyOn>;

mock.module("../exec", () => ({
  ...realExecModule,
  exec: execModuleMock,
}));
mock.module("../remotes/docker/common", () => ({
  ...realDockerCommon,
  ensureDockerDaemonRunning: async () => {},
}));
mock.module("../remotes/docker/hatch", () => ({
  ...realHatch,
  pullImage: async () => {},
}));

afterAll(() => {
  mock.module("../exec", () => realExecModule);
  mock.module("../remotes/docker/common", () => realDockerCommon);
  mock.module("../remotes/docker/hatch", () => realHatch);
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
});
