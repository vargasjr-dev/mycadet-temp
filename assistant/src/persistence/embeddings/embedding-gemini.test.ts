import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { z } from "zod";

import { fetchMock as withFetchPreconnect } from "../../__tests__/helpers/fetch-mock.js";
import {
  GeminiEmbeddingBackend,
  GeminiEmbedError,
} from "./embedding-gemini.js";

function makeSuccessResponse(values: number[]) {
  return new Response(JSON.stringify({ embedding: { values } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchImplementation = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetchMock(implementation: FetchImplementation) {
  const capture = mock(implementation);
  const replacement: (
    ...args: Parameters<typeof fetch>
  ) => Promise<Response> = (url, init) => {
    assert(
      typeof url === "string" && init,
      "Expected a URL and request options",
    );
    return capture(url, init);
  };
  globalThis.fetch = withFetchPreconnect(replacement);
  return capture;
}

const requestBodySchema = z.record(z.string(), z.unknown());
const textContentSchema = z.looseObject({
  parts: z.array(z.looseObject({ text: z.string().optional() })),
});
const singleRequestSchema = z.looseObject({ content: textContentSchema });
const batchRequestSchema = z.looseObject({
  requests: z.array(singleRequestSchema),
});

function requestBody(init: RequestInit) {
  assert(typeof init.body === "string", "Expected a JSON request body");
  return requestBodySchema.parse(JSON.parse(init.body));
}

describe("GeminiEmbeddingBackend", () => {
  let mockFetch: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    mockFetch = installFetchMock(() =>
      Promise.resolve(makeSuccessResponse([0.1, 0.2, 0.3])),
    );
  });

  describe("text inputs", () => {
    test("sends text as parts: [{ text }]", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed(["hello world"]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toContain("models/test-model:embedContent");
      expect(url).toContain("key=test-key");

      const body = requestBody(init);
      expect(body.model).toBeUndefined();
      expect(body.content).toEqual({ parts: [{ text: "hello world" }] });
    });

    test("handles TextEmbeddingInput objects", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed([{ type: "text", text: "structured text" }]);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = requestBody(init);
      expect(body.content).toEqual({ parts: [{ text: "structured text" }] });
    });
  });

  describe("image inputs", () => {
    test("sends image as inline_data with base64", async () => {
      const imageData = Buffer.from("fake-png-data");
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed([
        { type: "image", data: imageData, mimeType: "image/png" },
      ]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0]!;
      const body = requestBody(init);
      expect(body.content).toEqual({
        parts: [
          {
            inline_data: {
              mime_type: "image/png",
              data: imageData.toString("base64"),
            },
          },
        ],
      });
    });
  });

  describe("audio inputs", () => {
    test("sends audio as inline_data with base64", async () => {
      const audioData = Buffer.from("fake-audio-data");
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed([
        { type: "audio", data: audioData, mimeType: "audio/mp3" },
      ]);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = requestBody(init);
      expect(body.content).toEqual({
        parts: [
          {
            inline_data: {
              mime_type: "audio/mp3",
              data: audioData.toString("base64"),
            },
          },
        ],
      });
    });
  });

  describe("video inputs", () => {
    test("sends video as inline_data with base64", async () => {
      const videoData = Buffer.from("fake-video-data");
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed([
        { type: "video", data: videoData, mimeType: "video/mp4" },
      ]);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = requestBody(init);
      expect(body.content).toEqual({
        parts: [
          {
            inline_data: {
              mime_type: "video/mp4",
              data: videoData.toString("base64"),
            },
          },
        ],
      });
    });
  });

  describe("taskType and outputDimensionality", () => {
    test("includes taskType in request body when configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        taskType: "RETRIEVAL_DOCUMENT",
      });
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = requestBody(init);
      expect(body.taskType).toBe("RETRIEVAL_DOCUMENT");
    });

    test("includes outputDimensionality in request body when dimensions configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        dimensions: 256,
      });
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = requestBody(init);
      expect(body.outputDimensionality).toBe(256);
    });

    test("includes both taskType and outputDimensionality when both configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        taskType: "SEMANTIC_SIMILARITY",
        dimensions: 512,
      });
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = requestBody(init);
      expect(body.taskType).toBe("SEMANTIC_SIMILARITY");
      expect(body.outputDimensionality).toBe(512);
    });

    test("omits taskType when not configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = requestBody(init);
      expect(body.taskType).toBeUndefined();
    });

    test("omits outputDimensionality when not configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = requestBody(init);
      expect(body.outputDimensionality).toBeUndefined();
    });

    test("omits both when options is undefined", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = requestBody(init);
      expect(body.taskType).toBeUndefined();
      expect(body.outputDimensionality).toBeUndefined();
      expect(Object.keys(body)).toEqual(["content"]);
    });
  });

  describe("error handling", () => {
    test("throws GeminiEmbedError on non-OK response", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("Internal Server Error", { status: 500 })),
      );

      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      const err = await backend.embed(["hello"]).catch((e: unknown) => e);
      assert(err instanceof GeminiEmbedError);
      expect(err.status).toBe(500);
      expect(err.message).toContain(
        "Gemini embeddings request failed (500): Internal Server Error",
      );
    });

    test("attaches retryAfterMs from Retry-After delta-seconds header on 429", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "Retry-After": "30" },
          }),
        ),
      );

      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      const err = await backend.embed(["hello"]).catch((e: unknown) => e);
      assert(err instanceof GeminiEmbedError);
      expect(err.status).toBe(429);
      expect(err.retryAfterMs).toBe(30000);
    });

    test("retryAfterMs is undefined on 429 without Retry-After header", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("rate limited", { status: 429 })),
      );

      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      const err = await backend.embed(["hello"]).catch((e: unknown) => e);
      assert(err instanceof GeminiEmbedError);
      expect(err.retryAfterMs).toBeUndefined();
    });

    test("throws when response is missing embedding values", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await expect(backend.embed(["hello"])).rejects.toThrow(
        "Gemini embeddings response missing vector values",
      );
    });

    test("throws when embedding values array is empty", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ embedding: { values: [] } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await expect(backend.embed(["hello"])).rejects.toThrow(
        "Gemini embeddings response missing vector values",
      );
    });
  });

  describe("multiple inputs", () => {
    test("embeds multiple text inputs in one batch call", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              embeddings: [{ values: [0.1, 0.2] }, { values: [0.2, 0.4] }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        interCallDelayMs: 0,
      });
      const result = await backend.embed(["hello", "world"]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([0.1, 0.2]);
      expect(result[1]).toEqual([0.2, 0.4]);
    });
  });

  describe("cloud proxy transport", () => {
    test("routes through cloud proxy base URL when cloudBaseUrl is set", async () => {
      const backend = new GeminiEmbeddingBackend(
        "ast-managed-key",
        "gemini-embedding-2",
        {
          cloudBaseUrl: "https://platform.example.com/v1/runtime-proxy/gemini",
        },
      );
      await backend.embed(["hello"]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        "https://platform.example.com/v1/runtime-proxy/gemini/v1beta/models/gemini-embedding-2:embedContent",
      );
      // Should NOT have key= query param
      expect(url).not.toContain("key=");
      // Should have Bearer auth header
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer ast-managed-key");
      // Managed path must NOT include `model` in the body — Gemini models it
      // as a protobuf oneof populated from the URL path (internally `_model`)
      // and rejects the duplicate with "oneof field '_model' is already set".
      // See the comment in embedSingle() for the full invariant.
      const body = requestBody(init);
      expect(body.model).toBeUndefined();
      expect(body._model).toBeUndefined();
    });

    test("never sets `model` or `_model` in the request body (oneof invariant)", async () => {
      // Regression for JARVIS-587: every embed_segment job was failing with
      // `Invalid value (oneof), oneof field '_model' is already set. Cannot
      // set 'model'`. Ensure neither field is ever present on the wire,
      // regardless of transport.
      const managedBackend = new GeminiEmbeddingBackend(
        "ast-managed-key",
        "gemini-embedding-2",
        {
          cloudBaseUrl: "https://platform.example.com/v1/runtime-proxy/gemini",
          taskType: "RETRIEVAL_DOCUMENT",
          dimensions: 3072,
        },
      );
      await managedBackend.embed(["hello"]);

      const directBackend = new GeminiEmbeddingBackend(
        "direct-key",
        "test-model",
      );
      await directBackend.embed(["hello"]);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      for (const [, init] of mockFetch.mock.calls) {
        const body = requestBody(init);
        expect(body.model).toBeUndefined();
        expect(body._model).toBeUndefined();
      }
    });

    test("uses direct Google API URL when cloudBaseUrl is not set", async () => {
      const backend = new GeminiEmbeddingBackend("direct-key", "test-model");
      await backend.embed(["hello"]);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toContain("generativelanguage.googleapis.com");
      expect(url).toContain("key=direct-key");
      // Should NOT have Authorization header
      const headers = new Headers(init.headers);
      expect(headers.has("Authorization")).toBe(false);
    });

    test("includes outputDimensionality with cloud proxy", async () => {
      const backend = new GeminiEmbeddingBackend(
        "ast-managed-key",
        "gemini-embedding-2",
        {
          cloudBaseUrl: "https://platform.example.com/v1/runtime-proxy/gemini",
          dimensions: 3072,
        },
      );
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0]!;
      const body = requestBody(init);
      expect(body.outputDimensionality).toBe(3072);
    });
  });
});

