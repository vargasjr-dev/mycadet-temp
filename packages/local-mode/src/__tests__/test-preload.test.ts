import { expect, test } from "bun:test";

test("a test that deletes XDG_CONFIG_HOME instead of restoring it", () => {
  delete process.env.XDG_CONFIG_HOME;
});

test("the next test is back in the sandbox", () => {
  expect(process.env.XDG_CONFIG_HOME).toContain("cadet-local-mode-test-");
});
