/**
 * requests_mock-style test helper for HTTP and IPC calls.
 *
 * Replaces hand-rolled `mock.module` stubs of `ipc/cli-client.js` and inline
 * `globalThis.fetch` swaps with one declarative pattern: a test registers the
 * requests it expects and the responses it assumes, exercises the code under
 * test, then asserts on the recorded calls.
 *
 *   const ipc = await mockIpc("cli");
 *   ipc.on("apps_refresh", { appId: "app-1", compiled: true });
 *   ipc.on({ method: "apps_refresh", params: { pathParams: { id: "x" } } }, { ... });
 *
 *   const http = mockHttp();
 *   http.on("GET", "/v1/apps", { status: 200, body: [] });
 *
 * Semantics (requests_mock-style):
 * - The newest matching registration wins (LIFO). A registration whose
 *   sequence is exhausted falls through to older registrations.
 * - A single response repeats on every matching call; an array response is a
 *   sequence consumed FIFO, one entry per call.
 * - An `Error` response (direct or returned from a function) is thrown at
 *   the caller.
 * - A function response receives the recorded request and returns the
 *   response dynamically.
 * - An unmatched request throws `NoMockMatchError` listing the request and
 *   the registered handlers (CLI channel + HTTP). The gateway transport is
 *   the exception: it answers every method — registrations are consulted
 *   first, then per-test transport defaults, then a kernel
 *   `get_feature_flags` sentinel — because incidental `get_feature_flags`
 *   calls are ubiquitous in this suite.
 *
 * Channels reset automatically after every test (`afterEach` registered in
 * test-preload.ts), so registrations are per-test: anything registered at
 * module scope dies at the first reset. Register inside the test or a
 * `beforeEach`.
 *
 * `mockIpc("cli")` must be awaited BEFORE the module under test is imported
 * (same discipline as `mock.module`): it lazily swaps `ipc/cli-client.js` for
 * the channel-backed fake. Files that never call it keep the real client —
 * the real-socket tests rely on that.
 */

import { EventEmitter } from "node:events";
import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shared matching kernel
// ---------------------------------------------------------------------------

/** A recorded CLI/gateway IPC request. */
export interface IpcCallRecord {
  method: string;
  params?: Record<string, unknown>;
}

/** A recorded HTTP request (body is the JSON-parsed request body when parseable). */
export interface HttpRequestRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export class NoMockMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoMockMatchError";
  }
}

/**
 * Response forms every channel accepts: a bare value, a `Response` (HTTP),
 * an `Error` (thrown), a function of the request, or an array (sequence).
 * See the file docblock for semantics.
 */
export type MockResponse<I> =
  | ((req: I) => unknown)
  | Error
  | MockResponse<I>[]
  | Response
  | Record<string, unknown>
  | Uint8Array
  | string
  | number
  | boolean
  | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Subset match: every key in `expected` must deep-match the same key in `actual`. */
function deepMatches(expected: unknown, actual: unknown): boolean {
  if (expected === actual) {
    return true;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return (
      expected.length === actual.length &&
      expected.every((entry, index) => deepMatches(entry, actual[index]))
    );
  }
  if (!isRecord(expected) || !isRecord(actual)) {
    return false;
  }
  return Object.keys(expected).every(
    (key) => key in actual && deepMatches(expected[key], actual[key]),
  );
}

interface CompiledMatcher<I> {
  match: (req: I) => boolean;
  describe: string;
}

interface Registration<I> {
  match: (req: I) => boolean;
  describe: string;
  /** FIFO sequence; empty = exhausted (no longer matches). */
  queue?: MockResponse<I>[];
  /** Single repeating response resolver. Present when queue is undefined. */
  respond?: (req: I) => unknown;
}

class MockChannel<I> {
  private registrations: Registration<I>[] = [];
  private callHistory: I[] = [];

  constructor(
    private readonly compileMatcher: (matcher: unknown) => CompiledMatcher<I>,
    private readonly describeRequest: (req: I) => string,
  ) {}

  on(matcher: unknown, response: MockResponse<I>): void {
    const { match, describe } = this.compileMatcher(matcher);
    if (typeof response === "function") {
      this.registrations.push({
        match,
        describe,
        respond: (req) => {
          const result = response(req);
          if (result instanceof Error) {
            throw result;
          }
          return result;
        },
      });
      return;
    }
    if (response instanceof Error) {
      this.registrations.push({
        match,
        describe,
        respond: () => {
          throw response;
        },
      });
      return;
    }
    if (Array.isArray(response)) {
      this.registrations.push({ match, describe, queue: [...response] });
      return;
    }
    this.registrations.push({ match, describe, respond: () => response });
  }

