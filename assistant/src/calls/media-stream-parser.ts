/**
 * Strict parser/validator for inbound Twilio Media Stream WebSocket frames.
 *
 * Every frame arriving on the media-stream WebSocket is raw JSON. This module
 * parses the JSON, validates its shape against the protocol types defined in
 * `media-stream-protocol.ts`, and returns a discriminated result so callers
 * can branch on success/failure without try/catch.
 *
 * Design decisions:
 * - Fail-fast: malformed frames are rejected immediately with a structured
 *   error rather than propagated as partial data. This keeps downstream
 *   consumers (turn detector, STT session) free from defensive null checks.
 * - No logging: the parser is a pure function. Callers decide how to log
 *   rejected frames (warn, debug, metric, etc.).
 * - No dependencies on runtime singletons so the parser is trivially
 *   testable in isolation.
 */

import { z } from "zod";

import { isPlainObject } from "../util/object.js";
import type { MediaStreamEvent } from "./media-stream-protocol.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; event: MediaStreamEvent }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Per-event schemas
// ---------------------------------------------------------------------------

const startSchema = z.object({
  event: z.literal("start"),
  sequenceNumber: z.string(),
  streamSid: z.string(),
  start: z.object({
    accountSid: z.string(),
    streamSid: z.string(),
    callSid: z.string(),
    tracks: z.array(z.string()),
    // customParameters can be missing; default to empty object
    customParameters: z.record(z.string(), z.string()).catch({}),
    mediaFormat: z.object({
      encoding: z.string(),
      sampleRate: z.number(),
      channels: z.number(),
    }),
  }),
});

const mediaSchema = z.object({
  event: z.literal("media"),
  sequenceNumber: z.string(),
  streamSid: z.string(),
  media: z.object({
    track: z.string(),
    chunk: z.string(),
    timestamp: z.string(),
    payload: z.string(),
  }),
});

const dtmfSchema = z.object({
  event: z.literal("dtmf"),
  sequenceNumber: z.string(),
  streamSid: z.string(),
  dtmf: z.object({
    digit: z.string(),
    duration: z.string().optional(),
  }),
});

const markSchema = z.object({
  event: z.literal("mark"),
  sequenceNumber: z.string(),
  streamSid: z.string(),
  mark: z.object({
    name: z.string(),
  }),
});

const stopSchema = z.object({
  event: z.literal("stop"),
  sequenceNumber: z.string(),
  streamSid: z.string(),
  stop: z.object({
    accountSid: z.string(),
    callSid: z.string(),
  }),
});

const frameSchema = z.discriminatedUnion("event", [
  startSchema,
  mediaSchema,
  dtmfSchema,
  markSchema,
  stopSchema,
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Known inbound event types from the Twilio Media Stream protocol.
 * Any event whose `event` field is not in this set is treated as
 * unrecognised and rejected.
 */
const KNOWN_EVENTS: string[] = ["start", "media", "dtmf", "mark", "stop"];

/**
 * Parse and validate a raw WebSocket message string into a typed
 * {@link MediaStreamEvent}.
 *
 * Returns `{ ok: true, event }` on success or `{ ok: false, error }`
 * with a human-readable reason on failure. Callers decide whether to
 * log, metric, or ignore rejected frames.
 */
export function parseMediaStreamFrame(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: "Frame is not a JSON object" };
  }

  const eventType = parsed.event;
  if (typeof eventType !== "string") {
    return { ok: false, error: "Missing or non-string 'event' field" };
  }

  if (!KNOWN_EVENTS.includes(eventType)) {
    return { ok: false, error: `Unrecognised event type: "${eventType}"` };
  }

  const result = frameSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.map(String).join(".");
    return {
      ok: false,
      error: `${eventType}: missing or invalid ${path || "frame"} object`,
    };
  }
  return { ok: true, event: result.data };
}
