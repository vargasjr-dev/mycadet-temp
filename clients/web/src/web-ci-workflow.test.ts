import { describe, expect, test } from "bun:test";
import { load } from "js-yaml";

type WorkflowJob = {
  name: string;
  needs?: string[];
  if?: string;
  steps: {
    name: string;
    env?: Record<string, string>;
    run?: string;
  }[];
};

const workflow = load(
  await Bun.file(
    new URL("../../../.github/workflows/pr-web.yaml", import.meta.url),
  ).text(),
) as { jobs: Record<string, WorkflowJob> };

describe("web CI merge gate", () => {
  const checks = workflow.jobs.checks;
  const stepNames = checks.steps.map((step) => step.name);

  test("a single checks job runs every gate", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["checks"]);
    expect(checks.name).toBe("Lint, Type Check, Test & Build");
    for (const gate of [
      "Lint",
      "Audit cross-domain import allow-list freshness",
      "Type check",
      "Build",
      "Test",
    ]) {
      expect(stepNames, `${gate} step missing from the checks job`).toContain(
        gate,
      );
    }
  });

  test("PRs scope the test step to the diff; main runs everything", () => {
    const testStep = checks.steps.find((step) => step.name === "Test");
    expect(testStep?.env?.TEST_DIFF_ONLY).toContain("pull_request");
  });
});
