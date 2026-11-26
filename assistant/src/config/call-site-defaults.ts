import { type LLMCallSite } from "./schemas/llm.js";

// Per-call-site tuning merged onto whatever profile the resolution chain
// picks. No call site ships a profile: unpinned sites resolve
// overrideProfile → llm.callSites pin → llm.activeProfile → the default
// provider's balanced profile.
type CallSiteDefaultConfig = {
  maxTokens?: number;
  effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  temperature?: number | null;
  thinking?: { enabled?: boolean; streamThinking?: boolean };
  contextWindow?: { maxInputTokens?: number };
  // Opt the site out of prompt caching (one-shot prompts, ~0-5% cache hits).
  disableCache?: boolean;
};

export const CALL_SITE_DEFAULTS: Partial<
  Record<LLMCallSite, CallSiteDefaultConfig>
> = {
  memoryConsolidation: { disableCache: true },
  memoryRouter: { contextWindow: { maxInputTokens: 1000000 } },
  memoryV3SelectL2: {
    temperature: 0,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
  },
  recall: {
    maxTokens: 4096,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    temperature: 0,
    disableCache: true,
  },
  conversationTitle: { disableCache: true },
  commitMessage: {
    maxTokens: 120,
    temperature: 0.2,
    effort: "low",
    thinking: { enabled: false },
  },
  replySuggestion: {
    effort: "low",
    thinking: { enabled: false },
    disableCache: true,
  },
  guardianQuestionCopy: { effort: "low", thinking: { enabled: false } },
  notificationDecision: { effort: "low", thinking: { enabled: false } },
  preferenceExtraction: { effort: "low", thinking: { enabled: false } },
  interactionClassifier: { effort: "low", thinking: { enabled: false } },
  voiceProgressNarration: { effort: "low", thinking: { enabled: false } },
  voiceFrontDoor: { effort: "low", thinking: { enabled: false } },
  voiceContinuationLabel: {
    effort: "low",
    thinking: { enabled: false },
    disableCache: true,
  },
  inviteInstructionGenerator: { effort: "low", thinking: { enabled: false } },
  skillCategoryInference: { effort: "low", thinking: { enabled: false } },
  homeGreeting: {
    maxTokens: 60,
    effort: "low",
    thinking: { enabled: false },
    temperature: 0.7,
    disableCache: true,
  },
  homeSuggestedPrompts: {
    maxTokens: 512,
    effort: "low",
    thinking: { enabled: false },
    disableCache: true,
  },
  workflowLeaf: { effort: "low", thinking: { enabled: false } },
};
