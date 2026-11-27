import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realExecModule = { ...(await import("../exec")) };
let inspected = "";
mock.module("../exec", () => ({
  ...realExecModule,
  execOutput: async (_cmd: string, args: string[] = []) => {
    inspected = args.at(-1) ?? "";
    return "exited";
  },
}));
afterAll(() => {
  mock.module("../exec", () => realExecModule);
});

const { isAssistantAsleep } = await import("../assistant-asleep");
const { execCommand } = await import("../operations/exec");

test("a local assistant is asleep until its gateway runs", async () => {
  const instanceDir = mkdtempSync(join(tmpdir(), "asleep-test-"));
  const entry = {
    assistantId: "nap",
    cloud: "local" as const,
    port: 7830,
    instanceDir,
  };
  expect(await isAssistantAsleep(entry)).toBe(true);
  writeFileSync(join(instanceDir, "gateway.pid"), String(process.pid));
  expect(await isAssistantAsleep(entry)).toBe(false);
});

test("exec on a sleeping docker assistant says to wake it", async () => {
  const result = await execCommand(
    { assistantId: "nap", cloud: "docker", port: 7830 },
    { command: ["true"], service: "assistant" },
  );
  expect(inspected).toBe("nap-gateway");
  expect(result).toEqual({
    ok: false,
    status: 1,
    error: "nap is asleep. Run `cadet wake nap` first.",
  });
});
