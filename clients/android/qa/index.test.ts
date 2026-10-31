import { describe, expect, test } from "bun:test";

import {
  BOOT_SCRIPT,
  DRIVE_SCRIPT,
  QA_IMAGE_NAME,
  QA_IMAGE_REF,
  buildCreateArgs,
  buildExecArgs,
  buildImagePushArgs,
  buildQaPipelineArgs,
} from "./index";

describe("buildImagePushArgs", () => {
  test("pushes the android-QA image from its own directory", () => {
    expect(buildImagePushArgs()).toEqual([
      "sandbox",
      "image",
      "push",
      "--name",
      QA_IMAGE_NAME,
      "--dir",
      import.meta.dir,
      "--wait",
    ]);
  });

  test("--no-wait drops the wait flag", () => {
    const args = buildImagePushArgs({ wait: false });
    expect(args).not.toContain("--wait");
  });
});

describe("buildCreateArgs", () => {
  test("creates from the pushed image — name only, no env or image args", () => {
    expect(buildCreateArgs({ name: "android-qa-pr599" })).toEqual([
      "sandbox",
      "create",
      "--name",
      "android-qa-pr599",
    ]);
  });
});

describe("buildExecArgs", () => {
  test("passes the command after the separator", () => {
    expect(
      buildExecArgs({
        name: "android-qa-pr599",
        command: ["sh", "-c", "true"],
      }),
    ).toEqual([
      "sandbox",
      "exec",
      "--name",
      "android-qa-pr599",
      "--",
      "sh",
      "-c",
      "true",
    ]);
  });
});

describe("buildQaPipelineArgs", () => {
  test("builds and drives in the pulled repo — no fresh clone per run", () => {
    const steps = buildQaPipelineArgs({ name: "android-qa-pr599" });
    expect(steps.every((step) => !step[1].includes("git clone"))).toBe(true);
  });

  test("orders: install, bundle+sync, emulator START, gradle, emulator WAIT, drive", () => {
    const steps = buildQaPipelineArgs({ name: "android-qa-pr599" });
    expect(steps).toHaveLength(6);
    expect(steps[0][2]).toBe("cd /qa && bun install --frozen-lockfile");
    expect(steps[1][2]).toContain(
      "clients/android && bun install --frozen-lockfile && bun run build",
    );
    // The emulator boots DURING the Gradle build: start before, wait after —
    // the software-emulated boot is the slowest thing in the pipeline.
    expect(steps[2][2]).toBe(`sh ${BOOT_SCRIPT} start`);
    expect(steps[3][2]).toContain("./gradlew assembleDebug");
    expect(steps[4][2]).toBe(`sh ${BOOT_SCRIPT} wait`);
    expect(steps[5][2]).toBe(`sh ${DRIVE_SCRIPT}`);
  });

  test("a named ref fetches in the existing clone before building", () => {
    const steps = buildQaPipelineArgs({
      name: "android-qa-pr599",
      ref: "vargas-jr/android-qa-sandbox",
    });
    expect(steps).toHaveLength(7);
    expect(steps[0][2]).toContain("git -C /qa fetch origin");
    expect(steps[0][2]).toContain(
      "git -C /qa checkout vargas-jr/android-qa-sandbox",
    );
  });
});

describe("QA_IMAGE_REF", () => {
  test("resolves the sandbox/<name>:latest tag", () => {
    expect(QA_IMAGE_REF).toBe(`sandbox/${QA_IMAGE_NAME}:latest`);
  });
});
