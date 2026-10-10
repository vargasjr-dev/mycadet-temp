/**
 * Client for the cloud's cloud speech endpoints: Cadet-held Deepgram
 * key, billed to the org's credits. The daemon sends complete audio (STT) or
 * text (TTS) and the cloud does the provider call — no speech credentials
 * ever live on this machine.
 *
 * Contract (mirrors `mycadet-platform` — do not change unilaterally):
 * - `POST /v1/assistants/{id}/cloud-speech/stt/transcribe/`
 *   `{audioBase64, mimeType, source?}` → 200 `{text, providerId, model,
 *   durationSeconds}`.
 * - `POST /v1/assistants/{id}/cloud-speech/tts/synthesize/`
 *   `{text, format?}` → 200 binary audio, `Content-Type` from upstream.
 * - Errors: `{code, detail}`; notable codes: `insufficient_balance` (402),
 *   `missing_price` (400), `provider_configuration_error` (500).
 *
 * Pure platform HTTP client: no provider-catalog, config-schema, or resolver
 * imports — the cadet STT/TTS providers build on top of it.
 */

import { z } from "zod";

import { CadetCloudClient } from "./client.js";

export type CloudSpeechResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: "unavailable" | "platform-error";
      status?: number;
      /** Platform error code (e.g. `insufficient_balance`) when the body carried one. */
      code?: string;
      /**
       * Platform-supplied human-readable message, present only when the error
       * body carried a `detail` field. Absent when the failure fell back to a
       * bare HTTP status. `message` mirrors this when set; callers use the
       * presence of `detail` to distinguish real platform copy (safe to surface
       * verbatim) from the generic status fallback.
       */
      detail?: string;
      message: string;
    };

export interface CloudSpeechTranscription {
  text: string;
  durationSeconds: number;
}

const CloudSpeechTranscriptionSchema = z.object({
  text: z.string(),
  durationSeconds: z.number(),
});

export interface CloudSpeechSynthesis {
  audio: Buffer;
  contentType: string;
}

export type CloudSpeechTtsFormat = "mp3" | "wav_8000" | "pcm_16000";

async function resolveClient(): Promise<
  { client: CadetCloudClient } | { error: CloudSpeechResult<never> }
> {
  const client = await CadetCloudClient.create();
  if (!client) {
    return {
      error: {
        ok: false,
        kind: "unavailable",
        message: "Cloud speech is unavailable: no Cadet Cloud connection.",
      },
    };
  }
  if (!client.cloudAssistantId) {
    return {
      error: {
        ok: false,
        kind: "unavailable",
        message:
          "Cloud speech is unavailable: platform assistant ID is missing.",
      },
    };
  }
  return { client };
}

/**
 * Whether cloud speech can be used at all: a cloud connection whose
 * assistant identity is fully provisioned. A stored API key alone is not
 * enough — synthesis/transcription would fail before any request is made.
 */
export async function managedSpeechAvailable(): Promise<boolean> {
  return !("error" in (await resolveClient()));
}

