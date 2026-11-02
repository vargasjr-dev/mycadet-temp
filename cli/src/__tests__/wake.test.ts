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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as assistantConfig from "../lib/assistant-config.js";
import * as localModeModule from "@mycadet/local-mode";
import * as docker from "../lib/remotes/docker.js";
import * as ngrok from "../lib/tunnels/ngrok.js";
import * as rootSigningKey from "../lib/root-signing-key.js";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

const realAssistantConfig = { ...assistantConfig };
const realLocalMode = { ...localModeModule };
const realDocker = { ...docker };
const realNgrok = { ...ngrok };
const realRootSigningKey = { ...rootSigningKey };

const resolveTargetAssistantMock =
  mock<typeof assistantConfig.resolveTargetAssistant>();
const loadAllAssistantsMock = mock<typeof localModeModule.loadAllAssistants>(
  () => [],
);
const saveLockfileAssistantMock = mock<
  typeof localModeModule.saveLockfileAssistant
>(() => ({ ok: true, lockfile: { assistants: [], activeAssistant: null } }));

mock.module("../lib/assistant-config.js", () => ({
  ...realAssistantConfig,
  resolveTargetAssistant: resolveTargetAssistantMock,
}));

const wakeLocalMock = mock<typeof localModeModule.wakeLocal>(async () => ({
  ok: true,
}));
const wakeDockerMock = mock<typeof localModeModule.wakeDocker>(async () => ({
  ok: true,
}));
const dockerResourceNamesMock = mock<
  typeof localModeModule.dockerResourceNames
>(localModeModule.dockerResourceNames);
const recreateDockerContainersMock = mock<
  typeof docker.recreateDockerContainers
>(async () => {});
const waitForDaemonReadyMock = mock<typeof localModeModule.waitForDaemonReady>(
  async () => true,
);
mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  saveLockfileAssistant: saveLockfileAssistantMock,
  loadAllAssistants: loadAllAssistantsMock,
  wakeLocal: wakeLocalMock,
  wakeDocker: wakeDockerMock,
  dockerResourceNames: dockerResourceNamesMock,
  waitForDaemonReady: waitForDaemonReadyMock,
}));
mock.module("../lib/remotes/docker.js", () => ({
  ...realDocker,
  recreateDockerContainers: recreateDockerContainersMock,
}));

// Defaults to the real writer: repair tests assert the key file's contents.
const persistRootSigningKeyMock = mock<
  typeof rootSigningKey.persistRootSigningKey
>(realRootSigningKey.persistRootSigningKey);

mock.module("../lib/root-signing-key.js", () => ({
  ...realRootSigningKey,
  persistRootSigningKey: persistRootSigningKeyMock,
}));

const ngrokRunMock = mock<typeof ngrok.runNgrokTunnel>(async () => ({
  publicUrl: "https://tunnel.example.com",
}));

mock.module("../lib/tunnels/ngrok", () => ({
  ...realNgrok,
  NGROK_PROVIDER: {
    ...realNgrok.NGROK_PROVIDER,
    run: ngrokRunMock,
  },
}));

const { wake } = await import("../commands/wake.js");

let tempDir: string;
let originalArgv: string[];
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let localEntry: LockfileAssistant;

function makeLocalEntry(): LockfileAssistant {
  tempDir = mkdtempSync(join(tmpdir(), "cadet-wake-test-"));
  return {
    assistantId: "local-assistant",
    cloud: "local",
    instanceDir: tempDir,
    daemonPort: 7821,
    port: 7830,
    cesPort: 7822,
  };
}

beforeEach(() => {
  originalArgv = [...process.argv];
  tempDir = "";
  process.argv = ["bun", "cadet", "wake", "--watch", "local-assistant"];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});

  localEntry = makeLocalEntry();
  resolveTargetAssistantMock.mockReset();
  resolveTargetAssistantMock.mockReturnValue(localEntry);
  loadAllAssistantsMock.mockReset();
  loadAllAssistantsMock.mockReturnValue([]);
  saveLockfileAssistantMock.mockReset();
  saveLockfileAssistantMock.mockImplementation(() => ({
    ok: true,
    lockfile: { assistants: [], activeAssistant: null },
  }));
  wakeLocalMock.mockReset();
  wakeLocalMock.mockResolvedValue({ ok: true });
  wakeDockerMock.mockReset();
  wakeDockerMock.mockResolvedValue({ ok: true });
  dockerResourceNamesMock.mockReset();
  dockerResourceNamesMock.mockImplementation(
    localModeModule.dockerResourceNames,
  );
  recreateDockerContainersMock.mockReset();
  recreateDockerContainersMock.mockResolvedValue(undefined);
  waitForDaemonReadyMock.mockReset();
  waitForDaemonReadyMock.mockResolvedValue(true);
  persistRootSigningKeyMock.mockReset();
  persistRootSigningKeyMock.mockImplementation(
    realRootSigningKey.persistRootSigningKey,
  );
  ngrokRunMock.mockReset();
  ngrokRunMock.mockImplementation(async () => ({
    publicUrl: "https://tunnel.example.com",
  }));
});