  dispatch(req: I): unknown {
    for (let i = this.registrations.length - 1; i >= 0; i--) {
      const registration = this.registrations[i];
      if (registration.queue !== undefined && registration.queue.length === 0) {
        continue; // sequence exhausted — fall through to older registrations
      }
      if (!registration.match(req)) {
        continue;
      }
      this.callHistory.push(req);
      if (registration.queue !== undefined) {
        const next = registration.queue.shift();
        if (next !== undefined) {
          return this.resolve(next, req);
        }
        continue;
      }
      return registration.respond!(req);
    }
    throw new NoMockMatchError(this.unmatchedMessage(req));
  }

  history(): readonly I[] {
    return this.callHistory;
  }

  isEmpty(): boolean {
    return this.registrations.length === 0;
  }

  reset(): void {
    this.registrations = [];
    this.callHistory = [];
  }

  private resolve(response: MockResponse<I>, req: I): unknown {
    if (typeof response === "function") {
      const result = response(req);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  private unmatchedMessage(req: I): string {
    const lines = this.registrations
      .slice()
      .reverse()
      .map((registration, index) => {
        const remaining =
          registration.queue === undefined
            ? "repeats"
            : `${registration.queue.length} left`;
        return `  ${index + 1}. ${registration.describe} (${remaining})`;
      });
    const registered =
      lines.length > 0
        ? `\nRegistered handlers (newest first):\n${lines.join("\n")}`
        : "\nNo handlers registered.";
    return (
      `No mock registered for ${this.describeRequest(req)}.${registered}` +
      `\nRegister a response before the call, e.g. mockIpc("cli").on(...) or mockHttp().on(...).`
    );
  }
}

// ---------------------------------------------------------------------------
// IPC channels (CLI daemon + gateway)
// ---------------------------------------------------------------------------

export type IpcMatcher =
  | string
  | RegExp
  | { method?: string; params?: Record<string, unknown> }
  | ((req: IpcCallRecord) => boolean);

function compileIpcMatcher(matcher: unknown): CompiledMatcher<IpcCallRecord> {
  if (typeof matcher === "string") {
    return { match: (req) => req.method === matcher, describe: matcher };
  }
  if (matcher instanceof RegExp) {
    return {
      match: (req) => matcher.test(req.method),
      describe: String(matcher),
    };
  }
  if (typeof matcher === "function") {
    return { match: (req) => matcher(req), describe: "(predicate)" };
  }
  const spec = isRecord(matcher) ? matcher : {};
  const method = typeof spec.method === "string" ? spec.method : undefined;
  const params = isRecord(spec.params) ? spec.params : undefined;
  return {
    match: (req) =>
      (method === undefined || req.method === method) &&
      (params === undefined ||
        (isRecord(req.params) && deepMatches(params, req.params))),
    describe: JSON.stringify(matcher),
  };
}

function describeIpcRequest(req: IpcCallRecord): string {
  return `IPC ${req.method} ${JSON.stringify(req.params ?? {})}`;
}

const cliChannel = new MockChannel<IpcCallRecord>(
  compileIpcMatcher,
  describeIpcRequest,
);
const gatewayChannel = new MockChannel<IpcCallRecord>(
  compileIpcMatcher,
  describeIpcRequest,
);

function filterIpcCalls(
  channel: MockChannel<IpcCallRecord>,
  method: string | undefined,
): IpcCallRecord[] {
  const history = channel.history();
  if (method === undefined) {
    return [...history];
  }
  return history.filter((req) => req.method === method);
}

export interface IpcMockController {
  /** Register a response for matching IPC calls. Newest registration wins. */
  on(matcher: IpcMatcher, response: MockResponse<IpcCallRecord>): void;
  calls(method?: string): IpcCallRecord[];
  callCount(method?: string): number;
  lastCall(method?: string): IpcCallRecord | undefined;
}

/**
 * Transport-level controls unique to the gateway channel. The fake answers
 * every method (it never throws `NoMockMatchError` — incidental gateway
 * calls are ubiquitous in the suite), so tests shape what the transport says
 * to UN-registered requests instead.
 */
export interface GatewayTransportControls {
  /**
   * Results answered for methods no `.on` registration claimed. A key mapped
   * to `undefined` suppresses even the `get_feature_flags` sentinel for that
   * method. Replaces any previously set defaults.
   */
  setDefaults(results: Record<string, unknown>): void;
  /**
   * Simulate a failed socket connect: the persistent client throws
   * `IpcConnectError`, the one-shot `ipcCall` returns `undefined` (mirroring
   * the real module).
   */
  failConnect(opts?: { code?: string }): void;
  /**
   * Throw a transient (retryable) connect error for the first `n`
   * persistent-client calls; with `ipcCallError`, a non-retryable
   * `IpcCallError` instead. Consulted AFTER `.on` registrations, so a
   * registered response is never "failed" by these knobs.
   */
  failFirstN(n: number, opts?: { ipcCallError?: boolean }): void;
  /** Persistent-client `.call` invocations for `method` since the last reset. */
  persistentCallCount(method: string): number;
}

export type IpcMockChannel = "cli" | "gateway";

export async function mockIpc(
  channel: "gateway",
): Promise<IpcMockController & GatewayTransportControls>;
export async function mockIpc(channel: "cli"): Promise<IpcMockController>;
export async function mockIpc(
  channel: IpcMockChannel,
): Promise<IpcMockController & Partial<GatewayTransportControls>> {
  if (channel === "cli") {
    await ensureCliClientMock();
  }
  const target = channel === "cli" ? cliChannel : gatewayChannel;
  const base: IpcMockController = {
    on: (matcher, response) => target.on(matcher, response),
    calls: (method) => filterIpcCalls(target, method),
    callCount: (method) => filterIpcCalls(target, method).length,
    lastCall: (method) => {
      const list = filterIpcCalls(target, method);
      return list[list.length - 1];
    },
  };
  if (channel !== "gateway") {
    return base;
  }
  return {
    ...base,
    setDefaults: (results) => {
      gatewayDefaults = { ...results };
    },
    failConnect: (opts) => {
      gatewayConnectError = true;
      if (opts?.code !== undefined) {
        gatewayConnectErrorCode = opts.code;
      }
    },
    failFirstN: (n, opts) => {
      gatewayFailFirstN = n;
      gatewayFailFirstNIpcCallError = opts?.ipcCallError ?? false;
    },
    persistentCallCount: (method) => gatewayPersistentCallCounts[method] ?? 0,
  };
}

/**
 * Build a `ok: false` IPC response with the typed failure fields
 * (`statusCode` / `errorCode` / `errorDetails` mirror the daemon's
 * RouteError envelope).
 */
export function ipcError(
  error: string,
  fields?: {
    statusCode?: number;
    errorCode?: string;
    errorDetails?: unknown;
  },
): Record<string, unknown> {
  const result: Record<string, unknown> = { ok: false, error };
  if (fields?.statusCode !== undefined) {
    result.statusCode = fields.statusCode;
  }
  if (fields?.errorCode !== undefined) {
    result.errorCode = fields.errorCode;
  }
  if (fields?.errorDetails !== undefined) {
    result.errorDetails = fields.errorDetails;
  }
  return result;
}

/**
 * Hook for the gateway transport fake (below): consult the gateway channel
 * FIRST, falling through to the per-test transport defaults when nothing
 * matches. An `Error`-instance response comes back as the resolved value so
 * the caller can apply the one-shot/persistent failure contract.
 */
export function dispatchGatewayIpcRequest(
  method: string,
  params?: Record<string, unknown>,
): { handled: boolean; value?: unknown } {
  if (gatewayChannel.isEmpty()) {
    return { handled: false };
  }
  try {
    return {
      handled: true,
      value: gatewayChannel.dispatch({ method, params }),
    };
  } catch (error) {
    if (error instanceof NoMockMatchError) {
      return { handled: false };
    }
    return { handled: true, value: error };
  }
}

// ---------------------------------------------------------------------------
// Gateway transport fake (installed globally once by test-preload.ts)
// ---------------------------------------------------------------------------

/**
 * Sentinel answered for `get_feature_flags` when neither a registration nor
 * a per-test default covers it. Keeps the response non-empty so
 * `initFeatureFlagOverrides()` does not enter its 7.75 s empty-result retry
 * loop in tests that build the CLI program or otherwise trigger flag
 * initialization. The key starts with a double underscore so it cannot
 * collide with any real registry-declared flag.
 */
const GET_FEATURE_FLAGS_SENTINEL: Record<string, boolean> = {
  __test_default__: false,
};

class FakeIpcCallError extends Error {
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly errorDetails?: unknown;

  constructor(
    message: string,
    fields: {
      statusCode?: number;
      errorCode?: string;
      errorDetails?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "IpcCallError";
    if (fields.statusCode !== undefined) {
      this.statusCode = fields.statusCode;
    }
    if (fields.errorCode !== undefined) {
      this.errorCode = fields.errorCode;
    }
    if (fields.errorDetails !== undefined) {
      this.errorDetails = fields.errorDetails;
    }
  }
}

class FakeIpcConnectError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "IpcConnectError";
    if (code !== undefined) {
      this.code = code;
    }
  }
}

const RETRYABLE_CONNECT_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

function isRetryableIpcConnectError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && RETRYABLE_CONNECT_CODES.has(code);
  }
  return false;
}

