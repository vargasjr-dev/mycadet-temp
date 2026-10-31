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
  test("creates from the pushed image with env pairs exploded", () => {
    expect(
      buildCreateArgs({
        name: "qa-pr599",
        env: { BASETEN_API_KEY: "k", QA_REF: "r" },
      }),
    ).toEqual([
      "sandbox",
      "create",
      "--name",
      "qa-pr599",
      "--image",
      QA_IMAGE_REF,
      "--env",
      "BASETEN_API_KEY=k",
      "--env",
      "QA_REF=r",
    ]);
  });

  test("honors an explicit image reference", () => {
    const args = buildCreateArgs({ name: "qa", image: "sandbox/cadet:latest" });
    expect(args[args.indexOf("--image") + 1]).toBe("sandbox/cadet:latest");
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
  test("check out, install, build, drive — in that order", () => {
    const steps = buildQaPipelineArgs({
      name: "qa-pr599",
      ref: "vargas-jr/desktop-single-origin",
    });
    expect(steps).toHaveLength(4);
    expect(steps[0][2]).toContain(
      "git clone --depth 1 --branch vargas-jr/desktop-single-origin",
    );
    expect(steps[2][2]).toContain(
      "clients/linux && bun install --frozen-lockfile && bun run build",
    );
    expect(steps[3][2]).toContain("xvfb-run -a bun run qa");
  });
});
