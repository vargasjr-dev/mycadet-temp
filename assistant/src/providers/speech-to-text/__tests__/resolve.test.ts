import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import { getConfig } from "../../../config/loader.js";
import { SttError } from "../../../stt/types.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any subject imports
// ---------------------------------------------------------------------------

// -- Logger mock ----------------------------------------------------------

/**
 * Captured log messages from the resolver. Tests can assert that
 * `resolveStreamingTranscriber` logs a warning when `diarize: "required"`
 * is passed with a non-capable provider.
 */
const loggerWarnings: Array<{ data: unknown; message: string }> = [];

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    warn: (data: unknown, message: string) => {
      loggerWarnings.push({ data, message });
    },
    info: () => {},
    debug: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      warn: (data: unknown, message: string) => {
        loggerWarnings.push({ data, message });
      },
      info: () => {},
      debug: () => {},
      error: () => {},
      trace: () => {},
      fatal: () => {},
    }),
  }),
}));

// -- Credential mock ------------------------------------------------------

import { useMemorySecureKeyMap } from "../../../__tests__/helpers/secure-keys.js";
import { credentialKey } from "../../../security/credential-key.js";

// The REAL secure-keys module pinned to a live memory backend; per-test
// provider keys are seeded under their real credentialKey lookups (the
// getProviderKeyAsync primary path).
const secureKeys = useMemorySecureKeyMap();

/** Seed per-test provider keys (the old mockProviderKeys reassignments). */
function seedProviderKeys(record: Record<string, string>): void {
  secureKeys.clear();
  for (const [provider, value] of Object.entries(record)) {
    secureKeys.set(credentialKey(provider, "api_key"), value);
  }
}

// -- Cadet Cloud availability mock --------------------------------------

let mockCadetAvailable = false;

/**
 * Arguments the cloud batch adapter was called with. The cloud path has
 * no constructor to spy on (the cloud connection is the credential), so
 * the language it forwards is observable only at the transcribe call.
 */
const cadetCloudTranscribeCalls: Array<{
  mimeType: string;
  language: string | undefined;
}> = [];

mock.module("../cadet-cloud.js", () => ({
  cadetCloudSpeechAvailable: async () => mockCadetAvailable,
  cadetCloudTranscribe: async (
    _audio: Buffer,
    mimeType: string,
    _signal?: AbortSignal,
    language?: string,
  ) => {
    cadetCloudTranscribeCalls.push({ mimeType, language });
    return { text: "" };
  },
  sttErrorFromCloudSpeech: (failure: unknown) => new Error(String(failure)),
}));

const cadetStreamCtorCalls: Array<{ connection: unknown; options: unknown }> =
  [];
let mockTunnelConnection: {
  wsBaseUrl: string;
  httpBaseUrl: string;
  mintServiceToken: () => string;
} | null = null;

mock.module("../cadet-speech-relay-connection.js", () => ({
  resolveSpeechRelayConnection: async () => mockTunnelConnection,
}));

mock.module("../cadet-cloud-realtime.js", () => ({
  CadetManagedRealtimeTranscriber: class {
    readonly providerId = "cadet";
    readonly boundaryId = "daemon-streaming";
    constructor(connection: unknown, options: unknown) {
      cadetStreamCtorCalls.push({ connection, options });
    }
  },
}));

/** Constructor calls for the cloud Flux transcriber (`cadet-flux`). */
const cadetFluxStreamCtorCalls: Array<{
  connection: unknown;
  options: unknown;
}> = [];

mock.module("../cadet-cloud-flux-realtime.js", () => ({
  CadetManagedFluxRealtimeTranscriber: class {
    readonly providerId = "cadet-flux";
    readonly boundaryId = "daemon-streaming";
    constructor(connection: unknown, options: unknown) {
      cadetFluxStreamCtorCalls.push({ connection, options });
    }
  },
}));

// -- Streaming adapter mocks ----------------------------------------------

/**
 * Captured constructor calls for each streaming adapter. Tests assert on
 * these arrays to verify the resolver plumbs options (sampleRate, diarize)
 * correctly to each provider.
 */
const deepgramCtorCalls: Array<{ apiKey: string; options: unknown }> = [];
const geminiCtorCalls: Array<{ apiKey: string; options: unknown }> = [];
const whisperCtorCalls: Array<{ apiKey: string; options: unknown }> = [];
const xaiCtorCalls: Array<{ apiKey: string; options: unknown }> = [];

mock.module("../deepgram-realtime.js", () => ({
  DeepgramRealtimeTranscriber: class {
    readonly providerId = "deepgram" as const;
    readonly boundaryId = "daemon-streaming" as const;
    constructor(apiKey: string, options: unknown) {
      deepgramCtorCalls.push({ apiKey, options });
    }
  },
}));

mock.module("../google-gemini-live-stream.js", () => ({
  GoogleGeminiLiveStreamingTranscriber: class {
    readonly providerId = "google-gemini" as const;
    readonly boundaryId = "daemon-streaming" as const;
    constructor(apiKey: string, options: unknown) {
      geminiCtorCalls.push({ apiKey, options });
    }
  },
}));

mock.module("../openai-whisper-stream.js", () => ({
  OpenAIWhisperStreamingTranscriber: class {
    readonly providerId = "openai-whisper" as const;
    readonly boundaryId = "daemon-streaming" as const;
    constructor(apiKey: string, options: unknown) {
      whisperCtorCalls.push({ apiKey, options });
    }
  },
}));

/**
 * Captured constructor calls for the Deepgram BATCH provider, used to verify
 * that `resolveBatchTranscriber` threads `services.stt.language` through the
 * batch factory to the provider.
 */
const deepgramBatchCtorCalls: Array<{ apiKey: string; options: unknown }> = [];

// Real module captured before the mock replaces it, so pure exports
// (deepgramLanguageOptions) stay real while the provider class
// alone is stubbed.
const actualDeepgram = await import("../deepgram.js");

mock.module("../deepgram.js", () => ({
  ...actualDeepgram,
  DeepgramProvider: class {
    constructor(apiKey: string, options?: unknown) {
      deepgramBatchCtorCalls.push({ apiKey, options });
    }
    async transcribe() {
      return { text: "" };
    }
  },
}));