// Per-test transport state — cleared by resetRequestMockChannels.
let gatewayDefaults: Record<string, unknown> = {};
let gatewayConnectError = false;
let gatewayConnectErrorCode: string | undefined;
let gatewayFailFirstN = 0;
let gatewayFailFirstNIpcCallError = false;
const gatewayPersistentCallCounts: Record<string, number> = {};

function mockConnectError(): FakeIpcConnectError {
  return new FakeIpcConnectError(
    "Mock IPC socket error",
    gatewayConnectErrorCode ?? "ENOENT",
  );
}

/** The transport's answer for a method no `.on` registration claimed. */
function gatewayDefaultAnswer(method: string): unknown {
  if (method in gatewayDefaults) {
    return gatewayDefaults[method];
  }
  if (method === "get_feature_flags") {
    return GET_FEATURE_FLAGS_SENTINEL;
  }
  return undefined;
}

class FakePersistentIpcClient extends EventEmitter {
  async call(
    method: string,
    _params?: Record<string, unknown>,
    _timeoutMs?: number,
  ): Promise<unknown> {
    gatewayPersistentCallCounts[method] =
      (gatewayPersistentCallCounts[method] ?? 0) + 1;
    const dispatched = dispatchGatewayIpcRequest(method, _params);
    if (dispatched.handled) {
      if (dispatched.value instanceof Error) {
        throw dispatched.value;
      }
      return dispatched.value;
    }
    if (gatewayFailFirstN > 0) {
      gatewayFailFirstN--;
      if (gatewayFailFirstNIpcCallError) {
        throw new FakeIpcCallError("Mock deterministic gateway error");
      }
      throw mockConnectError();
    }
    if (gatewayConnectError) {
      throw mockConnectError();
    }
    return gatewayDefaultAnswer(method);
  }

