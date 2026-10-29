import { describe, expect, test } from "bun:test";

import { basetenImageRef } from "./api.js";
import {
  BASETEN_IMAGE_NAME,
  mycadetVersion,
  stampBasetenDockerfile,
} from "./context.js";

const UNSHALLOW_DOCKERFILE = [
  "ARG MYCADET_VERSION",
  "RUN bun add -g mycadet@${MYCADET_VERSION}",
  "ARG ASSISTANT_NAME=\"\"",
  "RUN cd /app && cadet hatch ${ASSISTANT_NAME:+--name \"$ASSISTANT_NAME\"}",
].join("\n");

describe("stampBasetenDockerfile", () => {
  test("stamps the CLI's package version so releases need no bump here", () => {
    expect(mycadetVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    const stamped = stampBasetenDockerfile(UNSHALLOW_DOCKERFILE, {
      version: mycadetVersion(),
    });
    expect(stamped).toContain(`ARG MYCADET_VERSION="${mycadetVersion()}"`);
  });

  test("a leading v in the version is normalized away", () => {
    const stamped = stampBasetenDockerfile(UNSHALLOW_DOCKERFILE, {
      version: "v1.2.3",
    });
    expect(stamped).toContain('ARG MYCADET_VERSION="1.2.3"');
  });

  test("the assistant name is optional — empty keeps hatch random", () => {
    const stamped = stampBasetenDockerfile(UNSHALLOW_DOCKERFILE, {
      version: "1.2.3",
    });
    expect(stamped).toContain('ARG ASSISTANT_NAME=""');
  });

  test("the hatch name pipes through the ASSISTANT_NAME arg", () => {
    const stamped = stampBasetenDockerfile(UNSHALLOW_DOCKERFILE, {
      version: "1.2.3",
      assistantName: "nightly",
    });
    expect(stamped).toContain('ARG ASSISTANT_NAME="nightly"');
  });

  test("shell-hostile names are escaped, not injected", () => {
    const stamped = stampBasetenDockerfile(UNSHALLOW_DOCKERFILE, {
      version: "1.2.3",
      assistantName: 'evil" && rm -rf / && echo "',
    });
    expect(stamped).toContain(
      'ARG ASSISTANT_NAME="evil\\" && rm -rf / && echo \\""',
    );
  });

  test("a Dockerfile without the version ARG fails loudly", () => {
    expect(() =>
      stampBasetenDockerfile("FROM debian", { version: "1.2.3" }),
    ).toThrow(/ARG MYCADET_VERSION/);
  });

  test("an empty version refuses to stamp", () => {
    expect(() =>
      stampBasetenDockerfile(UNSHALLOW_DOCKERFILE, { version: "" }),
    ).toThrow(/empty version/);
  });
});

describe("baseten image naming", () => {
  test("the image repository is the shared cadet repo", () => {
    expect(BASETEN_IMAGE_NAME).toBe("cadet");
    expect(basetenImageRef(BASETEN_IMAGE_NAME)).toBe("sandbox/cadet:latest");
  });
});
