import { describe, expect, test } from "bun:test";

import { logHatchNextSteps } from "../lib/hatch-next-steps";

function captureNextSteps(): string[] {
  const lines: string[] = [];
  logHatchNextSteps((message) => lines.push(message));
  return lines;
}

describe("logHatchNextSteps", () => {
  test("names the production binary in a production environment", () => {
    const prev = process.env.CADET_ENVIRONMENT;
    try {
      process.env.CADET_ENVIRONMENT = "production";
      const lines = captureNextSteps();
      expect(lines.join("\n")).toContain("`cadet client`");
      expect(lines.join("\n")).toContain("`cadet tunnel`");
      expect(lines.join("\n")).not.toContain("cadet-dev");
    } finally {
      if (prev === undefined) delete process.env.CADET_ENVIRONMENT;
      else process.env.CADET_ENVIRONMENT = prev;
    }
  });

  test("names the environment-suffixed binary in dev", () => {
    const prev = process.env.CADET_ENVIRONMENT;
    try {
      process.env.CADET_ENVIRONMENT = "dev";
      const lines = captureNextSteps();
      expect(lines.join("\n")).toContain("`cadet-dev client`");
      expect(lines.join("\n")).toContain("`cadet-dev tunnel`");
    } finally {
      if (prev === undefined) delete process.env.CADET_ENVIRONMENT;
      else process.env.CADET_ENVIRONMENT = prev;
    }
  });
});
