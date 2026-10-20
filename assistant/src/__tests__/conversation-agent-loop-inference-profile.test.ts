/**
 * Verifies that `runAgentLoopImpl` reads the conversation row's
 * `inferenceProfile` column at turn start and threads it through to
 * `AgentLoop.run()` as the per-turn `overrideProfile`. Background
 * conversations intentionally skip the column so background fan-out
 * (subagents, scheduled tasks) runs on the workspace
 * defaults rather than inheriting an interactive override.
 *
 * This is the "conversation-agent-loop integration" half of the
 * inference-profiles plumbing — the resolver/provider/agent-loop layers are
 * exercised separately by their own tests.
 *
 * Zero-leak: the REAL `resolveOverrideProfile` (pure over the conversation
 * fields, which the ctx stub carries) drives every profile read, including
 * the mid-turn re-resolution between model calls. The turn runs against a
 * REAL conversation row — messages, usage, request logs, and the disk view
 * all persist to the per-process test DB — and the only fake is the ctx
 * object itself (the loop's own parameter, not a module mock).
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentLoopRunOptions } from "../agent/loop.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import { setConfig } from "./helpers/set-config.js";

// Seed the workspace config for real: a named profile the tests pin as the
// per-conversation override (complete shape — override-or-default semantics
// skip profiles that don't carry their own provider+model) plus a short
// turn-boundary commit wait so loop teardown stays fast.
setConfig("llm", {
  profiles: {
    "quality-optimized": {
      source: "user",
      provider: "anthropic",
      model: "claude-opus-4-8",
      contextWindow: { maxInputTokens: 50000 },
    },
  },
});
setConfig("workspaceGit", { turnCommitMaxWaitMs: 10 });
// No second-pass retitling keeps the real title write out of the loop teardown.
setConfig("conversations", { skipAutoRetitling: true });

import type { Conversation } from "../daemon/conversation.js";
import { runAgentLoopImpl } from "../daemon/conversation-agent-loop.js";
import type { QueueDrainReason } from "../daemon/conversation-queue-manager.js";
import {
  ensureConversationExists,
  setConversationInferenceProfile,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
import { asConversation } from "./helpers/mock-conversation.js";

beforeAll(async () => {
  await initializeDb();
});

// The loop reads conversation rows by id; the makeCtx stub pins this one id
// so the real crud paths (usage, request logs, disk view) always find it.
const TEST_CONV_ID = "test-conv";

// ── Test helpers ─────────────────────────────────────────────────────

/** Captures the options the orchestrator passes to `agentLoop.run`. */
interface CapturedAgentLoopRun {
  callSite: LLMCallSite | undefined;
  overrideProfile: string | undefined;
  forceOverrideProfile: boolean | undefined;
  resolvedOverrideProfile: string | undefined;
  resolvedMaxInputTokens: number | undefined;
}

let mutateBeforeResolveOverrideProfile: (() => void) | undefined;

