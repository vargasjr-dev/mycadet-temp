/**
 * Cadet Cloud TTS: synthesis through the cloud's cloud speech
 * surfaces (Cadet-held Deepgram key, billed to Cadet credits). No provider
 * API key exists on this machine — the cloud connection is the credential.
 *
 * Two paths:
 * - Batch `synthesize` (read-aloud, mp3 surfaces) via the Django endpoint.
 * - Streaming `synthesizeStream` (live voice, telephony PCM) via the
 *   gateway's speech relay (gateway → tunnel → Deepgram; tunnel contact is
 *   gateway-only — the daemon holds no tunnel address and no speech
 *   credential).
 *
 * `allowNativeFallback: false` means synthesis failures propagate to the
 * caller's error handler, so failures here throw with user-actionable
 * messages rather than returning silence.
 */

import {
  type CloudSpeechResult,
  type CloudSpeechTtsFormat,
  managedSpeechSynthesize,
} from "../../cloud/cloud-speech.js";
import { getConfig } from "../../config/loader.js";
import {
  mapTunnelError,
  probeTunnelRejection,
  resolveSpeechRelayConnection,
} from "../../providers/speech-to-text/cadet-speech-relay-connection.js";
import { getLogger } from "../../util/logger.js";
import type { TtsProviderDefinition } from "../provider-definition.js";
import type {
  TtsProvider,
  TtsProviderCapabilities,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../types.js";
import { synthesizeOverCadetTtsSocket } from "./cadet-tts-socket.js";

const log = getLogger("cadet-tts");

const TTS_STREAM_PATH = "/v1/speech/tts/stream";

/**
 * The cloud's PCM format is fixed at 16 kHz, 16-bit LE mono — the
 * media-stream transcoder needs to know the rate regardless of hints.
 */
const CADET_PCM_SAMPLE_RATE_HZ = 16_000;

type CloudSpeechFailure = Extract<CloudSpeechResult<never>, { ok: false }>;

/**
 * Map the synthesis request onto the cloud's format vocabulary.
 *
 * The PCM hint (media-stream playback) maps to raw 16 kHz PCM for mu-law
 * transcoding; every other use case gets mp3.
 */
function resolveManagedFormat(
  request: TtsSynthesisRequest,
): CloudSpeechTtsFormat {
  return request.outputFormat === "pcm" ? "pcm_16000" : "mp3";
}

/**
 * The configured cloud voice, if any. A request-level voiceId wins over
 * config; undefined means the cloud's default voice.
 */
function resolveCloudVoice(request: TtsSynthesisRequest): string | undefined {
  return request.voiceId ?? getConfig().services.tts.providers.cadet.model;
}

function synthesisError(failure: CloudSpeechFailure): Error {
  if (failure.code === "insufficient_balance") {
    return new Error(
      "Cadet credits are exhausted — add funds to your Cadet account to continue using cloud speech.",
    );
  }
  if (failure.kind === "unavailable") {
    return new Error(
      `Cloud speech is unavailable: ${failure.message} Run 'assistant cloud connect' to connect your Cadet account.`,
    );
  }
  return new Error(failure.message);
}

async function performSynthesis(
  request: TtsSynthesisRequest,
): Promise<TtsSynthesisResult> {
  const result = await managedSpeechSynthesize({
    text: request.text,
    format: resolveManagedFormat(request),
    model: resolveCloudVoice(request),
    signal: request.signal,
  });
  if (!result.ok) {
    throw synthesisError(result);
  }
  return {
    audio: result.value.audio,
    contentType: result.value.contentType,
  };
}

/**
 * Stream one PCM utterance through the gateway's speech relay. Non-PCM
 * requests delegate to the batch path — streaming exists for realtime PCM
 * consumers (live voice, telephony), and the relay's format is pinned to
 * linear16.
 */
async function performStreamingSynthesis(
  request: TtsSynthesisRequest,
  onChunk: (chunk: Uint8Array) => void,
): Promise<TtsSynthesisResult> {
  if (request.outputFormat !== "pcm") {
    const result = await performSynthesis(request);
    onChunk(result.audio);
    return result;
  }

  const connection = await resolveSpeechRelayConnection();
  if (!connection) {
    throw new Error(
      "Cloud speech is unavailable: the assistant cannot reach its speech relay. Run 'assistant cloud connect' to connect your Cadet account.",
    );
  }

  const params = new URLSearchParams({
    key: connection.mintServiceToken(),
    encoding: "linear16",
    sample_rate: String(CADET_PCM_SAMPLE_RATE_HZ),
    // Deepgram defaults linear16 to a WAV container; the media-stream path
    // consumes headerless PCM, so RIFF header bytes would play as static.
    container: "none",
  });
  const voice = resolveCloudVoice(request);
  if (voice) {
    params.set("model", voice);
  }
  const url = `${connection.wsBaseUrl}${TTS_STREAM_PATH}?${params.toString()}`;

  log.info(
    { textLength: request.text.length },
    "Starting managed streaming TTS synthesis",
  );

  try {
    const audio = await synthesizeOverCadetTtsSocket({
      url,
      text: request.text,
      onChunk,
      signal: request.signal,
      makeTimeoutError: (timeoutMs) =>
        new Error(`Managed streaming TTS timed out after ${timeoutMs}ms`),
      makeStreamError: (detail) =>
        new Error(`Managed streaming TTS failed: ${detail}`),
      makeEmptyError: () =>
        new Error("Managed streaming TTS returned no audio"),
      makeRelayError: (code, detail) =>
        new Error(mapTunnelError({ code, detail }).message),
    });
    return {
      audio,
      contentType: "audio/pcm",
    };
  } catch (err) {
    if (request.signal?.aborted) {
      throw err;
    }
    // A rejected upgrade hides the relay's {code, detail}; replay the gate
    // as a plain GET (the gateway probes tunnel's own gate too) so auth and
    // balance failures surface with their mapped messages. The probe must
    // carry the same voice model — a model-specific rejection (e.g.
    // missing_price) only reproduces when the probe asks for that model.
    const probeParams = new URLSearchParams({
      key: connection.mintServiceToken(),
    });
    if (voice) {
      probeParams.set("model", voice);
    }
    const rejection = await probeTunnelRejection(
      `${connection.httpBaseUrl}${TTS_STREAM_PATH}?${probeParams.toString()}`,
    );
    if (rejection) {
      throw new Error(mapTunnelError(rejection).message);
    }
    throw err;
  }
}

export function createCadetProvider(): TtsProvider {
  const capabilities: TtsProviderCapabilities = {
    supportsStreaming: true,
    supportedFormats: ["mp3", "pcm"],
  };

  return {
    id: "cadet",
    capabilities,
    // Per the TtsProvider contract this returns undefined for non-PCM
    // output; the cloud's PCM format is pinned to 16 kHz.
    resolveOutputSampleRateHz: (request) =>
      request.outputFormat === "pcm" ? CADET_PCM_SAMPLE_RATE_HZ : undefined,
    synthesize: performSynthesis,
    synthesizeStream: performStreamingSynthesis,
  };
}

/**
 * The complete Cadet Cloud provider definition — catalog metadata plus
 * the runtime adapter — assembled into the canonical catalog by
 * `provider-catalog.ts`.
 */
export const cadetTtsProviderDefinition: TtsProviderDefinition = {
  id: "cadet",
  displayName: "Cadet",
  subtitle:
    "Text-to-speech through your Cadet account — billed to Cadet credits, no separate API key needed.",
  // Advertises cloud voice selection (`services.tts.providers.cadet.model`)
  // to clients; web gates its voice dropdown on this flag, so daemons that
  // predate the field never show a selector whose writes they would ignore.
  supportsVoiceSelection: true,
  apiKeyPlaceholder: "Connected via your Cadet account",
  credentialsGuide: {
    description:
      "Connect this assistant to your Cadet account; cloud speech uses that connection instead of a provider API key.",
    url: "https://cloud.mycadet.ai/",
    linkLabel: "Open Cadet Cloud",
  },
  callMode: "synthesized-play",
  allowNativeFallback: false,
  capabilities: {
    supportsStreaming: true,
    supportedFormats: ["mp3", "pcm"],
  },
  // The adapter honours the PCM hint via the cloud's pcm_16000 format.
  mediaStreamPlayback: { outputFormat: "pcm" },
  secretRequirements: [
    {
      credentialStoreKey: "credential/cadet/assistant_api_key",
      displayName: "Cadet account connection",
      setCommand: "assistant cloud connect",
    },
  ],
  adapter: createCadetProvider(),
};