  destroy(): void {
    /* no-op */
  }
}

/**
 * Swap `@mycadet/gateway-client/ipc-client` for the channel-backed fake.
 * Registered once in the test preload so every test file gets a no-op IPC
 * layer by default — no test accidentally connects to a real gateway socket.
 */
export function installGatewayIpcMock(): void {
  // Named exports here must cover every ipc-client symbol the package barrel
  // re-exports. Bun's mock replaces that module for relative and package
  // imports, so a missing name fails assistant tests at load time.
  mock.module("@mycadet/gateway-client/ipc-client", () => ({
    ipcCall: async (
      _socketPath: string,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> => {
      const dispatched = dispatchGatewayIpcRequest(method, params);
      if (dispatched.handled) {
        // Real ipcCall returns undefined on failure — mirror that behavior.
        return dispatched.value instanceof Error ? undefined : dispatched.value;
      }
      if (gatewayConnectError) {
        // Real ipcCall returns undefined on failure — mirror that behavior.
        return undefined;
      }
      return gatewayDefaultAnswer(method);
    },
    IpcCallError: FakeIpcCallError,
    IpcConnectError: FakeIpcConnectError,
    isRetryableIpcConnectError,
    PersistentIpcClient: FakePersistentIpcClient,
  }));
}

// ---------------------------------------------------------------------------
// CLI client transport fake (lazy — only files that call mockIpc("cli"))
// ---------------------------------------------------------------------------

const CLI_CLIENT_MODULE = "../ipc/cli-client.js";
let cliClientMockInstalled = false;

async function ensureCliClientMock(): Promise<void> {
  if (cliClientMockInstalled) {
    return;
  }
  cliClientMockInstalled = true;
  // Spread the REAL module and replace only the transport functions — the
  // same shape the hand-rolled per-file stubs used, minus the boilerplate.
  // exitCodeFromIpcResult stays real (pure mapping, zero drift).
  const real = await import(CLI_CLIENT_MODULE);
  mock.module(CLI_CLIENT_MODULE, () => ({
    ...real,
    cliIpcCall: fakeCliIpcCall,
    cliIpcCallBinary: fakeCliIpcCallBinary,
    cliIpcCallStream: fakeCliIpcCallStream,
    exitFromIpcResult: (
      result: { ok: boolean; error?: string; statusCode?: number },
      _command?: unknown,
    ) => {
      // Non-killing stand-in for the real process.exit (the hand-rolled-stub
      // convention): same stderr line + exit code, no process death.
      process.stderr.write(`${result.error ?? "Unknown error"}\n`);
      process.exitCode = real.exitCodeFromIpcResult(result);
    },
  }));
}

function normalizeCliResponse(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    if (typeof value.error === "string") {
      const result: Record<string, unknown> = { ok: false, error: value.error };
      if (typeof value.statusCode === "number") {
        result.statusCode = value.statusCode;
      }
      if (typeof value.errorCode === "string") {
        result.errorCode = value.errorCode;
      }
      if (value.errorDetails !== undefined) {
        result.errorDetails = value.errorDetails;
      }
      return result;
    }
    if (
      typeof value.ok === "boolean" &&
      ("result" in value || "error" in value)
    ) {
      // Full CliIpcCallResult passthrough. A bare result that merely CONTAINS
      // an `ok` field (APIs echo ok:true in their payloads) must still be
      // wrapped, so requiring a result/error key disambiguates the envelope.
      return value;
    }
  }
  return { ok: true, result: value };
}

