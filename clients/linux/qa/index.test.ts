import { describe, expect, test } from "bun:test";

import {
  QA_IMAGE_NAME,
  QA_IMAGE_REF,
  buildCreateArgs,
  buildExecArgs,
  buildImagePushArgs,
  buildQaPipelineArgs,
} from "./index";

describe("buildImagePushArgs", () => {
  test("pushes the desktop-QA image from its own directory", () => {
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
    expect(buildCreateArgs({ name: "qa-pr599" })).toEqual([
      "sandbox",
      "create",
      "--name",
      "qa-pr599",
    ]);
  });
});

describe("buildExecArgs", () => {
  test("passes the command after the separator", () => {
    expect(
      buildExecArgs({ name: "qa-pr599", command: ["sh", "-c", "true"] }),
    ).toEqual(["sandbox", "exec", "--name", "qa-pr599", "--", "sh", "-c", "true"]);
  });
});

describe("buildQaPipelineArgs", () => {
  test("builds and drives in the pulled repo — no fresh clone per run", () => {
    const steps = buildQaPipelineArgs({ name: "qa-pr599" });
    expect(steps).toHaveLength(3);
    expect(steps.every((step) => !step[1].includes("git clone"))).toBe(true);
    expect(steps[0][2]).toBe("cd /qa && bun install --frozen-lockfile");
    expect(steps[1][2]).toContain("clients/linux && bun install --frozen-lockfile");
    expect(steps[2][2]).toContain("xvfb-run -a bun run qa");
  });

  test("a named ref fetches in the existing clone before building", () => {
    const steps = buildQaPipelineArgs({
      name: "qa-pr599",
      ref: "vargas-jr/desktop-qa-followup",
    });
    expect(steps).toHaveLength(4);
    expect(steps[0][2]).toContain("git -C /qa fetch origin");
    expect(steps[0][2]).toContain("git -C /qa checkout vargas-jr/desktop-qa-followup");
  });
});
