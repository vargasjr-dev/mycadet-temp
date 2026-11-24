import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ChannelDeliveryError } from "@mycadet/gateway-client/http-delivery";
import { z } from "zod";

import { deliverChannelReply } from "../runtime/gateway-client.js";
import { fetchMock } from "./helpers/fetch-mock.js";
import { jsonObjectSchema } from "./helpers/json-object-schema.js";

const managedOutboundSchema = z.object({
  route_id: z.string(),
  assistant_id: z.string(),
  normalized_send: z.object({
    sourceChannel: z.string(),
    message: z.object({
      to: z.string(),
      content: z.string(),
      externalMessageId: z.string(),
    }),
    source: z.object({ requestId: z.string() }),
    raw: z.object({ sourceUpdateId: z.string() }),
  }),
});

type FetchCall = {
  url: string;
  init: RequestInit;
};

describe("gateway-client managed outbound lane", () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = fetchMock(
      mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        calls.push({ url, init: init ?? {} });
        return new Response(JSON.stringify({ status: "accepted" }), {
          status: 202,
        });
      }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("translates managed callback URL into managed outbound-send request", async () => {
    await deliverChannelReply(
      "https://test-cloud.mycadet.ai/v1/internal/managed-gateway/outbound-send/?route_id=route-123&assistant_id=assistant-123&source_channel=phone&source_update_id=CA-inbound-123&callback_token=runtime-token",
      {
        chatId: "+15550001111",
        text: "hello from runtime",
      },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(
      "https://test-cloud.mycadet.ai/v1/internal/managed-gateway/outbound-send/",
    );

    const headers = new Headers(call.init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Managed-Gateway-Callback-Token")).toBe(
      "runtime-token",
    );
    expect(headers.get("X-Idempotency-Key")).toStartWith("mgw-send-");
    expect(headers.has("Authorization")).toBe(false);

    const body = managedOutboundSchema.parse(
      JSON.parse(String(call.init.body)),
    );
    expect(body.route_id).toBe("route-123");
    expect(body.assistant_id).toBe("assistant-123");
    expect(body.normalized_send.sourceChannel).toBe("phone");
    expect(body.normalized_send.message.to).toBe("+15550001111");
    expect(body.normalized_send.message.content).toBe("hello from runtime");
    expect(body.normalized_send.message.externalMessageId).toStartWith(
      "mgw-send-",
    );
    expect(body.normalized_send.source.requestId).toBe(
      body.normalized_send.message.externalMessageId,
    );
    expect(body.normalized_send.raw.sourceUpdateId).toBe("CA-inbound-123");
  });

  test("retries managed outbound send on retriable upstream responses with stable idempotency key", async () => {
    calls.length = 0;
    let attempt = 0;
    globalThis.fetch = fetchMock(
      mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        calls.push({ url, init: init ?? {} });
        attempt += 1;
        if (attempt === 1) {
          return new Response("temporary upstream error", { status: 502 });
        }
        return new Response(JSON.stringify({ status: "accepted" }), {
          status: 202,
        });
      }),
    );

    await deliverChannelReply(
      "https://test-cloud.mycadet.ai/v1/internal/managed-gateway/outbound-send/?route_id=route-retry&assistant_id=assistant-retry&source_channel=phone&source_update_id=CA-retry",
      {
        chatId: "+15550002222",
        text: "retry this outbound send",
      },
    );

    expect(calls).toHaveLength(2);

    const firstHeaders = new Headers(calls[0].init.headers);
    const secondHeaders = new Headers(calls[1].init.headers);
    expect(firstHeaders.has("X-Idempotency-Key")).toBe(true);
    expect(secondHeaders.get("X-Idempotency-Key")).toBe(
      firstHeaders.get("X-Idempotency-Key"),
    );

    const firstBody = managedOutboundSchema.parse(
      JSON.parse(String(calls[0].init.body)),
    );
    const secondBody = managedOutboundSchema.parse(
      JSON.parse(String(calls[1].init.body)),
    );
    expect(secondBody.normalized_send.source.requestId).toBe(
      firstBody.normalized_send.source.requestId,
    );
  });

  test("falls back to standard callback delivery for non-managed callback URL", async () => {
    await deliverChannelReply("https://gateway.test/deliver/voice", {
      chatId: "+15550001111",
      text: "standard gateway callback",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://gateway.test/deliver/voice");

    const headers = new Headers(call.init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.has("Authorization")).toBe(false);

    const body = jsonObjectSchema.parse(JSON.parse(String(call.init.body)));
    expect(body).toEqual({
      chatId: "+15550001111",
      text: "standard gateway callback",
    });
  });

  test("throws ChannelDeliveryError with userMessage when gateway returns JSON error with userMessage", async () => {
    globalThis.fetch = fetchMock(
      mock(async () => {
        return new Response(
          JSON.stringify({
            error: "Permission denied",
            userMessage:
              "The bot is not a member of this channel. Please invite it first.",
          }),
          { status: 403 },
        );
      }),
    );

    let caught: unknown;
    try {
      await deliverChannelReply("https://gateway.test/deliver/voice", {
        chatId: "C123",
        text: "hello",
      });
    } catch (err) {
      caught = err;
    }

    assert(
      caught instanceof ChannelDeliveryError,
      "Expected ChannelDeliveryError",
    );
    const deliveryError = caught;
    expect(deliveryError.statusCode).toBe(403);
    expect(deliveryError.userMessage).toBe(
      "The bot is not a member of this channel. Please invite it first.",
    );
    expect(deliveryError.message).toContain("403");
  });

  test("throws ChannelDeliveryError without userMessage when gateway returns JSON error without userMessage", async () => {
    globalThis.fetch = fetchMock(
      mock(async () => {
        return new Response(JSON.stringify({ error: "Delivery failed" }), {
          status: 502,
        });
      }),
    );

    let caught: unknown;
    try {
      await deliverChannelReply("https://gateway.test/deliver/voice", {
        chatId: "C123",
        text: "hello",
      });
    } catch (err) {
      caught = err;
    }

    assert(
      caught instanceof ChannelDeliveryError,
      "Expected ChannelDeliveryError",
    );
    const deliveryError = caught;
    expect(deliveryError.statusCode).toBe(502);
    expect(deliveryError.userMessage).toBeUndefined();
  });

  test("throws ChannelDeliveryError without userMessage when gateway returns non-JSON error", async () => {
    globalThis.fetch = fetchMock(
      mock(async () => {
        return new Response("Internal Server Error", { status: 500 });
      }),
    );

    let caught: unknown;
    try {
      await deliverChannelReply("https://gateway.test/deliver/voice", {
        chatId: "C123",
        text: "hello",
      });
    } catch (err) {
      caught = err;
    }

    assert(
      caught instanceof ChannelDeliveryError,
      "Expected ChannelDeliveryError",
    );
    const deliveryError = caught;
    expect(deliveryError.statusCode).toBe(500);
    expect(deliveryError.userMessage).toBeUndefined();
  });
});