function encodeChunk(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return new TextEncoder().encode(JSON.stringify(value));
}

function streamFrom(body: unknown): ReadableStream<Uint8Array> {
  const chunks = Array.isArray(body)
    ? body.map(encodeChunk)
    : [encodeChunk(body)];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function fakeCliIpcCall(
  method: string,
  params?: Record<string, unknown>,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    cancelOnDisconnect?: boolean;
  },
): Promise<Record<string, unknown>> {
  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const value = cliChannel.dispatch({ method, params });
  return normalizeCliResponse(value);
}

async function fakeCliIpcCallBinary(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const value = cliChannel.dispatch({ method, params });
  if (value instanceof Uint8Array) {
    return { ok: true, headers: {}, bytes: value };
  }
  if (isRecord(value) && "bytes" in value) {
    return {
      ok: true,
      headers: isRecord(value.headers) ? value.headers : {},
      bytes: value.bytes,
    };
  }
  return normalizeCliResponse(value);
}

async function fakeCliIpcCallStream(
  method: string,
  params?: Record<string, unknown>,
  options?: { firstByteTimeoutMs?: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const value = cliChannel.dispatch({ method, params });
  if (value instanceof Uint8Array || typeof value === "string") {
    return { ok: true, headers: {}, body: streamFrom(value), abort: () => {} };
  }
  if (isRecord(value) && "body" in value) {
    return {
      ok: true,
      headers: isRecord(value.headers) ? value.headers : {},
      body: streamFrom(value.body),
      abort: () => {},
    };
  }
  return normalizeCliResponse(value);
}

// ---------------------------------------------------------------------------
// HTTP channel (globalThis.fetch)
// ---------------------------------------------------------------------------

export type HttpMatcher =
  | string
  | RegExp
  | { method?: string; url?: string; path?: string; body?: unknown }
  | ((req: HttpRequestRecord) => boolean);

function compileHttpMatcher(
  matcher: unknown,
): CompiledMatcher<HttpRequestRecord> {
  if (typeof matcher === "string") {
    return { match: (req) => req.url.includes(matcher), describe: matcher };
  }
  if (matcher instanceof RegExp) {
    return {
      match: (req) => matcher.test(req.url),
      describe: String(matcher),
    };
  }
  if (typeof matcher === "function") {
    return { match: (req) => matcher(req), describe: "(predicate)" };
  }
  const spec = isRecord(matcher) ? matcher : {};
  const method =
    typeof spec.method === "string" ? spec.method.toUpperCase() : undefined;
  const url = typeof spec.url === "string" ? spec.url : undefined;
  const path = typeof spec.path === "string" ? spec.path : undefined;
  const body = spec.body;
  return {
    match: (req) =>
      (method === undefined || req.method === method) &&
      (url === undefined || req.url.includes(url)) &&
      (path === undefined || req.url.includes(path)) &&
      (body === undefined ||
        (req.body !== undefined && deepMatches(body, req.body))),
    describe: JSON.stringify(matcher),
  };
}

function describeHttpRequest(req: HttpRequestRecord): string {
  return `${req.method} ${req.url}`;
}

function headersToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (headers === undefined) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    const record: Record<string, string> = {};
    for (const entry of headers) {
      const key = entry[0];
      const value = entry[1];
      if (key !== undefined && value !== undefined) {
        record[key] = value;
      }
    }
    return record;
  }
  return { ...headers };
}