function makeCtx(
  captured: CapturedAgentLoopRun[],
  overrides?: Partial<Conversation>,
): Conversation {
  const agentLoopRun = async (
    options: AgentLoopRunOptions,
  ): Promise<Message[]> => {
    mutateBeforeResolveOverrideProfile?.();
    captured.push({
      callSite: options.callSite,
      overrideProfile: options.overrideProfile,
      forceOverrideProfile: options.forceOverrideProfile,
      resolvedOverrideProfile: options.resolveOverrideProfile?.(),
      resolvedMaxInputTokens: options.resolveContextWindow?.().maxInputTokens,
    });
    return [
      ...options.messages,
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "response" }],
      },
    ];
  };

  return asConversation({
    conversationId: TEST_CONV_ID,
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ] as Message[],
    processing: true,
    isProcessing(this: { processing: boolean }) {
      return this.processing;
    },
    setProcessing(this: { processing: boolean }, value: boolean) {
      this.processing = value;
    },
    abortController: new AbortController(),
    currentRequestId: "test-req",

    agentLoop: {
      run: agentLoopRun,
      getToolTokenBudget: () => 0,
      getResolvedTools: () => [] as ToolDefinition[],
      getActiveModel: () => undefined,
      compactionCircuit: new CompactionCircuit("test-conv"),
    } as unknown as Conversation["agentLoop"],
    provider: {
      name: "mock-provider",
      sendMessage: async () => ({
        content: [{ type: "text", text: "title" }],
        model: "mock",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      }),
    } as unknown as Conversation["provider"],
    systemPrompt: "system prompt",

    contextWindowManager: {
      updateConfig: () => {},
      shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
      maybeCompact: async () => ({ compacted: false }),
      resetOverflowRecovery: () => {},
      reduceOverflowOneRung: async (msgs: Message[]) => ({
        messages: msgs,
        tier: "forced_compaction",
        state: {
          appliedTiers: ["forced_compaction"],
          injectionMode: "full",
          exhausted: true,
        },
        estimatedTokens: 1000,
      }),
    } as unknown as Conversation["contextWindowManager"],
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,

    currentActiveSurfaceId: undefined,
    currentPage: undefined,
    surfaceState: new Map(),
    pendingSurfaceActions: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],

    workingDir: "/tmp",
    channelCapabilities: undefined,
    commandIntent: undefined,
    trustContext: undefined,

    allowedToolNames: undefined,
    preactivatedSkillIds: undefined,
    skillProjectionState: new Map(),
    skillProjectionCache:
      new Map() as unknown as Conversation["skillProjectionCache"],

    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    turnCount: 0,

    lastAssistantAttachments: [],
    lastAttachmentWarnings: [],

    hasNoClient: false,
    prompter: {} as unknown as Conversation["prompter"],
    queue: {} as unknown as Conversation["queue"],

    getWorkspaceGitService: () => ({ ensureInitialized: async () => {} }),
    commitTurnChanges: async () => {},

    markWorkspaceTopLevelDirty: () => {},
    emitActivityState: () => {},
    getQueueDepth: () => 0,
    hasQueuedMessages: () => false,
    drainQueue: async (_reason?: QueueDrainReason) => {},
    // Forwards to drainQueue so tests that spy the drain observe the agent
    // loop's post-turn kick through the guarded entry point.
    kickDrainQueue(
      this: { drainQueue: (reason?: QueueDrainReason) => Promise<void> },
      reason: QueueDrainReason = "loop_complete",
      _origin?: string,
    ) {
      return this.drainQueue(reason);
    },
    getTurnInterfaceContext: () => null,
    getTurnChannelContext: () => ({
      userMessageChannel: "cadet" as const,
      assistantMessageChannel: "cadet" as const,
    }),

    buildCurrentSystemPrompt: () => "system prompt",
    syncLoopSystemPrompt: () => {},
    modelOverride: undefined,

    graphMemory: {
      onCompacted: async () => {},
      prepareMemory: async () => ({
        runMessages: [],
        injectedTokens: 0,
        latencyMs: 0,
        mode: "none" as const,
      }),
      reinjectCachedMemory: (messages: Message[]) => ({
        runMessages: messages,
        injectedTokens: 0,
      }),
      retrackCachedNodes: () => {},
      recordPkbQueryVectors: () => {},
    } as unknown as Conversation["graphMemory"],

    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  // Real rows persist across tests in this file — reset the profile pin so
  // each test starts from a standard, profile-less conversation.
  ensureConversationExists(TEST_CONV_ID, "cadet");
  setConversationInferenceProfile(TEST_CONV_ID, null);
  mutateBeforeResolveOverrideProfile = undefined;
  resetPluginRegistryAndRegisterDefaults();
});

describe("runAgentLoopImpl — per-conversation inferenceProfile", () => {
  test("non-background conversation with inferenceProfile threads it through as overrideProfile", async () => {
    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured, {
      conversationType: "standard",
      inferenceProfile: "quality-optimized",
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.overrideProfile).toBe("quality-optimized");
    }
  });

  test("background conversation ignores inferenceProfile", async () => {
    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured, {
      conversationType: "background",
      inferenceProfile: "quality-optimized",
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.overrideProfile).toBeUndefined();
    }
  });

  test("absence of inferenceProfile behaves identically to today (no override)", async () => {
    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured, { conversationType: "standard" });

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.overrideProfile).toBeUndefined();
    }
  });

  test("explicit options.overrideProfile takes precedence over the conversation override", async () => {
    // Subagent path: SubagentManager forwards the parent's pinned profile
    // into the spawned (background) conversation's runAgentLoop call via
    // `options.overrideProfile`. The agent loop must respect that even
    // though the subagent's own conversation is `background` (which
    // would otherwise zero out the override per the rule above).
    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured, {
      conversationType: "background",
      inferenceProfile: null,
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {}, {
      overrideProfile: "fast",
    });

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.overrideProfile).toBe("fast");
      expect(call.forceOverrideProfile).toBeUndefined();
    }
  });

  test("explicit options.forceOverrideProfile is passed to AgentLoop.run", async () => {
    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured, {
      conversationType: "background",
      inferenceProfile: null,
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {}, {
      overrideProfile: "fast",
      forceOverrideProfile: true,
    });

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.overrideProfile).toBe("fast");
      expect(call.forceOverrideProfile).toBe(true);
    }
  });

  test("re-resolves inferenceProfile when a tool changes it mid-turn", async () => {
    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured, {
      conversationType: "standard",
      inferenceProfile: null,
    });
    mutateBeforeResolveOverrideProfile = () => {
      ctx.inferenceProfile = "quality-optimized";
    };

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].overrideProfile).toBeUndefined();
    expect(captured[0].resolvedOverrideProfile).toBe("quality-optimized");
    expect(captured[0].resolvedMaxInputTokens).toBe(50000);
    expect(ctx.currentTurnOverrideProfile).toBeUndefined();
  });
});

describe("runAgentLoopImpl — subagent call site default", () => {
  test("a subagent conversation defaults to the subagentSpawn call site", async () => {
    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured, { isSubagent: true });

    // No explicit callSite (mirrors the generic queue-drain path) — a subagent
    // turn must still resolve as subagentSpawn, not mainAgent.
    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.callSite).toBe("subagentSpawn");
    }
  });

  test("a non-subagent conversation defaults to the mainAgent call site", async () => {
    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured, { isSubagent: false });

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.callSite).toBe("mainAgent");
    }
  });
});
