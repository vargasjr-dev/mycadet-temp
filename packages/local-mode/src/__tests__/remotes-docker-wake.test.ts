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
const realRecreate = {
  ...(await import("../remotes/docker/recreate")),
};

/**
 * The recreate arm under test: `wakeDocker` starts the three service
 * containers; a "No such container" failure (a migrated install whose
 * volumes hold data but whose containers were never created) is healed by
 * recreating the group from the entry's recorded images and retrying the
 * start once. The exec fake models the daemon's answers per round of three
 * `docker start` calls.
 */
let startFailures: (string | undefined)[];
let recreateFailure: Error | undefined;

const execModuleMock = mock(
  async (cmd: string, args: string[] = []): Promise<void> => {
    if (cmd === "docker" && args[0] === "start") {
      startCalls++;
      const failure = startFailures.shift();
      if (failure) throw new Error(failure);
      return;
    }
  },
);
let startCalls = 0;
let logSpy: ReturnType<typeof spyOn>;

const recreateDockerContainersMock = mock<
  typeof realRecreate.recreateDockerContainers
>(async () => {});

mock.module("../exec", () => ({
  ...realExecModule,
  exec: execModuleMock,
}));
mock.module("../remotes/docker/common", () => ({
  ...realDockerCommon,
  ensureDockerDaemonRunning: async () => {},
}));
mock.module("../remotes/docker/recreate", () => ({
  ...realRecreate,
  recreateDockerContainers: recreateDockerContainersMock,
}));

afterAll(() => {
  mock.module("../exec", () => realExecModule);
  mock.module("../remotes/docker/common", () => realDockerCommon);
  mock.module("../remotes/docker/recreate", () => realRecreate);
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

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  startCalls = 0;
  startFailures = [];
  recreateFailure = undefined;
  recreateDockerContainersMock.mockReset();
  recreateDockerContainersMock.mockImplementation(async () => {
    if (recreateFailure) throw recreateFailure;
  });
});

afterEach(() => {
  logSpy.mockRestore();
  recreateDockerContainersMock.mockReset();
});

describe("wakeDocker — the docker wake leg", () => {
  test("starts the three containers and narrates once", async () => {
    const result = await wakeDocker(makeEntry());

    expect(result).toEqual({ ok: true });
    expect(startCalls).toBe(3);
    expect(recreateDockerContainersMock).not.toHaveBeenCalled();
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
    expect(recreateDockerContainersMock).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "docker-1" }),
    );
    expect(startCalls).toBe(4); // one aborted start + the retried round of three
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
    recreateFailure = new Error(
      "no container images recorded for 'docker-1' — re-hatch or run `cadet upgrade` to set them",
    );

    const result = await wakeDocker(makeEntry());

    expect(result).toEqual({
      ok: false,
      status: 500,
      error:
        "no container images recorded for 'docker-1' — re-hatch or run `cadet upgrade` to set them",
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
    expect(recreateDockerContainersMock).not.toHaveBeenCalled();
  });
});