export async function managedSpeechTranscribe(input: {
  audio: Buffer;
  mimeType: string;
  source?: string;
  /**
   * Spoken language to decode: a BCP-47 code, or `"multi"` for nova-3
   * code-switching. Omitted means the cloud sends none, which Deepgram
   * decodes as English rather than detecting the language. Older platform
   * builds that predate the field ignore it, so sending one is safe before
   * the cloud side deploys.
   */
  language?: string;
  signal?: AbortSignal;
}): Promise<CloudSpeechResult<CloudSpeechTranscription>> {
  const resolved = await resolveClient();
  if ("error" in resolved) {
    return resolved.error;
  }
  const { client } = resolved;

  const response = await client.fetch(
    `/v1/assistants/${encodeURIComponent(client.cloudAssistantId)}/cloud-speech/stt/transcribe/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioBase64: input.audio.toString("base64"),
        mimeType: input.mimeType,
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.language ? { language: input.language } : {}),
      }),
      signal: input.signal,
    },
  );

  if (!response.ok) {
    return await platformError(response, "transcription");
  }

  const parsed = CloudSpeechTranscriptionSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    return {
      ok: false,
      kind: "platform-error",
      status: response.status,
      message: "Cloud speech transcription returned a malformed response.",
    };
  }
  return {
    ok: true,
    value: {
      text: parsed.data.text,
      durationSeconds: parsed.data.durationSeconds,
    },
  };
}

export async function managedSpeechSynthesize(input: {
  text: string;
  format: CloudSpeechTtsFormat;
  /** Voice model (e.g. "aura-2-thalia-en"); omitted = platform default. */
  model?: string;
  signal?: AbortSignal;
}): Promise<CloudSpeechResult<CloudSpeechSynthesis>> {
  const resolved = await resolveClient();
  if ("error" in resolved) {
    return resolved.error;
  }
  const { client } = resolved;

  const response = await client.fetch(
    `/v1/assistants/${encodeURIComponent(client.cloudAssistantId)}/cloud-speech/tts/synthesize/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: input.text,
        format: input.format,
        ...(input.model !== undefined ? { model: input.model } : {}),
      }),
      signal: input.signal,
    },
  );

  if (!response.ok) {
    return await platformError(response, "synthesis");
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) {
    return {
      ok: false,
      kind: "platform-error",
      status: response.status,
      message: "Cloud speech synthesis returned empty audio.",
    };
  }
  return {
    ok: true,
    value: {
      audio,
      contentType: response.headers.get("content-type") ?? "audio/mpeg",
    },
  };
}

export interface CloudSpeechVoice {
  model: string;
  label: string;
  description: string;
  sampleUrl: string;
  /** Upstream provider that synthesizes this voice (e.g. "deepgram"). */
  source: string;
}

export interface CloudSpeechVoiceCatalog {
  /** Offered voices in display order; only currently-usable voices. */
  voices: CloudSpeechVoice[];
  /** Always one of `voices`; null when no voices are offered. */
  defaultModel: string | null;
}

const CloudSpeechVoiceSchema = z.object({
  model: z.string(),
  label: z.string(),
  description: z.string(),
  sampleUrl: z.string(),
  source: z.string(),
});
const CloudSpeechVoiceCatalogSchema = z.object({
  voices: z.array(CloudSpeechVoiceSchema.nullable().catch(null)),
  defaultModel: z.string().nullable().optional().catch(null),
});
const CloudSpeechErrorSchema = z.object({
  code: z.string().optional().catch(undefined),
  detail: z.string().optional().catch(undefined),
});

export async function managedSpeechVoices(input?: {
  signal?: AbortSignal;
}): Promise<CloudSpeechResult<CloudSpeechVoiceCatalog>> {
  const resolved = await resolveClient();
  if ("error" in resolved) {
    return resolved.error;
  }
  const { client } = resolved;

  const response = await client.fetch(
    `/v1/assistants/${encodeURIComponent(client.cloudAssistantId)}/cloud-speech/tts/voices/`,
    { method: "GET", signal: input?.signal },
  );

  if (!response.ok) {
    return await platformError(response, "voice listing");
  }

  const parsed = CloudSpeechVoiceCatalogSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    return {
      ok: false,
      kind: "platform-error",
      status: response.status,
      message: "Cloud speech voice listing returned a malformed response.",
    };
  }
  return {
    ok: true,
    value: {
      voices: parsed.data.voices.filter(
        (voice): voice is CloudSpeechVoice => voice !== null,
      ),
      defaultModel: parsed.data.defaultModel ?? null,
    },
  };
}

async function platformError(
  response: Response,
  operation: string,
): Promise<CloudSpeechResult<never>> {
  let code: string | undefined;
  let detail: string | undefined;
  try {
    const parsed = CloudSpeechErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.code;
      detail = parsed.data.detail;
    }
  } catch {
    // Non-JSON error body; status alone will have to do.
  }
  return {
    ok: false,
    kind: "platform-error",
    status: response.status,
    code,
    detail,
    message:
      detail ??
      `Cloud speech ${operation} failed (platform returned ${response.status}).`,
  };
}
