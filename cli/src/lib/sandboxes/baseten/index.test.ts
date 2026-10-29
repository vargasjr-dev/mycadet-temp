import { describe, expect, test } from "bun:test";

import { join } from "node:path";

import {
  BASETEN_ASSISTANT_NAME,
  BASETEN_IMAGE_NAME,
  basetenDockerfilePath,
  basetenEntrypointPath,
  basetenSandboxDir,
  buildCreateArgs,
  buildPushArgs,
} from "./index.js";

describe("baseten sandbox image — argv builders", () => {
  test("push defaults to the cadet image built from this directory", () => {
    expect(buildPushArgs()).toEqual([
      "sandbox",
      "image",
      "push",
      "--name",
      "cadet",
      "--dir",
      basetenSandboxDir(),
      "--wait",
    ]);
  });

  test("push honors overrides and can skip the wait", () => {
    expect(
      buildPushArgs({ name: "cadet-rc", dir: "/tmp/ctx", wait: false }),
    ).toEqual([
      "sandbox",
      "image",
      "push",
      "--name",
      "cadet-rc",
      "--dir",
      "/tmp/ctx",
    ]);
  });

  test("create defaults to the sandbox/<image>:latest reference", () => {
    expect(buildCreateArgs()).toEqual([
      "sandbox",
      "create",
      "--name",
      "cadet",
      "--image",
      "sandbox/cadet:latest",
    ]);
  });

  test("create passes each env var as its own --env flag", () => {
    expect(
      buildCreateArgs({
        name: "nightly",
        env: { ANTHROPIC_API_KEY: "sk-ant-1", CADET_DEBUG: "1" },
      }),
    ).toEqual([
      "sandbox",
      "create",
      "--name",
      "nightly",
      "--image",
      "sandbox/cadet:latest",
      "--env",
      "ANTHROPIC_API_KEY=sk-ant-1",
      "--env",
      "CADET_DEBUG=1",
    ]);
  });
});

describe("baseten sandbox image — file layout", () => {
  test("the image files live beside this module", () => {
    expect(BASETEN_IMAGE_NAME).toBe("cadet");
    expect(BASETEN_ASSISTANT_NAME).toBe("cadet");
    expect(basetenDockerfilePath()).toBe(
      join(basetenSandboxDir(), "Dockerfile"),
    );
    expect(basetenEntrypointPath()).toBe(
      join(basetenSandboxDir(), "entrypoint.sh"),
    );
  });
});