function toHttpRequestRecord(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): HttpRequestRecord {
  const url = input instanceof Request ? input.url : String(input);
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const headers = headersToRecord(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const rawBody = init?.body;
  let body: unknown;
  if (typeof rawBody === "string") {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  } else if (rawBody !== undefined) {
    body = rawBody;
  }
  return { url, method, headers, body };
}

function isResponseEnvelope(value: Record<string, unknown>): boolean {
  return (
    typeof value.status === "number" || "body" in value || "headers" in value
  );
}

function toResponse(value: unknown): Response {
  if (value instanceof Response) {
    return value;
  }
  if (isRecord(value) && isResponseEnvelope(value)) {
    const status = typeof value.status === "number" ? value.status : 200;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (isRecord(value.headers)) {
      for (const [key, headerValue] of Object.entries(value.headers)) {
        headers[key] = String(headerValue);
      }
    }
    const payload = "body" in value ? value.body : undefined;
    const text =
      typeof payload === "string"
        ? payload
        : payload === undefined
          ? "null"
          : JSON.stringify(payload);
    return new Response(text, { status, headers });
  }
  if (typeof value === "string") {
    return new Response(value, { status: 200 });
  }
  return new Response(JSON.stringify(value ?? null), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

let httpChannel: MockChannel<HttpRequestRecord> | undefined;
let originalFetch: typeof globalThis.fetch | undefined;

const mockedFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const channel = httpChannel;
    const real = originalFetch;
    if (channel === undefined || real === undefined) {
      throw new Error(
        "mockHttp() channel is not active — did resetRequestMockChannels() run mid-test?",
      );
    }
    const value = channel.dispatch(toHttpRequestRecord(input, init));
    return toResponse(value);
  },
  { preconnect: () => {} },
);

function filterHttpCalls(
  channel: MockChannel<HttpRequestRecord>,
  method: string | undefined,
): HttpRequestRecord[] {
  const history = channel.history();
  if (method === undefined) {
    return [...history];
  }
  const upper = method.toUpperCase();
  return history.filter((req) => req.method === upper);
}

export interface HttpMockController {
  /** Register a response for matching requests. Newest registration wins. */
  on(matcher: HttpMatcher, response: MockResponse<HttpRequestRecord>): void;
  on(
    method: string,
    url: string,
    response: MockResponse<HttpRequestRecord>,
  ): void;
  calls(method?: string): HttpRequestRecord[];
  callCount(method?: string): number;
  lastCall(method?: string): HttpRequestRecord | undefined;
}

/** Mock HTTP at the `globalThis.fetch` boundary. Restored on channel reset. */
export function mockHttp(): HttpMockController {
  if (httpChannel === undefined) {
    httpChannel = new MockChannel<HttpRequestRecord>(
      compileHttpMatcher,
      describeHttpRequest,
    );
  }
  if (originalFetch === undefined) {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockedFetch;
  }
  const channel = httpChannel;
  return {
    on: (
      ...args:
        | [matcher: HttpMatcher, response: MockResponse<HttpRequestRecord>]
        | [
            method: string,
            url: string,
            response: MockResponse<HttpRequestRecord>,
          ]
    ) => {
      if (args.length === 3) {
        channel.on({ method: args[0], url: args[1] }, args[2]);
        return;
      }
      channel.on(args[0], args[1]);
    },
    calls: (method) => filterHttpCalls(channel, method),
    callCount: (method) => filterHttpCalls(channel, method).length,
    lastCall: (method) => {
      const list = filterHttpCalls(channel, method);
      return list[list.length - 1];
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Clear every requests-mock channel and restore the real fetch. Registered
 * once as a global `afterEach` in test-preload.ts — per-test isolation is
 * automatic; tests never call this themselves.
 */
export function resetRequestMockChannels(): void {
  cliChannel.reset();
  gatewayChannel.reset();
  gatewayDefaults = {};
  gatewayConnectError = false;
  gatewayConnectErrorCode = undefined;
  gatewayFailFirstN = 0;
  gatewayFailFirstNIpcCallError = false;
  for (const key of Object.keys(gatewayPersistentCallCounts)) {
    delete gatewayPersistentCallCounts[key];
  }
  if (originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  httpChannel = undefined;
}
