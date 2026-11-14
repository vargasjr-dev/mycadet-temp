import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub electron-log. `warn` is a tracked mock so tests can assert the
// router doesn't log for expected firehose traffic.
const mockLogWarn = mock((..._args: unknown[]) => {});
const noopLog = (..._args: unknown[]): void => undefined;

const { HostProxyPoster } = await import("./poster");
const { setExecutor, removeExecutor, __testing } = await import("./router");
type HostProxyRuntime = import("./router").HostProxyRuntime;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const unavailableExecutor = {
  handleRequest: () => undefined,
  handleCancel: () => undefined,
};
const testRuntime: HostProxyRuntime = {
  sseClientHeaders: () => ({}),
  posterClientHeaders: () => ({}),
  executors: {
    host_bash: unavailableExecutor,
    host_file: unavailableExecutor,
    host_transfer: unavailableExecutor,
    host_browser: unavailableExecutor,
    host_cu: unavailableExecutor,
    host_ui_snapshot: unavailableExecutor,
  },
  logger: { info: noopLog, warn: mockLogWarn, error: noopLog },
};

async function flush(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Create a poster that captures the first POST body for assertions. */
function capturingPoster(): {
  poster: InstanceType<typeof HostProxyPoster>;
  body: () => Record<string, unknown> | null;
} {
  let postedBody: Record<string, unknown> | null = null;
  const fakeFetch = async (_url: unknown, init?: RequestInit) => {
    postedBody = JSON.parse(init?.body as string);
    return new Response("ok");
  };
  const poster = new HostProxyPoster({
    endpointBase: "http://127.0.0.1:9000/v1",
    authHeaders: () => ({ Authorization: "Bearer t" }),
    fetch: fakeFetch as typeof globalThis.fetch,
  });
  return { poster, body: () => postedBody };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host-proxy-router", () => {
  describe("message dispatch", () => {
    beforeEach(() => {
      __testing.setRuntime(testRuntime);
    });

    test("routes request to registered executor", () => {
      const handled: string[] = [];
      setExecutor("host_bash", {
        handleRequest: (msg) => {
          handled.push(`req:${msg.requestId}`);
        },
        handleCancel: (msg) => {
          handled.push(`cancel:${msg.requestId}`);
        },
      });

      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () =>
          new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      __testing.dispatchMessage(
        { type: "host_bash_request", requestId: "r1" },
        poster,
      );
      __testing.dispatchMessage(
        { type: "host_bash_cancel", requestId: "r2" },
        poster,
      );

      expect(handled).toEqual(["req:r1", "cancel:r2"]);
      removeExecutor("host_bash");
    });

    test("routes file messages to file executor", () => {
      const handled: string[] = [];
      setExecutor("host_file", {
        handleRequest: (msg) => {
          handled.push(`req:${msg.requestId}`);
        },
        handleCancel: (msg) => {
          handled.push(`cancel:${msg.requestId}`);
        },
      });

      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () =>
          new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      __testing.dispatchMessage(
        { type: "host_file_request", requestId: "f1" },
        poster,
      );

      expect(handled).toEqual(["req:f1"]);
      removeExecutor("host_file");
    });

    test("posts stub error for unimplemented bash executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage(
        { type: "host_bash_request", requestId: "r1" },
        poster,
      );
      await flush();

      expect(body()).not.toBeNull();
      expect(body()!.requestId).toBe("r1");
      expect(body()!.stderr).toBe("Executor not yet implemented");
      expect(body()!.exitCode).toBe(1);
    });

    test("posts stub error for unimplemented file executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage(
        { type: "host_file_request", requestId: "f1" },
        poster,
      );
      await flush();

      expect(body()!.requestId).toBe("f1");
      expect(body()!.isError).toBe(true);
    });

    test("posts stub error for unimplemented transfer executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage(
        { type: "host_transfer_request", requestId: "t1" },
        poster,
      );
      await flush();

      expect(body()!.requestId).toBe("t1");
      expect(body()!.isError).toBe(true);
      expect(body()!.errorMessage).toBe("Executor not yet implemented");
    });

    test("posts stub error for unimplemented browser executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage(
        { type: "host_browser_request", requestId: "b1" },
        poster,
      );
      await flush();

      expect(body()!.requestId).toBe("b1");
      expect(body()!.isError).toBe(true);
    });

    test("ignores unknown message types without crashing", () => {
      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () =>
          new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      // Should not throw
      __testing.dispatchMessage(
        { type: "host_unknown_request", requestId: "u1" },
        poster,
      );
    });

    test("drops non-host firehose events silently (no warn spam)", () => {
      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () =>
          new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      mockLogWarn.mockClear();
      // /v1/events is the full assistant-event firehose. These are the
      // high-volume streaming/tool events this connection ignores — none
      // should warn, or the log fills with tens of thousands of lines.
      for (const type of [
        "assistant_thinking_delta",
        "assistant_text_delta",
        "tool_output_chunk",
        "message_complete",
        "sync_changed",
      ]) {
        __testing.dispatchMessage({ type }, poster);
      }

      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    test("warns on a host_*-shaped type it cannot route", () => {
      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () =>
          new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      mockLogWarn.mockClear();
      __testing.dispatchMessage({ type: "host_teleport_request" }, poster);

      expect(mockLogWarn).toHaveBeenCalledTimes(1);
    });
  });
});
