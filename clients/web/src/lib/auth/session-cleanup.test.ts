import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  __clearNotificationIdentitySnapshotsForTests,
  beginNotificationIdentityPublication,
  createNotificationIdentity,
  getNotificationIdentitySnapshot,
  publishPreparedNotificationIdentity,
} from "@/runtime/notification-avatar";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useConversationStore } from "@/stores/conversation-store";
import type { EventStream } from "@/lib/streaming/stream-transport";

import { clearUserScopedStorage } from "./session-cleanup";

beforeEach(() => {
  __clearNotificationIdentitySnapshotsForTests();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  __clearNotificationIdentitySnapshotsForTests();
  localStorage.clear();
  sessionStorage.clear();
});

describe("clearUserScopedStorage", () => {
  test("clears process-local notification identity memory", () => {
    const identity = createNotificationIdentity(
      '["account","user-123","org-abc"]',
      "assistant-1",
      "00000000-0000-4000-8000-000000000001",
    )!;
    const publication = beginNotificationIdentityPublication(identity);
    publishPreparedNotificationIdentity(publication, {
      name: "Assistant One",
      nameProvenance: "identity-store",
    });
    expect(getNotificationIdentitySnapshot(identity)).not.toBeNull();

    clearUserScopedStorage();

    expect(getNotificationIdentitySnapshot(identity)).toBeNull();
  });

  test("clears sessionStorage entirely", () => {
    sessionStorage.setItem("cadet:edit-chat:asst-1:app-1", "conv-xyz");
    sessionStorage.setItem("arbitrary-session-key", "data");

    clearUserScopedStorage();

    expect(sessionStorage.length).toBe(0);
  });

  test("clears in-memory chat state before the same route identity is reused", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useChatSessionStore.setState({
      previousAssistantId: "assistant-1",
      previousConversationId: "conv-1",
      snapshot: {
        messages: [
          {
            id: "message-1",
            role: "assistant",
            textSegments: ["Private transcript"],
            contentOrder: [{ type: "text", id: "0" }],
            contentBlocks: [{ type: "text", text: "Private transcript" }],
          },
        ],
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
        seq: 1,
      },
      optimisticSends: [
        {
          id: "message-2",
          role: "user",
          textSegments: ["Private pending message"],
          contentOrder: [{ type: "text", id: "0" }],
          contentBlocks: [{ type: "text", text: "Private pending message" }],
        },
      ],
    });
    useConversationStore
      .getState()
      .setPendingDraftProfile("conv-1", "profile-1");
    useConversationStore
      .getState()
      .setPendingDraftPlugins("conv-1", new Set(["plugin-1"]));
    useComposerStore.getState().loadAssistantDrafts("assistant-1");
    useComposerStore.getState().setInput("Private draft");
    useComposerStore.getState().saveDraft("conv-1", "Private persisted draft");
    useComposerStore.getState().addPathReferences(["/private/path"]);
    useTurnStore.getState().requestSend("turn-1");
    useInteractionStore
      .getState()
      .showAcpConnect({ toolUseId: "tool-1", conversationId: "conv-1" });
    const cancelStream = mock(() => {});
    const streamEpoch = useStreamStore.getState().streamEpoch;
    useStreamStore.setState({
      stream: { cancel: cancelStream } as EventStream,
      streamContext: {
        assistantId: "assistant-1",
        conversationId: "conv-1",
      },
    });

    clearUserScopedStorage();

    expect(useChatSessionStore.getState().previousAssistantId).toBeNull();
    expect(useChatSessionStore.getState().previousConversationId).toBeNull();
    expect(cancelStream).toHaveBeenCalledTimes(1);
    expect(useStreamStore.getState().stream).toBeNull();
    expect(useStreamStore.getState().streamContext).toBeNull();
    expect(useStreamStore.getState().streamEpoch).toBe(streamEpoch + 1);
    useChatSessionStore.getState().switchToConversation({
      assistantId: "assistant-1",
      activeConversationId: "conv-1",
    });

    expect(useConversationStore.getState().activeConversationId).toBeNull();
    expect(useChatSessionStore.getState().snapshot).toBeNull();
    expect(useChatSessionStore.getState().optimisticSends).toEqual([]);
    expect(useChatSessionStore.getState().previousAssistantId).toBe(
      "assistant-1",
    );
    expect(useChatSessionStore.getState().previousConversationId).toBe(
      "conv-1",
    );
    expect(useComposerStore.getState().input).toBe("");
    expect(useComposerStore.getState().restoredDraftConversationId).toBeNull();
    expect(useComposerStore.getState().attachments).toEqual([]);
    useComposerStore.getState().loadAssistantDrafts("assistant-1");
    useComposerStore.getState().restoreDraftIfEmpty("conv-1");
    expect(useComposerStore.getState().input).toBe("");
    expect(localStorage.getItem("cadet:chatDrafts:assistant-1")).toBeNull();
    expect(useTurnStore.getState().phase).toBe("idle");
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
    expect(useConversationStore.getState().pendingDraftProfiles.size).toBe(0);
    expect(useConversationStore.getState().pendingDraftPlugins.size).toBe(0);
  });

  test("removes all cadet: prefixed keys from localStorage", () => {
    localStorage.setItem("cadet:pinnedApps", "[]");
    localStorage.setItem("cadet:lastViewedConversation:asst-1", "conv-1");
    localStorage.setItem("cadet:sidebar-open-categories:asst-1", "{}");
    localStorage.setItem("cadet:sidebar-open-custom-groups:asst-1", "{}");
    localStorage.setItem("cadet:selectedAssistantId", "asst-1");
    localStorage.setItem("cadet:nudge-prefs", "{}");
    localStorage.setItem("cadet:chatDrafts:asst-1", '{"text":"hi"}');
    localStorage.setItem("cadet:ctxwindow:asst-1", "4096");
    localStorage.setItem("cadet:dismissed-surfaces:asst-1", "[]");
    localStorage.setItem("cadet:ff:some-flag", "true");
    localStorage.setItem("cadet:onboarding:tosAccepted", "true");
    localStorage.setItem("cadet:onboarding:aiDataConsent", "true");
    localStorage.setItem("cadet:onboarding:completed", "true");
    localStorage.setItem("cadet:onboarding:selectedVersion", "v1.0");
    localStorage.setItem("cadet:integrations:bannerDismissed", "true");
    localStorage.setItem("cadet:voice:activationKey", "Space");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying cleanup of user-scoped storage keys
    localStorage.setItem("cadet:voice:ttsApiKey:openai", "test-value");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying cleanup of user-scoped storage keys
    localStorage.setItem("cadet:voice:sttApiKey:openai", "test-value");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying cleanup of user-scoped storage keys
    localStorage.setItem("cadet:gw:token", "jwt-token");
    localStorage.setItem("cadet:local:lockfile", "{}");
    localStorage.setItem("cadet:ai:imageGenMode", "enabled");
    localStorage.setItem("cadet:debug:impersonateAssistantVersion", "0.8.6");
    localStorage.setItem("cadet:sidebar:collapsed", "true");
    localStorage.setItem("cadet:sidebar:width", "300");
    localStorage.setItem("cadet:diskPressureDismissed:asst-1", "true");
    localStorage.setItem("cadet:skills:tipDismissed", "true");

    clearUserScopedStorage();

    expect(localStorage.length).toBe(0);
  });

  test("preserves device: prefixed keys", () => {
    localStorage.setItem("device:theme", "dark");
    localStorage.setItem("device:share_analytics", "true");
    localStorage.setItem("device:share_diagnostics", "false");
    localStorage.setItem("device:biometric_enabled", "false");
    localStorage.setItem("device:llm_log_retention", "dontRetain");
    localStorage.setItem("device:timezone", "America/New_York");
    localStorage.setItem("device:media_embeds_enabled", "false");
    localStorage.setItem("device:media_embed_domains", '["youtube.com"]');
    localStorage.setItem("device:last_user_id", "user-123");

    clearUserScopedStorage();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("device:share_analytics")).toBe("true");
    expect(localStorage.getItem("device:share_diagnostics")).toBe("false");
    expect(localStorage.getItem("device:biometric_enabled")).toBe("false");
    expect(localStorage.getItem("device:llm_log_retention")).toBe("dontRetain");
    expect(localStorage.getItem("device:timezone")).toBe("America/New_York");
    expect(localStorage.getItem("device:media_embeds_enabled")).toBe("false");
    expect(localStorage.getItem("device:media_embed_domains")).toBe(
      '["youtube.com"]',
    );
    expect(localStorage.getItem("device:last_user_id")).toBe("user-123");
  });

  test("automatically clears future cadet: keys without needing explicit registration", () => {
    localStorage.setItem("cadet:some-future-feature:asst-1", "data");
    localStorage.setItem("cadet:another-feature", "value");

    clearUserScopedStorage();

    expect(localStorage.length).toBe(0);
  });

  test("future device: keys are automatically preserved", () => {
    localStorage.setItem("device:some_new_setting", "value");
    localStorage.setItem("device:another_setting", "data");

    clearUserScopedStorage();

    expect(localStorage.getItem("device:some_new_setting")).toBe("value");
    expect(localStorage.getItem("device:another_setting")).toBe("data");
  });

  test("leaves third-party keys untouched", () => {
    localStorage.setItem("_ga", "GA1.2.123456");
    localStorage.setItem("intercom-session", "abc");
    localStorage.setItem("some-other-sdk", "data");

    clearUserScopedStorage();

    expect(localStorage.getItem("_ga")).toBe("GA1.2.123456");
    expect(localStorage.getItem("intercom-session")).toBe("abc");
    expect(localStorage.getItem("some-other-sdk")).toBe("data");
  });

  test("removes cadet: keys while preserving device: and third-party keys", () => {
    localStorage.setItem("device:theme", "dark");
    localStorage.setItem("device:share_analytics", "true");
    localStorage.setItem("cadet:pinnedApps", "[]");
    localStorage.setItem("cadet:ff:my-flag", "true");
    localStorage.setItem("cadet:onboarding:completed", "true");
    localStorage.setItem("_ga", "GA1.2.123456");

    clearUserScopedStorage();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("device:share_analytics")).toBe("true");
    expect(localStorage.getItem("_ga")).toBe("GA1.2.123456");
    expect(localStorage.getItem("cadet:pinnedApps")).toBeNull();
    expect(localStorage.getItem("cadet:ff:my-flag")).toBeNull();
    expect(localStorage.getItem("cadet:onboarding:completed")).toBeNull();
  });

  test("preserves active app. nudge keys on logout", () => {
    localStorage.setItem("app.iosNudge.downloaded", "true");
    localStorage.setItem("app.macOsNudge.bannerDismissed", "true");
    localStorage.setItem("app.githubNudge.starred", "true");

    clearUserScopedStorage();

    // Active native/macOS nudge keys must survive logout because the nudge
    // modules still read them.
    // Dead github/discord keys are removed at startup by removeKey()
    // in storage-migration.ts, not by the logout sweep.
    expect(localStorage.getItem("app.iosNudge.downloaded")).toBe("true");
    expect(localStorage.getItem("app.macOsNudge.bannerDismissed")).toBe("true");
    expect(localStorage.getItem("app.githubNudge.starred")).toBe("true");
  });

  test("clears legacy prefixed keys if startup migration failed", () => {
    // eslint-disable-next-line no-restricted-syntax -- test: verifying cleanup of legacy auth token
    localStorage.setItem("gw:token", "legacy-jwt-token");
    // generic-examples:ignore-next-line — reason: epoch timestamp for token expiry, not a phone number
    localStorage.setItem("gw:expiresAt", "9999999999");
    localStorage.setItem("voice:ttsProvider", "elevenlabs");
    localStorage.setItem("onboarding.completed", "true");
    localStorage.setItem("ff:client:darkMode", "true");
    localStorage.setItem("local:lockfile", "{}");
    localStorage.setItem("integrations.bannerDismissed", "true");
    localStorage.setItem(
      "cadetDebug.flags.impersonateAssistantVersion",
      "0.8.6",
    );
    localStorage.setItem("cadet_image_gen_mode", "enabled");

    clearUserScopedStorage();

    expect(localStorage.getItem("gw:token")).toBeNull();
    expect(localStorage.getItem("gw:expiresAt")).toBeNull();
    expect(localStorage.getItem("voice:ttsProvider")).toBeNull();
    expect(localStorage.getItem("onboarding.completed")).toBeNull();
    expect(localStorage.getItem("ff:client:darkMode")).toBeNull();
    expect(localStorage.getItem("local:lockfile")).toBeNull();
    expect(localStorage.getItem("integrations.bannerDismissed")).toBeNull();
    expect(
      localStorage.getItem("cadetDebug.flags.impersonateAssistantVersion"),
    ).toBeNull();
    expect(localStorage.getItem("cadet_image_gen_mode")).toBeNull();
  });

  test("preserves legacy device-level keys from cleanup", () => {
    localStorage.setItem("cadet_theme", "dark");
    localStorage.setItem("cadet_share_analytics", "true");
    localStorage.setItem("cadet_share_diagnostics", "false");
    localStorage.setItem("cadet_biometric_enabled", "false");
    localStorage.setItem("cadet_llm_log_retention", "dontRetain");
    localStorage.setItem("cadet_timezone", "America/New_York");
    localStorage.setItem("cadet_media_embeds_enabled", "false");
    localStorage.setItem("cadet_media_embed_domains", '["youtube.com"]');
    localStorage.setItem("onboarding.lastUserId", "user-123");

    clearUserScopedStorage();

    expect(localStorage.getItem("cadet_theme")).toBe("dark");
    expect(localStorage.getItem("cadet_share_analytics")).toBe("true");
    expect(localStorage.getItem("cadet_share_diagnostics")).toBe("false");
    expect(localStorage.getItem("cadet_biometric_enabled")).toBe("false");
    expect(localStorage.getItem("cadet_llm_log_retention")).toBe("dontRetain");
    expect(localStorage.getItem("cadet_timezone")).toBe("America/New_York");
    expect(localStorage.getItem("cadet_media_embeds_enabled")).toBe("false");
    expect(localStorage.getItem("cadet_media_embed_domains")).toBe(
      '["youtube.com"]',
    );
    expect(localStorage.getItem("onboarding.lastUserId")).toBe("user-123");
  });
});