afterEach(() => {
  process.argv = originalArgv;
  logSpy.mockRestore();
  errorSpy.mockRestore();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  mock.module("@mycadet/local-mode", () => realLocalMode);
  mock.module("../lib/assistant-config.js", () => realAssistantConfig);
  mock.module("../lib/remotes/docker.js", () => realDocker);
  mock.module("../lib/tunnels/ngrok", () => realNgrok);
  mock.module("../lib/root-signing-key.js", () => realRootSigningKey);
});

describe("cadet wake — the docker recreate arm", () => {
  const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;

  afterEach(() => {
    if (originalWorkspaceDir === undefined) {
      delete process.env.CADET_WORKSPACE_DIR;
    } else {
      process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
    }
  });

  test("a migrated docker assistant (containers never created) is recreated from the entry", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    const migratedEntry = {
      assistantId: "docker-1",
      cloud: "docker" as const,
      port: 7830,
      containerInfo: {
        assistantImage: "mycadet/mycadet-assistant:v0.12.7",
        gatewayImage: "mycadet/mycadet-gateway:v0.12.7",
        cesImage: "mycadet/mycadet-credential-executor:v0.12.7",
      },
    };
    resolveTargetAssistantMock.mockReturnValue(migratedEntry);
    // The v0.0.10 run feedback: the containers were never created — the
    // docker leg answers its structured 404, the command recreates.
    wakeDockerMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error:
        "the containers for 'docker-1' don't exist yet — run `cadet wake` once to recreate them from the recorded images",
    });
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(recreateDockerContainersMock).toHaveBeenCalledWith(migratedEntry);
      expect(logSpy).toHaveBeenCalledWith("Docker containers started.");
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });
});

describe("cadet wake --all", () => {
  function makeAllEntry(
    assistantId: string,
    instanceDir: string,
  ): LockfileAssistant {
    return {
      assistantId,
      cloud: "local",
      instanceDir,
      daemonPort: 7821,
      port: 7830,
      cesPort: 7822,
    };
  }

  function makeAllEntries(): LockfileAssistant[] {
    return [
      makeAllEntry("wake-all-1", join(tempDir, "instance-1")),
      makeAllEntry("wake-all-2", join(tempDir, "instance-2")),
    ];
  }

  test("starts every assistant in the lockfile", async () => {
    loadAllAssistantsMock.mockReturnValue(makeAllEntries());
    process.argv = ["bun", "cadet", "wake", "--all"];

    await wake();

    expect(wakeLocalMock).toHaveBeenCalledTimes(2);
    expect(
      (wakeLocalMock.mock.calls[0]![0] as LockfileAssistant).assistantId,
    ).toBe("wake-all-1");
    expect(
      (wakeLocalMock.mock.calls[1]![0] as LockfileAssistant).assistantId,
    ).toBe("wake-all-2");
  });

  test("continues past a failing assistant and exits 1", async () => {
    // A real wake failure for the first entry; the loop still wakes the rest.
    wakeLocalMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: "ces spawn failed",
    });
    loadAllAssistantsMock.mockReturnValue(makeAllEntries());
    process.argv = ["bun", "cadet", "wake", "--all"];

    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      },
    );

    try {
      await expect(wake()).rejects.toThrow("process.exit:1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to wake 'wake-all-1'"),
      );
    } finally {
      exitSpy.mockRestore();
    }

    // Both assistants attempted their wakes.
    expect(wakeLocalMock).toHaveBeenCalledTimes(2);
  });

  test("exits 1 when there is nothing to start", async () => {
    loadAllAssistantsMock.mockReturnValue([]);
    process.argv = ["bun", "cadet", "wake", "--all"];

    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      },
    );

    try {
      await expect(wake()).rejects.toThrow("process.exit:1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("no assistants found"),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("refuses --all combined with a name", async () => {
    process.argv = ["bun", "cadet", "wake", "local-assistant", "--all"];

    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      },
    );

    try {
      await expect(wake()).rejects.toThrow("process.exit:1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--all cannot be combined"),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("refuses --all with --foreground", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      },
    );

    try {
      process.argv = ["bun", "cadet", "wake", "--all", "--foreground"];
      await expect(wake()).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
    }

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--all cannot be combined with --foreground"),
    );
  });
});