mock.module("../xai-realtime.js", () => ({
  XAIRealtimeTranscriber: class {
    readonly providerId = "xai" as const;
    readonly boundaryId = "daemon-streaming" as const;
    constructor(apiKey: string, options: unknown) {
      xaiCtorCalls.push({ apiKey, options });
    }
  },
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
//
// Use a dynamic `await import(...)` so the module-top `const log = getLogger(...)`
// in `resolve.ts` is captured by the mocked logger above. Static ESM imports
// are hoisted above all module-top statements, which would cause `resolve.ts`
// to evaluate — and call the real `getLogger` — before `mock.module(...)` runs.
// ---------------------------------------------------------------------------

const {
  effectiveSttLanguage,
  resolveBatchTranscriber,
  sttCredentialGapReason,
  resolveConversationStreamingSttCapability,
  resolveStreamingTranscriber,
  resolveTelephonySttCapability,
} = await import("../resolve.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyConfig(overrides: {
  provider?: string;
  language?: string;
  roles?: Record<string, { provider: string; model?: string }>;
}): void {
  const provider = overrides.provider ?? "openai-whisper";
  // Seed a schema-valid base so the loader caches a fresh config object, then
  // set the provider under test on that live cached object. `services.stt.
  // provider` is a strict enum, so the "unconfigured" cases (empty string /
  // non-catalog ids) can't round-trip through the validated file — resolve.ts
  // reads the live cached config, so a direct mutation drives the same code
  // path the raw mock did.
  setConfig("services", {
    stt: {
      provider: "openai-whisper",
      providers: {
        "openai-whisper": {},
        deepgram: {},
      },
    },
  });
  (getConfig().services.stt as { provider: string }).provider = provider;
  // `language` is optional and absent from the seed above, so assign it only
  // when a test asks for one, leaving the unset path genuinely unset.
  if (overrides.language !== undefined) {
    (getConfig().services.stt as { language?: string }).language =
      overrides.language;
  }
  if (overrides.roles !== undefined) {
    (
      getConfig().services.stt as {
        roles?: Record<string, { provider: string; model?: string }>;
      }
    ).roles = overrides.roles;
  }
}

// ---------------------------------------------------------------------------
// Tests — resolveBatchTranscriber
// ---------------------------------------------------------------------------

describe("resolveBatchTranscriber", () => {
  beforeEach(() => {
    secureKeys.clear(); // per-test isolation: the live store persists otherwise
    applyConfig({});
  });

  test("returns a BatchTranscriber when openai-whisper is configured and credentials are available", async () => {
    secureKeys.set(credentialKey("openai", "api_key"), "sk-test-key");
    applyConfig({ provider: "openai-whisper" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("openai-whisper");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  test("returns null when credentials are missing for the configured provider", async () => {
    applyConfig({ provider: "openai-whisper" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("returns null when configured provider is unsupported for daemon-batch", async () => {
    // Force an unknown provider past the type system to simulate a future
    // provider that hasn't been wired into the daemon-batch boundary yet.
    secureKeys.set(credentialKey("some-provider", "api_key"), "key");
    applyConfig({ provider: "unknown-provider" as string });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("uses config-driven provider selection, not hardcoded OpenAI", async () => {
    // Verify the resolver reads from config rather than always using "openai".
    // If the config says openai-whisper, we expect credential lookup for "openai".
    secureKeys.set(credentialKey("openai", "api_key"), "sk-config-driven");
    applyConfig({ provider: "openai-whisper" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("openai-whisper");
  });

  test("resolved transcriber has stable provider identity", async () => {
    secureKeys.set(credentialKey("openai", "api_key"), "sk-identity-test");
    applyConfig({ provider: "openai-whisper" });

    const transcriber = await resolveBatchTranscriber();

    // The providerId must remain "openai-whisper" for downstream identity checks.
    expect(transcriber!.providerId).toBe("openai-whisper");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  // -------------------------------------------------------------------------
  // Deepgram provider resolution
  // -------------------------------------------------------------------------

  test("returns a BatchTranscriber when deepgram is configured and credentials are available", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-test-key");
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("deepgram");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  test("returns null when deepgram is configured but no credentials exist", async () => {
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("deepgram uses 'deepgram' credential key, not 'openai'", async () => {
    // Only openai key is set — deepgram should NOT resolve
    secureKeys.set(credentialKey("openai", "api_key"), "sk-test-key");
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("resolved deepgram transcriber has stable provider identity", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-identity-test");
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber!.providerId).toBe("deepgram");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  // -------------------------------------------------------------------------
  // Google Gemini provider resolution
  // -------------------------------------------------------------------------

  test("returns a BatchTranscriber when google-gemini is configured and credentials are available", async () => {
    secureKeys.set(credentialKey("gemini", "api_key"), "gemini-test-key");
    applyConfig({ provider: "google-gemini" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("google-gemini");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });

  test("returns null when google-gemini is configured but no credentials exist", async () => {
    applyConfig({ provider: "google-gemini" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("google-gemini uses 'gemini' credential key, not 'openai' or 'deepgram'", async () => {
    // Only openai key is set — google-gemini should NOT resolve
    secureKeys.set(credentialKey("openai", "api_key"), "sk-test-key");
    applyConfig({ provider: "google-gemini" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber).toBeNull();
  });

  test("resolved google-gemini transcriber has stable provider identity", async () => {
    secureKeys.set(credentialKey("gemini", "api_key"), "gemini-identity-test");
    applyConfig({ provider: "google-gemini" });

    const transcriber = await resolveBatchTranscriber();

    expect(transcriber!.providerId).toBe("google-gemini");
    expect(transcriber!.boundaryId).toBe("daemon-batch");
  });
});

// ---------------------------------------------------------------------------
// Tests — resolveTelephonySttCapability
// ---------------------------------------------------------------------------

describe("resolveTelephonySttCapability", () => {
  beforeEach(() => {
    secureKeys.clear();
    applyConfig({});
  });

  test("returns 'supported' when provider is telephony-eligible and credentials exist", async () => {
    secureKeys.set(credentialKey("openai", "api_key"), "sk-telephony-test");
    applyConfig({ provider: "openai-whisper" });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("openai-whisper");
      // openai-whisper is batch-only, so telephonyMode should reflect that
      expect(result.telephonyMode).toBe("batch-only");
    }
  });

  test("returns 'unconfigured' when provider is not in the catalog", async () => {
    secureKeys.set(
      credentialKey("unknown-provider", "api_key"),
      "key-doesnt-matter",
    );
    applyConfig({ provider: "unknown-provider" as string });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("unconfigured");
    if (result.status === "unconfigured") {
      expect(result.reason).toContain("unknown-provider");
      expect(result.reason).toContain("not in the provider catalog");
    }
  });

  test("returns 'missing-credentials' when provider is eligible but has no API key", async () => {
    applyConfig({ provider: "openai-whisper" });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("missing-credentials");
    if (result.status === "missing-credentials") {
      expect(result.providerId).toBe("openai-whisper");
      expect(result.credentialProvider).toBe("openai");
      expect(result.reason).toContain("openai");
    }
  });

  test("uses config-driven provider, not a hardcoded default", async () => {
    // Use a provider that IS in the catalog to verify config is read
    secureKeys.set(credentialKey("openai", "api_key"), "sk-config-test");
    applyConfig({ provider: "openai-whisper" });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("openai-whisper");
    }
  });

  test("returns 'unconfigured' for empty-string provider", async () => {
    applyConfig({ provider: "" as string });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("unconfigured");
  });

  // -------------------------------------------------------------------------
  // Google Gemini telephony capability
  // -------------------------------------------------------------------------

  test("returns 'supported' for google-gemini with batch-only telephonyMode", async () => {
    secureKeys.set(credentialKey("gemini", "api_key"), "gemini-telephony-test");
    applyConfig({ provider: "google-gemini" });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("google-gemini");
      expect(result.telephonyMode).toBe("batch-only");
    }
  });

  test("returns 'missing-credentials' for google-gemini without a gemini key", async () => {
    applyConfig({ provider: "google-gemini" });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("missing-credentials");
    if (result.status === "missing-credentials") {
      expect(result.providerId).toBe("google-gemini");
      expect(result.credentialProvider).toBe("gemini");
    }
  });

  test("answers about the telephony role, not the global provider", async () => {
    // The role's provider is the one a call dials, so preflight must judge
    // that one: a credentialed role behind an uncredentialed global would
    // otherwise be turned away from a call it can serve.
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({
      provider: "openai-whisper",
      roles: { telephony: { provider: "deepgram" } },
    });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("deepgram");
      expect(result.telephonyMode).toBe("realtime-ws");
    }
  });

  test("reports the telephony role's missing credential, not the global's", async () => {
    // The inverse: a credentialed global must not vouch for a role that
    // cannot dial, which passes preflight and then fails at the dial.
    seedProviderKeys({ openai: "oai-key" });
    applyConfig({
      provider: "openai-whisper",
      roles: { telephony: { provider: "deepgram" } },
    });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("missing-credentials");
    if (result.status === "missing-credentials") {
      expect(result.providerId).toBe("deepgram");
      expect(result.credentialProvider).toBe("deepgram");
    }
  });

  test("an unset telephony role still reads the global provider", async () => {
    seedProviderKeys({ openai: "oai-key" });
    applyConfig({
      provider: "openai-whisper",
      roles: { liveVoice: { provider: "deepgram" } },
    });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("openai-whisper");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — telephony capability alignment with provider catalog
// ---------------------------------------------------------------------------

import type { SttProviderId } from "../../../stt/types.js";
import {
  getProviderEntry,
  listProviderIds,
  supportsBoundary,
} from "../provider-catalog.js";

describe("telephony capability catalog alignment", () => {
  /**
   * These tests verify that the assumptions made by the telephony STT
   * capability resolver (resolveTelephonySttCapability) remain consistent
   * with the provider catalog entries. If a catalog entry changes its
   * telephonyMode or a new provider is added, these tests will catch
   * misalignment early.
   */

  /**
   * Providers that deliberately sit out telephony (`telephonyMode: "none"`).
   * `deepgram-flux` is a streaming-only spike, and telephony is out of its
   * scope. `cadet-flux` sits out for a concrete reason: the relay maps
   * `Finalize` onto Flux's `CloseStream`, and utterance-boundary finals are a
   * nova-3 concept. Nothing reroutes a call to another provider, so opting
   * out here means a Flux-configured assistant does not transcribe calls.
   */
  const TELEPHONY_OPT_OUT: ReadonlySet<SttProviderId> = new Set([
    "deepgram-flux",
    "cadet-flux",
  ]);

  test("deepgram catalog entry has realtime-ws telephonyMode", () => {
    const entry = getProviderEntry("deepgram");
    expect(entry).toBeDefined();
    expect(entry!.telephonyMode).toBe("realtime-ws");
  });

  test("google-gemini catalog entry has batch-only telephonyMode", () => {
    const entry = getProviderEntry("google-gemini");
    expect(entry).toBeDefined();
    expect(entry!.telephonyMode).toBe("batch-only");
  });

  test("openai-whisper catalog entry has batch-only telephonyMode", () => {
    const entry = getProviderEntry("openai-whisper");
    expect(entry).toBeDefined();
    expect(entry!.telephonyMode).toBe("batch-only");
  });

  test("deepgram uses 'deepgram' credential provider", () => {
    const entry = getProviderEntry("deepgram");
    expect(entry!.credentialProvider).toBe("deepgram");
  });

  test("google-gemini uses 'gemini' credential provider", () => {
    const entry = getProviderEntry("google-gemini");
    expect(entry!.credentialProvider).toBe("gemini");
  });

  test("openai-whisper uses 'openai' credential provider", () => {
    const entry = getProviderEntry("openai-whisper");
    expect(entry!.credentialProvider).toBe("openai");
  });

  test("every catalog provider has a non-none telephonyMode unless it opts out", () => {
    // The telephony capability resolver assumes known providers participate
    // in telephony over the media-stream transport. A provider with
    // telephonyMode: "none" is reported as unsupported, so opting out has to
    // be a deliberate, listed choice rather than an oversight.
    for (const id of listProviderIds()) {
      const entry = getProviderEntry(id);
      expect(entry).toBeDefined();
      if (TELEPHONY_OPT_OUT.has(id)) {
        expect(entry!.telephonyMode).toBe("none");
        continue;
      }
      expect(entry!.telephonyMode).not.toBe("none");
    }
  });

  test("telephony opt-out providers resolve as unsupported", async () => {
    for (const id of TELEPHONY_OPT_OUT) {
      const entry = getProviderEntry(id);
      mockCadetAvailable = false;
      seedProviderKeys({ [entry!.credentialProvider]: `test-key-${id}` });
      applyConfig({ provider: id });

      const result = await resolveTelephonySttCapability();
      expect(result.status).toBe("unsupported");
    }
  });

  // -----------------------------------------------------------------------
  // Stable provider identity
  // -----------------------------------------------------------------------

  test("provider IDs remain stable across catalog lookups", () => {
    // Guard against accidental ID mutation or aliasing bugs.
    for (const id of listProviderIds()) {
      const entry = getProviderEntry(id);
      expect(entry).toBeDefined();
      expect(entry!.id).toBe(id);
    }
  });

  test("capability resolver returns supported for all catalog providers with credentials", async () => {
    // Verify that every provider in the catalog can resolve to "supported"
    // when the correct credentials are present. This catches regressions
    // where a catalog entry is added but the credential mapping is wrong.
    const credentialMap: Record<string, string> = {
      "openai-whisper": "openai",
      deepgram: "deepgram",
      "google-gemini": "gemini",
      xai: "xai",
      // cadet's credential is the cloud connection, mocked below.
      cadet: "cadet",
    };

    for (const id of listProviderIds()) {
      if (TELEPHONY_OPT_OUT.has(id)) {
        continue;
      }
      const credKey = credentialMap[id];
      expect(credKey).toBeDefined();

      mockCadetAvailable = id === "cadet";
      seedProviderKeys(id === "cadet" ? {} : { [credKey]: `test-key-${id}` });
      applyConfig({ provider: id });

      const result = await resolveTelephonySttCapability();
      expect(result.status).toBe("supported");
      if (result.status === "supported") {
        expect(result.providerId).toBe(id);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — resolveConversationStreamingSttCapability
// ---------------------------------------------------------------------------

describe("resolveConversationStreamingSttCapability", () => {
  beforeEach(() => {
    secureKeys.clear();
    applyConfig({});
  });

  // -------------------------------------------------------------------------
  // Deepgram — realtime-ws streaming
  // -------------------------------------------------------------------------

  test("returns 'supported' with realtime-ws mode for deepgram", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-stream-key");
    applyConfig({ provider: "deepgram" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("deepgram");
      expect(result.streamingMode).toBe("realtime-ws");
    }
  });

  test("returns 'missing-credentials' for deepgram without an API key", async () => {
    applyConfig({ provider: "deepgram" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("missing-credentials");
    if (result.status === "missing-credentials") {
      expect(result.providerId).toBe("deepgram");
      expect(result.credentialProvider).toBe("deepgram");
      expect(result.reason).toContain("deepgram");
    }
  });

  // -------------------------------------------------------------------------
  // Google Gemini — realtime-ws streaming (Live API)
  // -------------------------------------------------------------------------

  test("returns 'supported' with realtime-ws mode for google-gemini", async () => {
    secureKeys.set(credentialKey("gemini", "api_key"), "gemini-stream-key");
    applyConfig({ provider: "google-gemini" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("google-gemini");
      expect(result.streamingMode).toBe("realtime-ws");
    }
  });

  test("returns 'missing-credentials' for google-gemini without a gemini key", async () => {
    applyConfig({ provider: "google-gemini" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("missing-credentials");
    if (result.status === "missing-credentials") {
      expect(result.providerId).toBe("google-gemini");
      expect(result.credentialProvider).toBe("gemini");
    }
  });

  // -------------------------------------------------------------------------
  // OpenAI Whisper — incremental-batch streaming
  // -------------------------------------------------------------------------

  test("returns 'supported' with incremental-batch mode for openai-whisper", async () => {
    secureKeys.set(credentialKey("openai", "api_key"), "sk-stream-test");
    applyConfig({ provider: "openai-whisper" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("openai-whisper");
      expect(result.streamingMode).toBe("incremental-batch");
    }
  });

  test("returns 'missing-credentials' for openai-whisper without an API key", async () => {
    applyConfig({ provider: "openai-whisper" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("missing-credentials");
    if (result.status === "missing-credentials") {
      expect(result.providerId).toBe("openai-whisper");
      expect(result.credentialProvider).toBe("openai");
      expect(result.reason).toContain("openai");
    }
  });

  // -------------------------------------------------------------------------
  // Unknown / unconfigured provider
  // -------------------------------------------------------------------------

  test("returns 'unconfigured' when provider is not in the catalog", async () => {
    secureKeys.set(
      credentialKey("unknown-provider", "api_key"),
      "key-doesnt-matter",
    );
    applyConfig({ provider: "unknown-provider" as string });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("unconfigured");
    if (result.status === "unconfigured") {
      expect(result.reason).toContain("unknown-provider");
      expect(result.reason).toContain("not in the provider catalog");
    }
  });

  test("returns 'unconfigured' for empty-string provider", async () => {
    applyConfig({ provider: "" as string });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("unconfigured");
  });

  // -------------------------------------------------------------------------
  // Config-driven behaviour
  // -------------------------------------------------------------------------

  test("uses config-driven provider, not a hardcoded default", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-config-test");
    applyConfig({ provider: "deepgram" });

    const result = await resolveConversationStreamingSttCapability();

    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.providerId).toBe("deepgram");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — resolveStreamingTranscriber (diarize preference)
// ---------------------------------------------------------------------------

describe("resolveStreamingTranscriber diarize preference", () => {
  beforeEach(() => {
    secureKeys.clear();
    applyConfig({});
    deepgramCtorCalls.length = 0;
    geminiCtorCalls.length = 0;
    whisperCtorCalls.length = 0;
    xaiCtorCalls.length = 0;
    loggerWarnings.length = 0;
  });

  test("default (no diarize option) constructs Deepgram without the diarize flag", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-key");
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveStreamingTranscriber();

    expect(transcriber).not.toBeNull();
    expect(deepgramCtorCalls).toHaveLength(1);
    const options = deepgramCtorCalls[0]!.options as Record<string, unknown>;
    expect(options).not.toHaveProperty("diarize");
  });

  test("diarize: 'off' constructs Deepgram without the diarize flag", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-key");
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveStreamingTranscriber({ diarize: "off" });

    expect(transcriber).not.toBeNull();
    expect(deepgramCtorCalls).toHaveLength(1);
    const options = deepgramCtorCalls[0]!.options as Record<string, unknown>;
    expect(options).not.toHaveProperty("diarize");
  });

  test("diarize: 'preferred' with Deepgram constructs the transcriber with diarize: true", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-key");
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveStreamingTranscriber({
      diarize: "preferred",
    });

    expect(transcriber).not.toBeNull();
    expect(deepgramCtorCalls).toHaveLength(1);
    const options = deepgramCtorCalls[0]!.options as Record<string, unknown>;
    expect(options.diarize).toBe(true);
  });

  test("diarize: 'preferred' with Gemini silently skips diarization (no error, no diarize arg)", async () => {
    secureKeys.set(credentialKey("gemini", "api_key"), "gemini-key");
    applyConfig({ provider: "google-gemini" });

    const transcriber = await resolveStreamingTranscriber({
      diarize: "preferred",
    });

    expect(transcriber).not.toBeNull();
    expect(geminiCtorCalls).toHaveLength(1);
    const options = geminiCtorCalls[0]!.options as Record<string, unknown>;
    // Gemini never receives a diarize option — the resolver silently skips.
    expect(options).not.toHaveProperty("diarize");
    // No warning is logged for the silent-skip path.
    expect(loggerWarnings).toHaveLength(0);
  });

  test("diarize: 'required' with Gemini returns null and logs a warning identifying the provider", async () => {
    secureKeys.set(credentialKey("gemini", "api_key"), "gemini-key");
    applyConfig({ provider: "google-gemini" });

    const transcriber = await resolveStreamingTranscriber({
      diarize: "required",
    });

    expect(transcriber).toBeNull();
    // No provider constructor was invoked.
    expect(geminiCtorCalls).toHaveLength(0);
    expect(deepgramCtorCalls).toHaveLength(0);
    expect(whisperCtorCalls).toHaveLength(0);
    // A warning was logged that identifies the configured provider so
    // operators can debug mis-configured diarization requirements.
    expect(loggerWarnings).toHaveLength(1);
    const warning = loggerWarnings[0]!;
    expect(warning.message).toContain("diarization");
    expect((warning.data as { providerId?: unknown }).providerId).toBe(
      "google-gemini",
    );
  });

  test("diarize: 'required' with Deepgram constructs the transcriber with diarize: true", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-key");
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveStreamingTranscriber({
      diarize: "required",
    });

    expect(transcriber).not.toBeNull();
    expect(deepgramCtorCalls).toHaveLength(1);
    const options = deepgramCtorCalls[0]!.options as Record<string, unknown>;
    expect(options.diarize).toBe(true);
    // No warning logged on the happy path.
    expect(loggerWarnings).toHaveLength(0);
  });

  test("sampleRate is still forwarded when diarize is enabled", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-key");
    applyConfig({ provider: "deepgram" });

    await resolveStreamingTranscriber({
      diarize: "preferred",
      sampleRate: 48000,
    });

    expect(deepgramCtorCalls).toHaveLength(1);
    const options = deepgramCtorCalls[0]!.options as Record<string, unknown>;
    expect(options.sampleRate).toBe(48000);
    expect(options.diarize).toBe(true);
  });

  // -------------------------------------------------------------------------
  // xAI realtime streaming
  // -------------------------------------------------------------------------

  test("resolves a non-null xai transcriber when xai is configured and credentials are available", async () => {
    secureKeys.set(credentialKey("xai", "api_key"), "xai-key");
    applyConfig({ provider: "xai" });

    const transcriber = await resolveStreamingTranscriber();

    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("xai");
    expect(transcriber!.boundaryId).toBe("daemon-streaming");
    expect(xaiCtorCalls).toHaveLength(1);
  });

  test("diarize: 'required' with xai constructs the transcriber (does not reject)", async () => {
    secureKeys.set(credentialKey("xai", "api_key"), "xai-key");
    applyConfig({ provider: "xai" });

    const transcriber = await resolveStreamingTranscriber({
      diarize: "required",
    });

    expect(transcriber).not.toBeNull();
    expect(xaiCtorCalls).toHaveLength(1);
    const options = xaiCtorCalls[0]!.options as Record<string, unknown>;
    expect(options.diarize).toBe(true);
    // No warning logged — xai supports diarization per the catalog.
    expect(loggerWarnings).toHaveLength(0);
  });

  test("returns null for xai when no credential is set", async () => {
    applyConfig({ provider: "xai" });

    const transcriber = await resolveStreamingTranscriber();

    expect(transcriber).toBeNull();
    expect(xaiCtorCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Utterance-boundary finals (telephony)
  // -------------------------------------------------------------------------

  test("utteranceBoundaryFinals with xai returns null with a warning (per-segment finals cannot be boundary-gated)", async () => {
    secureKeys.set(credentialKey("xai", "api_key"), "xai-key");
    applyConfig({ provider: "xai" });

    const transcriber = await resolveStreamingTranscriber({
      utteranceBoundaryFinals: true,
    });

    expect(transcriber).toBeNull();
    expect(xaiCtorCalls).toHaveLength(0);
    expect(loggerWarnings).toHaveLength(1);
    expect(loggerWarnings[0]!.message).toContain("falling back to batch");
    expect(
      (loggerWarnings[0]!.data as { providerId?: unknown }).providerId,
    ).toBe("xai");
  });

  test("utteranceBoundaryFinals with Deepgram forwards the gating options", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-key");
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveStreamingTranscriber({
      utteranceBoundaryFinals: true,
    });

    expect(transcriber).not.toBeNull();
    expect(deepgramCtorCalls).toHaveLength(1);
    const options = deepgramCtorCalls[0]!.options as Record<string, unknown>;
    expect(options.utteranceBoundaryFinals).toBe(true);
    expect(options.utteranceEndMs).toBe(1000);
  });

  test("utteranceBoundaryFinals with Deepgram forwards a caller-supplied utteranceEndMs", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-key");
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveStreamingTranscriber({
      utteranceBoundaryFinals: true,
      utteranceEndMs: 2500,
    });

    expect(transcriber).not.toBeNull();
    expect(deepgramCtorCalls).toHaveLength(1);
    const options = deepgramCtorCalls[0]!.options as Record<string, unknown>;
    expect(options.utteranceBoundaryFinals).toBe(true);
    expect(options.utteranceEndMs).toBe(2500);
  });

  test("utteranceEndMs without utteranceBoundaryFinals does not reach the Deepgram constructor", async () => {
    secureKeys.set(credentialKey("deepgram", "api_key"), "dg-key");
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveStreamingTranscriber({
      utteranceEndMs: 2500,
    });

    expect(transcriber).not.toBeNull();
    expect(deepgramCtorCalls).toHaveLength(1);
    const options = deepgramCtorCalls[0]!.options as Record<string, unknown>;
    expect(options).not.toHaveProperty("utteranceEndMs");
    expect(options).not.toHaveProperty("utteranceBoundaryFinals");
  });

  test("utteranceBoundaryFinals with google-gemini returns null (catalog telephonyMode is batch-only)", async () => {
    secureKeys.set(credentialKey("gemini", "api_key"), "gemini-key");
    applyConfig({ provider: "google-gemini" });

    const transcriber = await resolveStreamingTranscriber({
      utteranceBoundaryFinals: true,
    });

    expect(transcriber).toBeNull();
    expect(geminiCtorCalls).toHaveLength(0);
    expect(loggerWarnings).toHaveLength(1);
    expect(
      (loggerWarnings[0]!.data as { providerId?: unknown }).providerId,
    ).toBe("google-gemini");
  });

  test("utteranceBoundaryFinals with openai-whisper returns null with a warning (finals fire only on stop — end-of-stream, not utterance boundary)", async () => {
    secureKeys.set(credentialKey("openai", "api_key"), "openai-key");
    applyConfig({ provider: "openai-whisper" });

    const transcriber = await resolveStreamingTranscriber({
      utteranceBoundaryFinals: true,
    });

    expect(transcriber).toBeNull();
    expect(whisperCtorCalls).toHaveLength(0);
    expect(loggerWarnings).toHaveLength(1);
    expect(loggerWarnings[0]!.message).toContain("falling back to batch");
    expect(
      (loggerWarnings[0]!.data as { providerId?: unknown }).providerId,
    ).toBe("openai-whisper");
  });

  test("openai-whisper still resolves a streaming transcriber without utteranceBoundaryFinals", async () => {
    secureKeys.set(credentialKey("openai", "api_key"), "openai-key");
    applyConfig({ provider: "openai-whisper" });

    const transcriber = await resolveStreamingTranscriber();

    expect(transcriber).not.toBeNull();
    expect(whisperCtorCalls).toHaveLength(1);
  });
});

describe("cadet-flux managed resolution", () => {
  beforeEach(() => {
    mockCadetAvailable = false;
    mockTunnelConnection = {
      wsBaseUrl: "ws://gateway.test",
      httpBaseUrl: "http://gateway.test",
      mintServiceToken: () => "vk-test",
    };
    cadetFluxStreamCtorCalls.length = 0;
  });

  test("streaming resolver constructs the cloud Flux adapter over the same relay connection", async () => {
    mockCadetAvailable = true;
    applyConfig({ provider: "cadet-flux", language: "es" });

    const transcriber = await resolveStreamingTranscriber({
      sampleRate: 16000,
    });

    expect(transcriber?.providerId).toBe("cadet-flux");
    expect(cadetFluxStreamCtorCalls).toEqual([
      {
        connection: mockTunnelConnection,
        // The relay picks flux-general-en vs flux-general-multi from the
        // language, so forwarding it is the only lever over the model.
        options: { sampleRate: 16000, language: "es" },
      },
    ]);
  });

  test("an unset language reaches the relay as code-switching, not English", async () => {
    // The relay resolves an absent language to flux-general-en, so unset
    // would be a silent English pin on non-English speech.
    mockCadetAvailable = true;
    applyConfig({ provider: "cadet-flux" });

    await resolveStreamingTranscriber({ sampleRate: 16000 });

    expect(
      (cadetFluxStreamCtorCalls[0]?.options as { language?: string })?.language,
    ).toBe("multi");
  });

  test("resolves null without a cloud connection", async () => {
    // The credential is the cloud connection, not a stored API key.
    mockCadetAvailable = false;
    applyConfig({ provider: "cadet-flux" });

    expect(await resolveStreamingTranscriber({ sampleRate: 16000 })).toBeNull();
    expect(cadetFluxStreamCtorCalls).toHaveLength(0);
  });

  test("has no batch boundary, like BYOK Flux", async () => {
    mockCadetAvailable = true;
    applyConfig({ provider: "cadet-flux" });

    await expect(resolveBatchTranscriber()).rejects.toThrow(SttError);
  });

  test("refuses a language Flux has no model for, like BYOK Flux", async () => {
    // The relay rejects the dial for a language outside Flux's roster, which
    // reaches the caller as an unexplained param error. Refusing here names
    // the reason where it can be read.
    mockCadetAvailable = true;
    applyConfig({ provider: "cadet-flux", language: "ko" });

    expect(await resolveStreamingTranscriber({ sampleRate: 16000 })).toBeNull();
    expect(cadetFluxStreamCtorCalls).toHaveLength(0);
  });

  test("serves a language that is on the Flux roster", async () => {
    mockCadetAvailable = true;
    applyConfig({ provider: "cadet-flux", language: "hi" });

    const transcriber = await resolveStreamingTranscriber({
      sampleRate: 16000,
    });

    expect(transcriber?.providerId).toBe("cadet-flux");
  });
});

describe("cadet managed resolution", () => {
  beforeEach(() => {
    mockCadetAvailable = false;
    mockTunnelConnection = null;
    cadetStreamCtorCalls.length = 0;
  });

  test("the cadet provider resolves the batch transcriber when the cloud connection exists", async () => {
    mockCadetAvailable = true;
    applyConfig({ provider: "cadet" });

    const transcriber = await resolveBatchTranscriber();
    expect(transcriber?.providerId).toBe("cadet");
  });

  test("the cadet provider resolves null without a cloud connection", async () => {
    mockCadetAvailable = false;
    applyConfig({ provider: "cadet" });

    expect(await resolveBatchTranscriber()).toBeNull();
  });

  test("the cadet provider wins over a stored BYOK key", async () => {
    mockCadetAvailable = true;
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "cadet" });

    const capability = await resolveConversationStreamingSttCapability();
    expect(capability.status).toBe("supported");
    if (capability.status === "supported") {
      expect(capability.providerId).toBe("cadet");
      expect(capability.streamingMode).toBe("realtime-ws");
    }
  });

  test("streaming resolver constructs the cadet adapter with the tunnel connection and sample rate", async () => {
    mockCadetAvailable = true;
    mockTunnelConnection = {
      wsBaseUrl: "ws://gateway.test",
      httpBaseUrl: "http://gateway.test",
      mintServiceToken: () => "vk-test",
    };
    applyConfig({ provider: "cadet" });

    const transcriber = await resolveStreamingTranscriber({
      sampleRate: 24000,
    });
    expect(transcriber?.providerId).toBe("cadet");
    expect(cadetStreamCtorCalls).toEqual([
      {
        connection: mockTunnelConnection,
        // No language is configured here, so the cloud default rides along
        // with the connection plumbing this test is about.
        options: { sampleRate: 24000, language: "multi" },
      },
    ]);
  });

  test("streaming resolver returns null when the cloud connection is unavailable", async () => {
    mockCadetAvailable = false;
    mockTunnelConnection = {
      wsBaseUrl: "ws://gateway.test",
      httpBaseUrl: "http://gateway.test",
      mintServiceToken: () => "vk-test",
    };
    applyConfig({ provider: "cadet" });

    expect(await resolveStreamingTranscriber({ sampleRate: 16000 })).toBeNull();
    expect(cadetStreamCtorCalls).toHaveLength(0);
  });

  test("streaming resolver returns null when the tunnel connection is missing", async () => {
    mockCadetAvailable = true;
    mockTunnelConnection = null;
    applyConfig({ provider: "cadet" });

    expect(await resolveStreamingTranscriber({ sampleRate: 16000 })).toBeNull();
    expect(cadetStreamCtorCalls).toHaveLength(0);
  });

  test("conversation streaming capability reports missing credentials without a connection", async () => {
    mockCadetAvailable = false;
    applyConfig({ provider: "cadet" });

    const capability = await resolveConversationStreamingSttCapability();
    expect(capability.status).toBe("missing-credentials");
    if (capability.status === "missing-credentials") {
      // Connection-based gap copy: the fix is connecting the account,
      // not entering an API key.
      expect(capability.reason).toContain("cloud connect");
      expect(capability.reason).not.toContain("API key");
    }
  });
});

describe("resolveStreamingTranscriber language plumbing", () => {
  beforeEach(() => {
    mockCadetAvailable = false;
    mockTunnelConnection = null;
    deepgramCtorCalls.length = 0;
    geminiCtorCalls.length = 0;
    whisperCtorCalls.length = 0;
    xaiCtorCalls.length = 0;
    cadetStreamCtorCalls.length = 0;
  });

  test("managed sessions forward services.stt.language to the relay adapter", async () => {
    // The cloud path is why this plumbing exists: tunnel allowlists
    // `language` and pins nova-3, so "multi" reaches Deepgram's
    // code-switching mode without any platform-side change.
    mockCadetAvailable = true;
    mockTunnelConnection = {
      wsBaseUrl: "ws://gateway.test",
      httpBaseUrl: "http://gateway.test",
      mintServiceToken: () => "vk-test",
    };
    applyConfig({ provider: "cadet", language: "multi" });

    await resolveStreamingTranscriber({ sampleRate: 24000 });

    expect(cadetStreamCtorCalls).toEqual([
      {
        connection: mockTunnelConnection,
        options: { sampleRate: 24000, language: "multi" },
      },
    ]);
  });

  test("BYOK Deepgram sessions with 'multi' pin nova-3 alongside the language", async () => {
    // multi is a nova-3-only feature; the adapter default (nova-2) rejects it.
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram", language: "multi" });

    await resolveStreamingTranscriber({ sampleRate: 16000 });

    expect(deepgramCtorCalls).toHaveLength(1);
    expect(deepgramCtorCalls[0]?.options).toMatchObject({
      language: "multi",
      model: "nova-3",
    });
  });

  test("BYOK Deepgram sessions with a specific language pin nova-3 too", async () => {
    // The roster is verified against nova-3; the adapter default (nova-2)
    // supports only a subset of it, so any configured language pins nova-3.
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram", language: "hi" });

    await resolveStreamingTranscriber({ sampleRate: 16000 });

    expect(deepgramCtorCalls).toHaveLength(1);
    expect(deepgramCtorCalls[0]?.options).toMatchObject({
      language: "hi",
      model: "nova-3",
    });
  });

  test("xAI sessions never receive 'multi' (a Deepgram-specific value, not BCP-47)", async () => {
    seedProviderKeys({ xai: "xai-key" });
    applyConfig({ provider: "xai", language: "multi" });

    await resolveStreamingTranscriber({ sampleRate: 16000 });

    expect(xaiCtorCalls).toHaveLength(1);
    expect(xaiCtorCalls[0]?.options).not.toHaveProperty("language");
  });

  test("xAI sessions forward the configured language", async () => {
    seedProviderKeys({ xai: "xai-key" });
    applyConfig({ provider: "xai", language: "hi" });

    await resolveStreamingTranscriber({ sampleRate: 16000 });

    expect(xaiCtorCalls).toHaveLength(1);
    expect(xaiCtorCalls[0]?.options).toMatchObject({ language: "hi" });
  });

  test("an explicit option overrides the configured language", async () => {
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram", language: "multi" });

    await resolveStreamingTranscriber({ sampleRate: 16000, language: "hi" });

    expect(deepgramCtorCalls[0]?.options).toMatchObject({ language: "hi" });
  });

  test("no configured language falls to multilingual on BYOK Deepgram", async () => {
    // Unset is not a neutral state on Deepgram: sending no language decodes
    // as English, so an unconfigured Hindi speaker gets English-sounding
    // nonsense. The default fills that gap with code-switching, which also
    // pins nova-3 the way any explicit language does.
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram" });

    await resolveStreamingTranscriber({ sampleRate: 16000 });

    expect(deepgramCtorCalls).toHaveLength(1);
    expect(deepgramCtorCalls[0]?.options).toMatchObject({
      language: "multi",
      model: "nova-3",
    });
  });

  test("no configured language falls to multilingual on the cloud relay", async () => {
    // The relay dials Deepgram server-side, so it inherits the same English
    // default and needs the same fill-in.
    mockCadetAvailable = true;
    mockTunnelConnection = {
      wsBaseUrl: "ws://gateway.test",
      httpBaseUrl: "http://gateway.test",
      mintServiceToken: () => "vk-test",
    };
    applyConfig({ provider: "cadet" });

    await resolveStreamingTranscriber({ sampleRate: 24000 });

    expect(cadetStreamCtorCalls).toEqual([
      {
        connection: mockTunnelConnection,
        options: { sampleRate: 24000, language: "multi" },
      },
    ]);
  });

  test("an explicitly configured language still wins over the default", async () => {
    // The default only fills the unset case: someone who picked Tamil (off
    // the code-switching roster entirely) must keep it.
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram", language: "ta" });

    await resolveStreamingTranscriber({ sampleRate: 16000 });

    expect(deepgramCtorCalls[0]?.options).toMatchObject({ language: "ta" });
  });

  test("an explicit English pin is honored rather than treated as unset", async () => {
    // "en" is what the settings picker writes for a deliberate English pin,
    // so it must not collapse back into the multilingual default.
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram", language: "en" });

    await resolveStreamingTranscriber({ sampleRate: 16000 });

    expect(deepgramCtorCalls[0]?.options).toMatchObject({ language: "en" });
  });

  test("providers that detect natively keep receiving no language when unset", async () => {
    // xAI reads unset as native auto-detection, so the multilingual default
    // would replace a broader capability with a ten-language one.
    seedProviderKeys({ xai: "xai-key" });
    applyConfig({ provider: "xai" });

    await resolveStreamingTranscriber({ sampleRate: 16000 });

    expect(xaiCtorCalls).toHaveLength(1);
    expect(xaiCtorCalls[0]?.options).not.toHaveProperty("language");
  });

  test("providers that auto-detect natively never receive a language", async () => {
    // Gemini and Whisper take no language option: omitting it IS
    // auto-detection for them, unlike Deepgram.
    seedProviderKeys({
      gemini: "gem-key",
      openai: "oa-key",
    });

    applyConfig({ provider: "google-gemini", language: "multi" });
    await resolveStreamingTranscriber({ sampleRate: 16000 });

    applyConfig({ provider: "openai-whisper", language: "multi" });
    await resolveStreamingTranscriber({ sampleRate: 16000 });

    expect(geminiCtorCalls).toHaveLength(1);
    expect(whisperCtorCalls).toHaveLength(1);
    expect(geminiCtorCalls[0]?.options).not.toHaveProperty("language");
    expect(whisperCtorCalls[0]?.options).not.toHaveProperty("language");
  });

  test("batch resolution threads the configured language to the Deepgram provider", async () => {
    deepgramBatchCtorCalls.length = 0;
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram", language: "hi" });

    const transcriber = await resolveBatchTranscriber();
    await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(deepgramBatchCtorCalls).toHaveLength(1);
    expect(deepgramBatchCtorCalls[0]?.options).toMatchObject({
      language: "hi",
      model: "nova-3",
    });
  });

  test("batch resolution with 'multi' pins nova-3 on the Deepgram provider", async () => {
    deepgramBatchCtorCalls.length = 0;
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram", language: "multi" });

    const transcriber = await resolveBatchTranscriber();
    await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(deepgramBatchCtorCalls).toHaveLength(1);
    expect(deepgramBatchCtorCalls[0]?.options).toMatchObject({
      language: "multi",
      model: "nova-3",
    });
  });

  test("managed batch forwards the configured language to the cloud", async () => {
    // The cloud proxy passes it to Deepgram server-side, so a cloud
    // voice note decodes in the same language the live session does.
    cadetCloudTranscribeCalls.length = 0;
    mockCadetAvailable = true;
    applyConfig({ provider: "cadet", language: "ta" });

    const transcriber = await resolveBatchTranscriber();
    await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(cadetCloudTranscribeCalls).toHaveLength(1);
    expect(cadetCloudTranscribeCalls[0]?.language).toBe("ta");
  });

  test("managed batch falls to multilingual when no language is configured", async () => {
    // The gap this closes: cloud voice notes used to decode as English no
    // matter what the user had chosen, because nothing was forwarded.
    cadetCloudTranscribeCalls.length = 0;
    mockCadetAvailable = true;
    applyConfig({ provider: "cadet" });

    const transcriber = await resolveBatchTranscriber();
    await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(cadetCloudTranscribeCalls).toHaveLength(1);
    expect(cadetCloudTranscribeCalls[0]?.language).toBe("multi");
  });

  test("batch resolution falls to multilingual when no language is configured", async () => {
    // Dictation and voice notes ride the batch path, and they read the same
    // config the live session does. A user whose spoken language works in
    // voice mode must not find it broken in a voice note.
    deepgramBatchCtorCalls.length = 0;
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram" });

    const transcriber = await resolveBatchTranscriber();
    await transcriber!.transcribe({
      audio: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    });

    expect(deepgramBatchCtorCalls).toHaveLength(1);
    expect(deepgramBatchCtorCalls[0]?.options).toMatchObject({
      language: "multi",
      model: "nova-3",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: advertised streaming capability vs. what the factory can build
// ---------------------------------------------------------------------------

describe("streaming capability matches the streaming factory", () => {
  /**
   * The catalog's `daemon-streaming` boundary is load-bearing in three
   * places that must never disagree:
   *
   * 1. `resolveConversationStreamingSttCapability`, which preflight reports
   *    as `supported`.
   * 2. `resolveStreamingTranscriber`, which has to actually build an adapter.
   * 3. The two user-facing "streaming-capable providers" strings, which list
   *    exactly `listProviderIds().filter(id => supportsBoundary(id,
   *    "daemon-streaming"))`: `stt/stt-stream-session.ts` and
   *    `live-voice/live-voice-session.ts`.
   *
   * A provider that is advertised by (1) and (3) but resolves to `null` in
   * (2) makes preflight lie and sends the session down the provider-error
   * path, and the error message it lands on names the very provider that
   * just failed as a supported alternative. This suite is the guard: every
   * advertised provider must build.
   *
   * `deepgram-flux-realtime.js` is deliberately NOT mocked in this file, so
   * the Flux case constructs the real adapter.
   */
  const STREAMING_CREDENTIAL: Record<string, string> = {
    deepgram: "deepgram",
    "deepgram-flux": "deepgram",
    "google-gemini": "gemini",
    "openai-whisper": "openai",
    xai: "xai",
    // cadet's credential is the cloud connection, mocked below.
    cadet: "cadet",
    // Cloud Flux rides the same platform connection.
    "cadet-flux": "cadet",
  };

  /** The exact list both user-facing error strings advertise. */
  function advertisedStreamingProviders(): readonly SttProviderId[] {
    return listProviderIds().filter((id) =>
      supportsBoundary(id, "daemon-streaming"),
    );
  }

  function seedCredentialsFor(id: SttProviderId): void {
    const credential = STREAMING_CREDENTIAL[id];
    expect(credential).toBeDefined();
    // Both managed entries authenticate with the cloud connection rather
    // than a stored API key, and both dial through the same relay.
    const managed = id === "cadet" || id === "cadet-flux";
    mockCadetAvailable = managed;
    mockTunnelConnection = managed
      ? {
          wsBaseUrl: "ws://gateway.test",
          httpBaseUrl: "http://gateway.test",
          mintServiceToken: () => "vk-test",
        }
      : null;
    seedProviderKeys(managed ? {} : { [credential!]: `key-${id}` });
    applyConfig({ provider: id });
  }

  beforeEach(() => {
    mockCadetAvailable = false;
    mockTunnelConnection = null;
    loggerWarnings.length = 0;
  });

  test("the advertised list includes deepgram-flux", () => {
    // Guards the suite below against passing vacuously: if Flux dropped out of
    // the advertised list, those loops would assert nothing about it.
    expect(advertisedStreamingProviders()).toContain("deepgram-flux");
  });

  test("every advertised provider reports supported AND builds a transcriber", async () => {
    for (const id of advertisedStreamingProviders()) {
      seedCredentialsFor(id);

      const capability = await resolveConversationStreamingSttCapability();
      expect(capability.status).toBe("supported");

      const transcriber = await resolveStreamingTranscriber();
      expect(transcriber).not.toBeNull();
      expect(transcriber!.boundaryId).toBe("daemon-streaming");
    }
  });

  test("every advertised provider reports missing credentials AND builds nothing without them", async () => {
    for (const id of advertisedStreamingProviders()) {
      secureKeys.clear(); // the supported-loop above seeded these same providers
      mockCadetAvailable = false;
      mockTunnelConnection = null;
      applyConfig({ provider: id });

      const capability = await resolveConversationStreamingSttCapability();
      expect(capability.status).toBe("missing-credentials");
      expect(await resolveStreamingTranscriber()).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: deepgram-flux streaming resolution
// ---------------------------------------------------------------------------

describe("deepgram-flux streaming resolution", () => {
  beforeEach(() => {
    mockCadetAvailable = false;
    mockTunnelConnection = null;
    loggerWarnings.length = 0;
  });

  test("resolves a real Flux transcriber on the shared Deepgram key", async () => {
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram-flux" });

    const transcriber = await resolveStreamingTranscriber({
      sampleRate: 16_000,
    });

    expect(transcriber).not.toBeNull();
    expect(transcriber!.providerId).toBe("deepgram-flux");
    expect(transcriber!.boundaryId).toBe("daemon-streaming");
    // Flux owns turn boundaries, so callers feature-detecting this method
    // must fall back to stop().
    expect(transcriber!.finalizeUtterance).toBeUndefined();
  });

  test("resolves from an explicit providerId, the way live voice asks", async () => {
    // Live voice derives its provider itself and passes it in rather than
    // letting the resolver re-read config.
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "openai-whisper" });

    const transcriber = await resolveStreamingTranscriber({
      providerId: "deepgram-flux",
    });

    expect(transcriber?.providerId).toBe("deepgram-flux");
  });

  test("resolves null without a Deepgram key", async () => {
    seedProviderKeys({ openai: "sk-key" });
    applyConfig({ provider: "deepgram-flux" });

    expect(await resolveStreamingTranscriber()).toBeNull();
  });

  test("telephony callers resolve to null without a Flux-specific conditional", async () => {
    // The catalog's telephonyMode: "none" is the only gate. Boundary-
    // requiring callers fall back to per-turn batch transcription.
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram-flux" });

    const transcriber = await resolveStreamingTranscriber({
      utteranceBoundaryFinals: true,
    });

    expect(transcriber).toBeNull();
    expect(loggerWarnings).toHaveLength(1);
    expect(
      (loggerWarnings[0]!.data as { providerId?: unknown }).providerId,
    ).toBe("deepgram-flux");
  });

  test("telephony capability reports Flux as unsupported", async () => {
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram-flux" });

    const result = await resolveTelephonySttCapability();

    expect(result.status).toBe("unsupported");
  });

  test("diarize: 'required' rejects Flux rather than silently dropping labels", async () => {
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram-flux" });

    const transcriber = await resolveStreamingTranscriber({
      diarize: "required",
    });

    expect(transcriber).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: batch resolution against a streaming-only provider
// ---------------------------------------------------------------------------

describe("deepgram-flux batch resolution", () => {
  beforeEach(() => {
    mockCadetAvailable = false;
    mockTunnelConnection = null;
    loggerWarnings.length = 0;
  });

  /**
   * Every batch caller pairs a `null` resolve with "no speech-to-text
   * provider is configured". Flux is configured, and the operator who set it
   * needs to be told which of the two Deepgram entries batch runs on, so the
   * resolver raises a typed error instead of returning that `null`.
   */
  test("throws a named error rather than resolving null", async () => {
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram-flux" });

    await expect(resolveBatchTranscriber()).rejects.toThrow(
      'Deepgram Flux is streaming-only. Batch transcription requires the deepgram provider: set services.stt.provider to "deepgram".',
    );
  });

  test("marks the error user-facing so friendly copy does not overwrite it", async () => {
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram-flux" });

    const err = await resolveBatchTranscriber().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).category).toBe("provider-error");
    expect((err as SttError).userFacing).toBe(true);
  });

  test("logs the gap so a degrading caller still leaves a daemon-side trace", async () => {
    seedProviderKeys({ deepgram: "dg-key" });
    applyConfig({ provider: "deepgram-flux" });

    await resolveBatchTranscriber().catch(() => undefined);

    expect(loggerWarnings).toHaveLength(1);
    expect(
      (loggerWarnings[0]!.data as { providerId?: unknown }).providerId,
    ).toBe("deepgram-flux");
  });

  test("a provider that is absent from the catalog still resolves null", async () => {
    // "Unknown provider" is a different situation from "known provider,
    // wrong boundary", and only the latter has a fix worth naming.
    applyConfig({ provider: "not-a-provider" });

    expect(await resolveBatchTranscriber()).toBeNull();
  });
});

describe("sttCredentialGapReason", () => {
  test("cadet gets connection copy; API-key providers keep key copy", () => {
    expect(sttCredentialGapReason("cadet")).toContain("cloud connect");
    expect(sttCredentialGapReason("cadet")).not.toContain("API key");
    expect(sttCredentialGapReason("deepgram")).toContain("API key");
  });
});

describe("effectiveSttLanguage", () => {
  test("fills the unset case only where unset would mean English", () => {
    // Deepgram and the cloud relay decode language-less audio as English,
    // so leaving them unset is a silent pin rather than a neutral state.
    expect(effectiveSttLanguage("deepgram", undefined)).toBe("multi");
    expect(effectiveSttLanguage("cadet", undefined)).toBe("multi");
    // Everyone else detects natively from the audio; filling in a ten-language
    // roster would narrow what they can already do.
    expect(effectiveSttLanguage("xai", undefined)).toBeUndefined();
    expect(effectiveSttLanguage("google-gemini", undefined)).toBeUndefined();
    expect(effectiveSttLanguage("openai-whisper", undefined)).toBeUndefined();
  });

  test("a configured language always wins, including English", () => {
    // The default decides what happens when nobody has chosen, nothing more.
    expect(effectiveSttLanguage("deepgram", "ta")).toBe("ta");
    expect(effectiveSttLanguage("deepgram", "en")).toBe("en");
    expect(effectiveSttLanguage("cadet", "multi")).toBe("multi");
    expect(effectiveSttLanguage("xai", "hi")).toBe("hi");
  });
});

describe("the multilingual default reaches configs with no stt block", () => {
  test("a config that omits services.stt entirely still resolves multilingual", () => {
    // The services-level default supplies the stt block for a fresh
    // workspace. Handing that default a literal would short-circuit the
    // inner parse and leave `language` undefined, so the block is parsed
    // through its own schema and the field default materializes.
    setConfig("services", {});
    expect(getConfig().services.stt.language).toBe("multi");
  });

  test("a config that omits only the language gets it filled", () => {
    setConfig("services", { stt: { provider: "deepgram", providers: {} } });
    expect(getConfig().services.stt.language).toBe("multi");
  });

  test("an explicit language is never overwritten by the default", () => {
    setConfig("services", {
      stt: { provider: "deepgram", language: "ta", providers: {} },
    });
    expect(getConfig().services.stt.language).toBe("ta");
  });
});

// ---------------------------------------------------------------------------
// Tests: per-consumer role selection
// ---------------------------------------------------------------------------

describe("services.stt.roles selection", () => {
  beforeEach(() => {
    mockCadetAvailable = false;
    mockTunnelConnection = null;
    seedProviderKeys({ deepgram: "dg-key", openai: "oai-key" });
    deepgramCtorCalls.length = 0;
    whisperCtorCalls.length = 0;
  });

  test("a role override wins over the global provider", async () => {
    applyConfig({
      provider: "openai-whisper",
      roles: { dictation: { provider: "deepgram" } },
    });

    const transcriber = await resolveStreamingTranscriber({
      role: "dictation",
      sampleRate: 16000,
    });

    expect(transcriber?.providerId).toBe("deepgram");
    expect(whisperCtorCalls).toHaveLength(0);
  });

  test("a role with no override falls back to the global provider", async () => {
    // The invariant that keeps an install with no role set on one provider.
    applyConfig({
      provider: "openai-whisper",
      roles: { dictation: { provider: "deepgram" } },
    });

    const transcriber = await resolveStreamingTranscriber({
      role: "liveVoice",
      sampleRate: 16000,
    });

    expect(transcriber?.providerId).toBe("openai-whisper");
  });

  test("a roleless caller still reads the global provider", async () => {
    applyConfig({
      provider: "openai-whisper",
      roles: { dictation: { provider: "deepgram" } },
    });

    const transcriber = await resolveStreamingTranscriber({
      sampleRate: 16000,
    });

    expect(transcriber?.providerId).toBe("openai-whisper");
  });

  test("an explicit providerId beats the role, since that caller already resolved", async () => {
    applyConfig({
      provider: "openai-whisper",
      roles: { liveVoice: { provider: "openai-whisper" } },
    });

    const transcriber = await resolveStreamingTranscriber({
      role: "liveVoice",
      providerId: "deepgram",
      sampleRate: 16000,
    });

    expect(transcriber?.providerId).toBe("deepgram");
  });

  test("the batch resolver honours its own role", async () => {
    applyConfig({
      provider: "openai-whisper",
      roles: { batch: { provider: "deepgram" } },
    });

    const transcriber = await resolveBatchTranscriber({ role: "batch" });

    expect(transcriber?.providerId).toBe("deepgram");
  });

  test("a role selects a model family the global default does not use", async () => {
    // The case the split exists for: live voice on the streaming-only family
    // while file transcription keeps the one that can batch.
    applyConfig({
      provider: "deepgram",
      roles: { liveVoice: { provider: "deepgram", model: "flux" } },
    });

    const live = await resolveStreamingTranscriber({
      role: "liveVoice",
      sampleRate: 16000,
    });
    const batch = await resolveBatchTranscriber({ role: "batch" });

    expect(live?.providerId).toBe("deepgram-flux");
    expect(batch?.providerId).toBe("deepgram");
  });

  test("the watch session resolves its own role", async () => {
    applyConfig({
      provider: "openai-whisper",
      roles: { watch: { provider: "deepgram" } },
    });

    const transcriber = await resolveStreamingTranscriber({
      role: "watch",
      sampleRate: 16000,
    });

    expect(transcriber?.providerId).toBe("deepgram");
    expect(whisperCtorCalls).toHaveLength(0);
  });

  test("roles route two consumers to different providers at once", async () => {
    // The failure this whole change exists to prevent: one global forcing
    // every consumer onto a provider that only suits one of them.
    applyConfig({
      provider: "openai-whisper",
      roles: {
        dictation: { provider: "deepgram" },
        batch: { provider: "openai-whisper" },
      },
    });

    const dictation = await resolveStreamingTranscriber({
      role: "dictation",
      sampleRate: 16000,
    });
    const batch = await resolveBatchTranscriber({ role: "batch" });

    expect(dictation?.providerId).toBe("deepgram");
    expect(batch?.providerId).toBe("openai-whisper");
  });
});
