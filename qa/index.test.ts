import { describe, expect, test } from "bun:test";

import {
  BOOT_SCRIPT,
  DRIVE_SCRIPT,
  QA_IMAGE_NAME,
  QA_IMAGE_REF,
  QA_TARGETS,
  buildCreateArgs,
  buildExecArgs,
  buildImagePushArgs,
  buildQaPipelineArgs,
} from "./index";

describe("buildImagePushArgs", () => {
  test("pushes the cadet-QA image from its own directory", () => {
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
    expect(buildCreateArgs({ name: "qa-pr645" })).toEqual([
      "sandbox",
      "create",
      "--name",
      "qa-pr645",
    ]);
  });
});

describe("buildExecArgs", () => {
  test("passes the command after the separator", () => {
    expect(
      buildExecArgs({ name: "qa-pr645", command: ["sh", "-c", "true"] }),
    ).toEqual([
      "sandbox",
      "exec",
      "--name",
      "qa-pr645",
      "--",
      "sh",
      "-c",
      "true",
    ]);
  });
});

describe("buildQaPipelineArgs", () => {
  test("every target builds in the pulled repo — no fresh clone per run", () => {
    for (const target of QA_TARGETS) {
      const { steps } = buildQaPipelineArgs({ name: "qa-pr645", target });
      expect(steps.every((step) => !step[1].includes("git clone"))).toBe(true);
    }
  });

  test("desktop: install, build the client, run its tests under Xvfb", () => {
    const { steps, names } = buildQaPipelineArgs({
      name: "qa-pr645",
      target: "desktop",
    });
    expect(names).toEqual(["install", "build", "drive"]);
    expect(steps[0][2]).toBe("cd /qa && bun install --frozen-lockfile");
    expect(steps[1][2]).toContain(
      "clients/linux && bun install --frozen-lockfile && bun run build",
    );
    expect(steps[2][2]).toContain("xvfb-run -a bun scripts/run-tests.ts");
  });

  test("android: install, bundle+sync, emulator START, gradle, emulator WAIT, drive", () => {
    const { steps, names } = buildQaPipelineArgs({
      name: "qa-pr645",
      target: "android",
    });
    expect(names).toEqual([
      "install",
      "bundle",
      "emulator-start",
      "gradle",
      "emulator-wait",
      "drive",
    ]);
    // The emulator boots DURING the Gradle build: start before, wait after —
    // the software-emulated boot is the slowest thing in the pipeline.
    expect(steps[1][2]).toContain(
      "clients/android && bun install --frozen-lockfile && bun run build",
    );
    expect(steps[2][2]).toBe(`sh ${BOOT_SCRIPT} start`);
    expect(steps[3][2]).toContain("./gradlew assembleDebug");
    expect(steps[4][2]).toBe(`sh ${BOOT_SCRIPT} wait`);
    expect(steps[5][2]).toBe(`sh ${DRIVE_SCRIPT}`);
  });

  test("web: install and run the web test suite headless", () => {
    const { steps, names } = buildQaPipelineArgs({
      name: "qa-pr645",
      target: "web",
    });
    expect(names).toEqual(["install", "test"]);
    expect(steps[0][2]).toBe("cd /qa && bun install --frozen-lockfile");
    expect(steps[1][2]).toContain(
      "clients/web && bun install --frozen-lockfile && bun run test",
    );
  });

  test("a named ref fetches in the existing clone before every target", () => {
    for (const target of QA_TARGETS) {
      const { steps, names } = buildQaPipelineArgs({
        name: "qa-pr645",
        target,
        ref: "vargas-jr/qa-unified",
      });
      expect(names[0]).toBe("fetch");
      expect(steps[0][2]).toContain("git -C /qa fetch origin");
      expect(steps[0][2]).toContain("git -C /qa checkout vargas-jr/qa-unified");
    }
  });
});

describe("QA_IMAGE_REF", () => {
  test("resolves the sandbox/<name>:latest tag", () => {
    expect(QA_IMAGE_REF).toBe(`sandbox/${QA_IMAGE_NAME}:latest`);
  });
});
