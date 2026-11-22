import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";

import { SidecarSupervisor } from "./process-supervisor";
import { NativeSidecarClient } from "./supervisor";

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  readonly stdin = {
    write: (value: string, callback?: (error?: Error | null) => void) => {
      this.writes.push(value);
      callback?.(null);
      return true;
    },
    end: mock(() => undefined),
  };
  readonly kill = mock((_signal?: NodeJS.Signals) => true);
  readonly pid = 1234;
}

const asChild = (child: FakeChild): ChildProcessWithoutNullStreams =>
  child as unknown as ChildProcessWithoutNullStreams;

const logger = () => ({ info: mock(() => {}), warn: mock(() => {}) });

describe("NativeSidecarClient", () => {
  test("routes responses, notifications, malformed frames, and stderr", async () => {
    const child = new FakeChild();
    const logs = logger();
    const client = new NativeSidecarClient({
      resolveExecutablePath: () => "unused",
      logger: logs,
      spawn: () => asChild(child),
      maxFrameBytes: 256,
    });
    const notifications: string[] = [];
    client.onNotification(
      "status.changed",
      z.object({ state: z.string() }),
      ({ state }) => notifications.push(state),
    );

    const response = client.call("system.ping", { value: 1 });
    expect(JSON.parse(child.writes[0]!)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "system.ping",
    });
    child.stderr.emit("data", Buffer.from("diagnostic\n"));
    child.stdout.emit("data", Buffer.from("x".repeat(257)));
    child.stdout.emit(
      "data",
      Buffer.from(
        'not-json\n{"jsonrpc":"2.0","method":"status.changed","params":{"state":"ready"}}\n{"jsonrpc":"2.0","id":1,"result":"pong"}\n',
      ),
    );

    expect(await response).toBe("pong");
    expect(notifications).toEqual(["ready"]);
    expect(logs.warn).toHaveBeenCalledTimes(3);
    client.shutdown({ method: "system.shutdown" });
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("rejects pending calls when the helper exits", async () => {
    const child = new FakeChild();
    const client = new NativeSidecarClient({
      resolveExecutablePath: () => "unused",
      logger: logger(),
      spawn: () => asChild(child),
      initialBackoffMs: 50,
    });

    const response = client.call("slow.operation");
    child.emit("close", 1, null);
    await expect(response).rejects.toThrow("exited before response");
    client.shutdown();
  });

  test("a deliberate shutdown does not respawn", async () => {
    const children: FakeChild[] = [];
    const client = new NativeSidecarClient({
      resolveExecutablePath: () => "unused",
      logger: logger(),
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return asChild(child);
      },
      // The ping is never answered on purpose; a short injected deadline
      // flushes it without pinning the test to wall-clock behavior under
      // load.
      responseTimeoutMs: 50,
    });

    await client.call("system.ping").catch(() => undefined);

    client.shutdown();
    children[0]!.emit("close", 0, null);
    expect(() => client.call("system.ping")).toThrow("not available");
    // Outwait the supervisor's own respawn backoff: a respawn would show up
    // as a second child, and none may arrive after a deliberate shutdown.
    await Bun.sleep(1_200);
    expect(children).toHaveLength(1);
  });

  test("a user-initiated retry replaces the running helper", async () => {
    const children: FakeChild[] = [];
    const client = new NativeSidecarClient({
      resolveExecutablePath: () => "unused",
      logger: logger(),
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return asChild(child);
      },
    });

    await client.call("system.ping").catch(() => undefined);
    children[0]!.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"pong"}\n'),
    );

    expect(client.retry()).toMatchObject({ status: "running" });
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(children).toHaveLength(2);
    client.shutdown();
  });

  test("a user-initiated retry reopens a circuit-open supervisor", async () => {
    const children: FakeChild[] = [];
    const client = new NativeSidecarClient({
      resolveExecutablePath: () => "unused",
      logger: logger(),
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return asChild(child);
      },
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      circuitCrashCount: 2,
      // Long enough that core contention cannot close the window before the
      // test walks the crash-retry sequence.
      circuitWindowMs: 60_000,
    });

    expect(client.retry()).toMatchObject({ status: "running" });
    children[0]!.emit("close", 1, null);
    await Bun.sleep(5);
    children[1]!.emit("close", 1, null);
    expect(client.getState()).toMatchObject({ status: "circuit-open" });

    expect(client.retry()).toMatchObject({ status: "running" });
    expect(children).toHaveLength(3);
    client.shutdown();
  });
});

test("SidecarSupervisor bounds crash loops with a circuit breaker", async () => {
  const children: FakeChild[] = [];
  const supervisor = new SidecarSupervisor({
    logger: logger(),
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return asChild(child);
    },
    initialBackoffMs: 1,
    maxBackoffMs: 1,
    circuitCrashCount: 3,
    circuitWindowMs: 1_000,
  });

  supervisor.ensureRunning();
  for (let index = 0; index < 3; index += 1) {
    children[index]!.emit("close", 1, null);
    await Bun.sleep(5);
  }

  expect(children).toHaveLength(3);
  expect(supervisor.getState().status).toBe("circuit-open");
  expect(supervisor.ensureRunning()).toBeNull();
});
