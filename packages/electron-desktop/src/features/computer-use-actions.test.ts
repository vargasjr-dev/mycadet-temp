import { expect, mock, test } from "bun:test";

import type { HostProxyPoster } from "../host-proxy/poster";
import type { HostProxySseMessage } from "../host-proxy/sse";

// Keep electron-log's file backend out of the test process.
mock.module("../app-logger", () => ({
  default: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  getLogFilePaths: () => [],
}));

const {
  computerUseExecutors,
  createHostCuExecutor,
  protectComputerUseCapture,
} = await import("../features/computer-use-actions");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("composes the host_cu executor set for the host-proxy bridge", () => {
  const provided = computerUseExecutors();
  expect(typeof provided.host_cu.handleRequest).toBe("function");
  expect(typeof provided.teardown).toBe("function");
});

test("forwards cu requests to cu.perform and posts the result", async () => {
  let seen: { method: string; params: unknown } | null = null;
  const executor = createHostCuExecutor({
    helper: {
      call: async (method, params) => {
        seen = { method, params };
        return { executionResult: "clicked" };
      },
    },
  });
  const postCuResult = mock(async (_payload: unknown) => true);

  executor.handleRequest(
    {
      type: "host_cu_request",
      requestId: "req-1",
      conversationId: "conv-1",
      toolName: "computer_use_click",
      input: { x: 1, y: 2 },
      stepNumber: 3,
    } satisfies HostProxySseMessage,
    { postCuResult } as unknown as HostProxyPoster,
  );
  await tick();

  expect(seen).toMatchObject({
    method: "cu.perform",
    params: {
      requestId: "req-1",
      toolName: "computer_use_click",
      stepNumber: 3,
    },
  });
  expect(postCuResult).toHaveBeenCalledWith({
    requestId: "req-1",
    executionResult: "clicked",
  });
});

test("a cancel received before the helper responds drops the result", async () => {
  let release: (() => void) | undefined;
  const executor = createHostCuExecutor({
    helper: {
      call: () =>
        new Promise<unknown>(
          (resolve) => (release = () => resolve({ executionResult: "late" })),
        ),
    },
  });
  const postCuResult = mock(async (_payload: unknown) => true);
  const poster = { postCuResult } as unknown as HostProxyPoster;

  executor.handleRequest(
    {
      type: "host_cu_request",
      requestId: "req-3",
      toolName: "computer_use_wait",
      input: { duration_ms: 1 },
    },
    poster,
  );
  executor.handleCancel({ type: "host_cu_cancel", requestId: "req-3" }, poster);
  release?.();
  await tick();

  expect(postCuResult).not.toHaveBeenCalled();
});

test("excludes Cadet windows while the helper captures the screen", async () => {
  const states = [false, true];
  const windows = states.map((_, index) => ({
    isContentProtected: () => states[index],
    setContentProtection: (protectedState: boolean) => {
      states[index] = protectedState;
    },
  }));
  const helper = protectComputerUseCapture(
    {
      call: async () => {
        expect(states).toEqual([true, true]);
        return { screenshot: "jpeg" };
      },
    },
    () => windows,
  );

  await helper.call("cu.perform", {});

  expect(states).toEqual([false, true]);
});