/** The input index encoded in a `t<n>` fixture text. */
function textIndex(text: string): number {
  return Number(text.replace(/^t/, ""));
}

/**
 * A fetch stub that answers both routes: a single `embedContent` call with a
 * vector encoding its input index, and a `batchEmbedContents` call with one
 * such vector per request in order, unless `batch` overrides its outcome.
 */
function routedFetch(batch?: {
  status?: number;
  statusOnFirstCall?: number;
  body?: unknown;
}) {
  let batchCalls = 0;
  return installFetchMock(async (url, init) => {
    if (url.includes(":batchEmbedContents")) {
      batchCalls += 1;
      const status =
        batchCalls === 1 && batch?.statusOnFirstCall !== undefined
          ? batch.statusOnFirstCall
          : (batch?.status ?? 200);
      if (status !== 200) {
        return new Response("no batch here", { status });
      }
      const embeddings =
        batch?.body !== undefined
          ? batch.body
          : batchRequestSchema
              .parse(requestBody(init))
              .requests.map((request) => ({
                values: [textIndex(request.content.parts[0]!.text!)],
              }));
      return new Response(JSON.stringify({ embeddings }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const part = singleRequestSchema.parse(requestBody(init)).content.parts[0]!;
    return makeSuccessResponse([
      part.text !== undefined ? textIndex(part.text) : -1,
    ]);
  });
}

function texts(count: number): string[] {
  return Array.from({ length: count }, (_v, i) => `t${i}`);
}

function calledUrls(fetchMock: ReturnType<typeof installFetchMock>): string[] {
  return fetchMock.mock.calls.map(([url]) => url);
}

describe("GeminiEmbeddingBackend: batched text inputs", () => {
  test("250 texts go out as three batchEmbedContents calls of 100, 100, and 50, vectors in input order", async () => {
    const fetchMock = routedFetch();
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      interCallDelayMs: 0,
    });

    const vectors = await backend.embed(texts(250));

    const urls = calledUrls(fetchMock);
    expect(urls).toHaveLength(3);
    expect(urls.every((url) => url.includes(":batchEmbedContents"))).toBe(true);
    const sizes = fetchMock.mock.calls.map(
      ([, init]) => batchRequestSchema.parse(requestBody(init)).requests.length,
    );
    expect(sizes).toEqual([100, 100, 50]);
    expect(vectors.map((v) => v[0])).toEqual(texts(250).map(textIndex));
  });

  test("cloud text inputs use single calls from the first request and preserve vector order", async () => {
    const fetchMock = routedFetch();
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      cloudBaseUrl: "https://proxy.example.com/v1/runtime-proxy/gemini",
      interCallDelayMs: 0,
    });

    expect(await backend.embed(texts(3))).toEqual([[0], [1], [2]]);
    expect(await backend.embed(["t4", "t5"])).toEqual([[4], [5]]);
    expect(calledUrls(fetchMock)).toEqual(
      Array(5).fill(
        "https://proxy.example.com/v1/runtime-proxy/gemini/v1beta/models/test-model:embedContent",
      ),
    );
  });

  test("each batched request names the model with the models/ prefix and carries taskType and outputDimensionality", async () => {
    const fetchMock = routedFetch();
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      interCallDelayMs: 0,
      taskType: "RETRIEVAL_DOCUMENT",
      dimensions: 256,
    });

    await backend.embed(texts(2));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/models/test-model:batchEmbedContents?key=test-key");
    const body = batchRequestSchema.parse(requestBody(init));
    expect(body.model).toBeUndefined();
    expect(body.requests).toEqual([
      {
        model: "models/test-model",
        content: { parts: [{ text: "t0" }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: 256,
      },
      {
        model: "models/test-model",
        content: { parts: [{ text: "t1" }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: 256,
      },
    ]);
  });

  test("a lone text keeps the embedContent route", async () => {
    const fetchMock = routedFetch();
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      interCallDelayMs: 0,
    });

    const vectors = await backend.embed(["t7"]);

    expect(calledUrls(fetchMock)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models/test-model:embedContent?key=test-key",
    ]);
    expect(vectors).toEqual([[7]]);
  });

  test("multimodal inputs take the single route while the texts around them batch, in input order", async () => {
    const fetchMock = routedFetch();
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      interCallDelayMs: 0,
    });

    const vectors = await backend.embed([
      "t0",
      { type: "image", data: Buffer.from("png"), mimeType: "image/png" },
      "t2",
      "t3",
    ]);

    const urls = calledUrls(fetchMock);
    expect(
      urls.map((url) =>
        url.includes(":batchEmbedContents") ? "batch" : "single",
      ),
    ).toEqual(["single", "single", "batch"]);
    expect(vectors.map((v) => v[0])).toEqual([0, -1, 2, 3]);
  });

  test("a batch route that does not exist falls back to single calls and is not tried again", async () => {
    const fetchMock = routedFetch({ status: 404 });
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      interCallDelayMs: 0,
    });

    const first = await backend.embed(texts(3));
    expect(first.map((v) => v[0])).toEqual([0, 1, 2]);
    // One failed batch attempt, then three singles.
    expect(
      calledUrls(fetchMock).map((url) => url.includes(":batchEmbedContents")),
    ).toEqual([true, false, false, false]);

    const second = await backend.embed(["t4", "t5"]);
    expect(second.map((v) => v[0])).toEqual([4, 5]);
    // No further batch attempt: straight to singles.
    expect(
      calledUrls(fetchMock)
        .slice(4)
        .every((url) => url.includes(":embedContent")),
    ).toBe(true);
    expect(fetchMock.mock.calls).toHaveLength(6);
  });

  test("a batch rejected as a bad request is re-sent as singles; the next batch is tried again", async () => {
    const fetchMock = routedFetch({ statusOnFirstCall: 400 });
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      interCallDelayMs: 0,
    });

    const vectors = await backend.embed(texts(150));

    expect(vectors.map((v) => v[0])).toEqual(texts(150).map(textIndex));
    const kinds = calledUrls(fetchMock).map((url) =>
      url.includes(":batchEmbedContents") ? "batch" : "single",
    );
    // The rejected first batch, its 100 singles, then the second batch of 50.
    expect(kinds).toHaveLength(102);
    expect(kinds[0]).toBe("batch");
    expect(kinds.slice(1, 101).every((kind) => kind === "single")).toBe(true);
    expect(kinds[101]).toBe("batch");
  });

  test("a batch that fails with a server error is re-sent as singles, so a fault confined to the batch route never fails the embed", async () => {
    const fetchMock = routedFetch({ status: 503 });
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      interCallDelayMs: 0,
    });

    const vectors = await backend.embed(texts(3));

    expect(vectors.map((v) => v[0])).toEqual([0, 1, 2]);
    expect(
      calledUrls(fetchMock).map((url) => url.includes(":batchEmbedContents")),
    ).toEqual([true, false, false, false]);
  });

  test("a batch request that cannot be sent is re-sent as singles, while a cancelled request rethrows", async () => {
    let batchCalls = 0;
    installFetchMock(async (url, init) => {
      if (url.includes(":batchEmbedContents")) {
        batchCalls += 1;
        throw new TypeError("fetch failed");
      }
      const part = singleRequestSchema.parse(requestBody(init)).content
        .parts[0];
      assert(part?.text !== undefined, "Expected a text part");
      return makeSuccessResponse([textIndex(part.text)]);
    });
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      interCallDelayMs: 0,
    });

    const vectors = await backend.embed(texts(2));
    expect(vectors.map((v) => v[0])).toEqual([0, 1]);
    expect(batchCalls).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      backend.embed(texts(2), { signal: controller.signal }),
    ).rejects.toThrow("fetch failed");
  });

  test("a batch error whose body cannot be read is re-sent as singles", async () => {
    let batchCalls = 0;
    const fetchMock = installFetchMock(async (url, init) => {
      if (url.includes(":batchEmbedContents")) {
        batchCalls += 1;
        const stream = new ReadableStream({
          pull(controller) {
            controller.error(new Error("stream reset"));
          },
        });
        return new Response(stream, { status: 502 });
      }
      const part = singleRequestSchema.parse(requestBody(init)).content
        .parts[0];
      assert(part?.text !== undefined, "Expected a text part");
      return makeSuccessResponse([textIndex(part.text)]);
    });
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      interCallDelayMs: 0,
    });

    const vectors = await backend.embed(texts(2));

    expect(vectors.map((v) => v[0])).toEqual([0, 1]);
    expect(batchCalls).toBe(1);
    expect(fetchMock.mock.calls).toHaveLength(3);
  });

  test("a batch answered with a body that is not JSON is re-sent as singles", async () => {
    let batchCalls = 0;
    const fetchMock = installFetchMock(async (url, init) => {
      if (url.includes(":batchEmbedContents")) {
        batchCalls += 1;
        return new Response("<html>gateway timeout</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      const part = singleRequestSchema.parse(requestBody(init)).content
        .parts[0];
      assert(part?.text !== undefined, "Expected a text part");
      return makeSuccessResponse([textIndex(part.text)]);
    });
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      interCallDelayMs: 0,
    });

    const vectors = await backend.embed(texts(3));

    expect(vectors.map((v) => v[0])).toEqual([0, 1, 2]);
    expect(batchCalls).toBe(1);
    expect(fetchMock.mock.calls).toHaveLength(4);
  });

  test("a batch body without one vector per input is re-sent as singles", async () => {
    const fetchMock = routedFetch({ body: [{ values: [0] }] });
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      interCallDelayMs: 0,
    });

    const vectors = await backend.embed(texts(3));

    expect(vectors.map((v) => v[0])).toEqual([0, 1, 2]);
    expect(fetchMock.mock.calls).toHaveLength(4);
  });
});
