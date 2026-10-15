import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

/**
 * The config GET response at schema defaults — generated from
 * `AssistantConfigSchema.pick({ conversations, notifications, llm, memory,
 * services }).parse({})`, the response contract the spec documents for
 * `GET /v1/config`, so a schema-default change regenerates this fixture
 * instead of drifting by hand.
 */
const MATERIALIZED_DEFAULTS: ConfigGetResponse = {
  conversations: {
    autoArchive: {
      enabled: false,
      afterDays: 7,
    },
    skipAutoRetitling: false,
    backgroundInjection:
      "This is a background turn — your guardian isn't watching. If anything noteworthy comes up, send them a notification so they see it when they're back by invoking the `notifications` skill (`assistant notifications send --message \"...\"`)",
    resumeProcessingOnStartup: false,
  },
  notifications: {
    newMessageEnabled: true,
  },
  llm: {
    profiles: {},
    profileOrder: [],
    callSites: {},
    profileSession: {
      defaultTtlSeconds: 1800,
      maxTtlSeconds: 43200,
    },
    pricingOverrides: [],
  },
  memory: {
    enabled: true,
    embeddings: {
      required: true,
      provider: "auto",
      localModel: "Xenova/bge-small-en-v1.5",
      openaiModel: "text-embedding-3-small",
      geminiModel: "gemini-embedding-2",
      ollamaModel: "nomic-embed-text",
      customModel: "text-embedding-3-small",
    },
    qdrant: {
      url: "http://127.0.0.1:6333",
      collection: "memory",
      vectorSize: 384,
      onDisk: true,
      quantization: "scalar",
    },
    retrieval: {
      maxInjectTokens: 16000,
      freshness: {
        enabled: true,
        maxAgeDays: {
          identity: 0,
          preference: 0,
          project: 30,
          decision: 30,
          constraint: 90,
          event: 30,
        },
        staleDecay: 0.5,
        reinforcementShieldDays: 7,
      },
      scopePolicy: "allow_global_fallback",
      dynamicBudget: {
        enabled: true,
        minInjectTokens: 2400,
        maxInjectTokens: 16000,
        targetHeadroomTokens: 10000,
      },
      injection: {
        contextLoad: {
          maxNodes: 25,
          serendipitySlots: 5,
          capabilityReserve: 5,
        },
        perTurn: {
          maxNodes: 6,
          serendipitySlots: 1,
          capabilityReserve: 2,
        },
      },
      scratchpadInjection: {
        enabled: true,
      },
    },
    segmentation: {
      targetTokens: 450,
      overlapTokens: 60,
    },
    jobs: {
      workerConcurrency: 2,
      stalledJobTimeoutMs: 1800000,
      slowLlmConcurrency: 1,
      fastConcurrency: 2,
      embedConcurrency: 2,
    },
    retention: {
      keepRawForever: true,
    },
    cleanup: {
      enabled: true,
      supersededItemRetentionMs: 2592000000,
      conversationRetentionDays: 0,
      llmRequestLogRetentionMs: 3600000,
    },
    maintenance: {
      intervalMs: 86400000,
      quietPeriodMs: 10800000,
      skillPruneDays: null,
    },
    extraction: {
      useLLM: true,
      extractFromAssistant: true,
      batchSize: 10,
      idleTimeoutMs: 300000,
    },
    summarization: {
      useLLM: true,
    },
    substrate: {},
    v2: {
      enabled: true,
      sweep_enabled: false,
      d: 0.3,
      c_user: 0.3,
      c_assistant: 0.2,
      c_now: 0.2,
      k: 0.5,
      hops: 2,
      top_k: 25,
      ann_candidate_limit: null,
      epsilon: 0.01,
      dense_weight: 0.85,
      sparse_weight: 0.15,
      bm25_k1: 1.2,
      bm25_b: 0.4,
      consolidation_interval_hours: 8,
      consolidation_max_buffer_lines: 100,
      consolidation_max_entries_per_run: 150,
      max_page_chars: 5000,
      consolidation_prompt_path: null,
      rerank: {
        enabled: false,
        top_k: 50,
        alpha: 0.3,
        model: "Alibaba-NLP/gte-reranker-modernbert-base",
        dtype: "q8",
      },
      router: {
        enabled: true,
        max_page_ids: 25,
        router_prompt_path: null,
        batch_size: null,
        tier1_size: null,
        tier2_size: null,
        historical_pairs: 1,
        historical_pairs_max_chars: null,
      },
    },
    v3: {
      live: false,
      prune: {
        maxResidentBytes: 393216,
        targetResidentBytes: 262144,
      },
      hotSet: {
        k: 40,
        halfLifeDays: 14,
      },
      freshSet: {
        k: 100,
      },
      learnedEdges: {
        halfLifeDays: 30,
        minCount: 3,
        npmiFloor: 0.2,
        maxPerPage: 6,
        perSeed: 3,
        cap: 20,
      },
      needleK: 100,
      denseK: 100,
      replyQueryK: 12,
      spanQueryK: 0,
      finderSectionsPerPage: 3,
      selectorEnabled: true,
      selectorPromptPath: null,
      edge: {
        hubDegree: 30,
        seedCount: 18,
        perSeed: 6,
        cap: 45,
      },
      entity: {
        enabled: true,
        idfFloor: 4,
        cap: 8,
      },
      rareTerm: {
        enabled: true,
        maxDf: 12,
        maxDfFraction: 0.002,
        perTerm: 2,
        cap: 24,
      },
      gate: {
        enabled: true,
        denseThreshold: 0.66,
        sparseThreshold: 0.35,
        sparseOnlyThreshold: 0.75,
        denseClusterThreshold: 0.6,
        denseClusterMaxDelta: 0.02,
        topK: 5,
        bm25NormK: null,
        bypassForCore: false,
      },
      poolLog: {
        captureInput: false,
      },
    },
    retrospective: {
      enabled: true,
      skillImprovement: true,
      skillImprovementMonitoring: false,
      timeThresholdMs: 1800000,
      messageThreshold: 10,
      minCooldownMs: 300000,
      requireUserActivity: true,
      sweepIntervalMs: 28800000,
      sweepLookbackMs: 604800000,
      keepSupersededRuns: false,
      matchConversationProfile: false,
      promptPath: null,
    },
  },
  services: {
    inference: {},
    "image-generation": {
      provider: "gemini",
      model: "gemini-3.1-flash-image-preview",
    },
    "web-search": {
      provider: "inference-provider-native",
    },
    "web-fetch": {
      provider: "default",
    },
    stt: {
      provider: "deepgram",
      language: "multi",
      providers: {},
      roles: {},
    },
    tts: {
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          voiceId: "ZF6FPAbjXT4488VcRRnw",
          voiceModelId: "",
          speed: 1,
          stability: 0.5,
          similarityBoost: 0.75,
          conversationTimeoutSeconds: 30,
        },
        "fish-audio": {
          referenceId: "",
          chunkLength: 200,
          format: "mp3",
          latency: "normal",
          speed: 1,
        },
        deepgram: {
          model: "aura-asteria-en",
          format: "mp3",
        },
        xai: {
          voiceId: "eve",
          language: "auto",
          format: "mp3",
          sampleRate: 24000,
          bitRate: 128000,
        },
      },
    },
    "google-oauth": {
      mode: "managed",
    },
    "outlook-oauth": {
      mode: "your-own",
    },
    "linear-oauth": {
      mode: "your-own",
    },
    "github-oauth": {
      mode: "your-own",
    },
    "notion-oauth": {
      mode: "managed",
    },
    "twitter-oauth": {
      mode: "your-own",
    },
    "asana-oauth": {
      mode: "your-own",
    },
    "todoist-oauth": {
      mode: "your-own",
    },
    "discord-oauth": {
      mode: "your-own",
    },
    "hubspot-oauth": {
      mode: "your-own",
    },
    "monday-oauth": {
      mode: "your-own",
    },
    "shopify-oauth": {
      mode: "your-own",
    },
    "stripe-link-oauth": {
      mode: "your-own",
    },
    "figma-oauth": {
      mode: "your-own",
    },
    "quickbooks-oauth": {
      mode: "your-own",
    },
    "eventbrite-oauth": {
      mode: "your-own",
    },
    "calendly-oauth": {
      mode: "your-own",
    },
  },
};

/**
 * A fully materialized config GET response, with per-section overrides for
 * whatever the test or story actually exercises.
 */
export function makeConfigFixture(
  over: Partial<ConfigGetResponse> = {},
): ConfigGetResponse {
  return { ...structuredClone(MATERIALIZED_DEFAULTS), ...over };
}
