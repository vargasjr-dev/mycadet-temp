import { afterAll, expect, mock, test } from "bun:test";

const realExec = { ...(await import("../exec")) };
const execMock = mock(async (_cmd: string, _args: string[]) => {});
mock.module("../exec", () => ({
  ...realExec,
  exec: execMock,
  execOutput: async () => "exited",
}));
afterAll(() => {
  mock.module("../exec", () => realExec);
});

const { retireDocker } = await import("../remotes/docker/retire");

test("retire removes every volume", async () => {
  await retireDocker({ assistantId: "docker-1", cloud: "docker", port: 7830 });
  const removed = execMock.mock.calls
    .filter(([, args]) => args[0] === "volume")
    .map(([, args]) => args[2])
    .sort();
  expect(removed).toEqual([
    "docker-1-assistant-ipc",
    "docker-1-ces-data",
    "docker-1-ces-sec",
    "docker-1-gateway-ipc",
    "docker-1-gateway-sec",
    "docker-1-socket",
    "docker-1-workspace",
  ]);
});
