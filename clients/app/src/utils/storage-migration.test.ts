import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  migrateKey,
  migratePrefix,
  migrateValue,
  removeKey,
  removePersistedPairedGatewayCredential,
  runStorageMigrations,
} from "./storage-migration";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("removeKey", () => {
  test("removes an existing key", () => {
    localStorage.setItem("old:key", "value");

    removeKey("old:key");

    expect(localStorage.getItem("old:key")).toBeNull();
  });

  test("no-op when key is absent", () => {
    removeKey("missing");

    expect(localStorage.getItem("missing")).toBeNull();
  });
});

describe("migrateValue", () => {
  test("converts matching old value to new value", () => {
    localStorage.setItem("key", "1");

    migrateValue("key", "1", "true");

    expect(localStorage.getItem("key")).toBe("true");
  });

  test("no-op when current value does not match old value", () => {
    localStorage.setItem("key", "true");

    migrateValue("key", "1", "true");

    expect(localStorage.getItem("key")).toBe("true");
  });

  test("no-op when key is absent", () => {
    migrateValue("missing", "1", "true");

    expect(localStorage.getItem("missing")).toBeNull();
  });
});

describe("migrateKey", () => {
  test("renames old key to new key", () => {
    localStorage.setItem("old:key", "value");

    migrateKey("old:key", "new:key");

    expect(localStorage.getItem("new:key")).toBe("value");
    expect(localStorage.getItem("old:key")).toBeNull();
  });

  test("no-op when old key is absent", () => {
    migrateKey("missing", "new:key");

    expect(localStorage.getItem("new:key")).toBeNull();
  });

  test("preserves existing new key (idempotent)", () => {
    localStorage.setItem("old:key", "stale");
    localStorage.setItem("new:key", "fresh");

    migrateKey("old:key", "new:key");

    expect(localStorage.getItem("new:key")).toBe("fresh");
    expect(localStorage.getItem("old:key")).toBeNull();
  });

  test("idempotent when called twice", () => {
    localStorage.setItem("old:key", "value");

    migrateKey("old:key", "new:key");
    migrateKey("old:key", "new:key");

    expect(localStorage.getItem("new:key")).toBe("value");
    expect(localStorage.getItem("old:key")).toBeNull();
  });
});

describe("migratePrefix", () => {
  test("renames all keys matching the old prefix", () => {
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of storage keys
    localStorage.setItem("voice:ttsApiKey:openai", "sk-123");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of storage keys
    localStorage.setItem("voice:ttsApiKey:elevenlabs", "el-456");
    localStorage.setItem("voice:sttProvider", "whisper");

    migratePrefix("voice:ttsApiKey:", "cadet:voice:ttsApiKey:");

    expect(localStorage.getItem("cadet:voice:ttsApiKey:openai")).toBe("sk-123");
    expect(localStorage.getItem("cadet:voice:ttsApiKey:elevenlabs")).toBe(
      "el-456",
    );
    expect(localStorage.getItem("voice:ttsApiKey:openai")).toBeNull();
    expect(localStorage.getItem("voice:ttsApiKey:elevenlabs")).toBeNull();
    // Unrelated key untouched
    expect(localStorage.getItem("voice:sttProvider")).toBe("whisper");
  });

  test("no-op when no keys match", () => {
    localStorage.setItem("other:key", "value");

    migratePrefix("voice:", "cadet:voice:");

    expect(localStorage.getItem("other:key")).toBe("value");
    expect(localStorage.length).toBe(1);
  });

  test("preserves existing new keys (idempotent)", () => {
    localStorage.setItem("ff:client:flag-a", "old");
    localStorage.setItem("cadet:ff:flag-a", "already-migrated");

    migratePrefix("ff:client:", "cadet:ff:");

    expect(localStorage.getItem("cadet:ff:flag-a")).toBe("already-migrated");
    expect(localStorage.getItem("ff:client:flag-a")).toBeNull();
  });
});

describe("removePersistedPairedGatewayCredential", () => {
  test("removes a paired guardian bearer and its metadata", () => {
    // eslint-disable-next-line no-restricted-syntax -- test: seeding a legacy paired credential to verify removal
    localStorage.setItem("cadet:gw:token", "guardian-token");
    // generic-examples:ignore-next-line — reason: real test fixture seeding a legacy storage key to verify cleanup behavior
    localStorage.setItem("cadet:gw:expiresAt", "2000000000");
    // eslint-disable-next-line no-restricted-syntax -- test: seeding legacy paired credential metadata to verify removal
    localStorage.setItem(
      "cadet:gw:tokenSource",
      "/assistant/__gateway-paired/paired-a/auth/token",
    );

    removePersistedPairedGatewayCredential();

    expect(localStorage.getItem("cadet:gw:token")).toBeNull();
    expect(localStorage.getItem("cadet:gw:expiresAt")).toBeNull();
    expect(localStorage.getItem("cadet:gw:tokenSource")).toBeNull();
  });

  test("preserves a locally minted gateway actor token", () => {
    // eslint-disable-next-line no-restricted-syntax -- test: seeding a legacy local actor token to verify preservation
    localStorage.setItem("cadet:gw:token", "local-actor-token");
    // generic-examples:ignore-next-line — reason: real test fixture seeding a legacy storage key to verify preservation
    localStorage.setItem("cadet:gw:expiresAt", "2000000000");
    // eslint-disable-next-line no-restricted-syntax -- test: seeding legacy local actor metadata to verify preservation
    localStorage.setItem(
      "cadet:gw:tokenSource",
      "/assistant/__gateway/20100/auth/token",
    );

    removePersistedPairedGatewayCredential();

    expect(localStorage.getItem("cadet:gw:token")).toBe("local-actor-token");
  });
});

describe("runStorageMigrations", () => {
  test("removes proactive tips state", () => {
    localStorage.setItem("device:tips:records", '{"quick-input":{}}');
    localStorage.setItem("device:tips:enabled", "false");
    localStorage.setItem("device:tips:first_seen_at", "1700000000000");
    localStorage.setItem("cadet:ff-str:proactiveTips", "on");

    runStorageMigrations();

    expect(localStorage.getItem("device:tips:records")).toBeNull();
    expect(localStorage.getItem("device:tips:enabled")).toBeNull();
    expect(localStorage.getItem("device:tips:first_seen_at")).toBeNull();
    expect(localStorage.getItem("cadet:ff-str:proactiveTips")).toBeNull();
  });

  test("migrates sidebar keys", () => {
    localStorage.setItem("assistantSidebarCollapsed", "true");
    localStorage.setItem("assistantSidebarWidth", "300");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:sidebar:collapsed")).toBe("true");
    expect(localStorage.getItem("cadet:sidebar:width")).toBe("300");
    expect(localStorage.getItem("assistantSidebarCollapsed")).toBeNull();
    expect(localStorage.getItem("assistantSidebarWidth")).toBeNull();
  });

  test("migrates voice: keys", () => {
    localStorage.setItem("voice:permissionPrimerSeen", "true");
    localStorage.setItem("voice:ttsProvider", "openai");
    localStorage.setItem("voice:sttProvider", "whisper");
    localStorage.setItem("voice:activationKey", "Space");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of API key storage keys
    localStorage.setItem("voice:ttsApiKey:openai", "sk-123");
    localStorage.setItem("voice:ttsVoiceId:openai", "alloy");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of API key storage keys
    localStorage.setItem("voice:sttApiKey:deepgram", "dg-456");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:voice:permissionPrimerSeen")).toBe(
      "true",
    );
    expect(localStorage.getItem("cadet:voice:ttsProvider")).toBe("openai");
    expect(localStorage.getItem("cadet:voice:sttProvider")).toBe("whisper");
    expect(localStorage.getItem("cadet:voice:activationKey")).toBe("Space");
    expect(localStorage.getItem("cadet:voice:ttsApiKey:openai")).toBe("sk-123");
    expect(localStorage.getItem("cadet:voice:ttsVoiceId:openai")).toBe("alloy");
    expect(localStorage.getItem("cadet:voice:sttApiKey:deepgram")).toBe(
      "dg-456",
    );
    // Old keys removed
    expect(localStorage.getItem("voice:permissionPrimerSeen")).toBeNull();
    expect(localStorage.getItem("voice:ttsApiKey:openai")).toBeNull();
  });

  test("migrates onboarding. keys", () => {
    localStorage.setItem("onboarding.tosAccepted", "true");
    localStorage.setItem("onboarding.aiDataConsent", "true");
    localStorage.setItem("onboarding.completed", "true");
    localStorage.setItem("onboarding.selectedVersion", "v1.0");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:onboarding:tosAccepted")).toBe("true");
    expect(localStorage.getItem("cadet:onboarding:aiDataConsent")).toBe("true");
    // completed key is removed (no longer used), not migrated
    expect(localStorage.getItem("onboarding.completed")).toBeNull();
    expect(localStorage.getItem("cadet:onboarding:completed")).toBeNull();
    expect(localStorage.getItem("cadet:onboarding:selectedVersion")).toBe(
      "v1.0",
    );
    expect(localStorage.getItem("onboarding.tosAccepted")).toBeNull();
  });

  test("migrates cadet_ AI settings keys", () => {
    localStorage.setItem("cadet_image_gen_mode", "enabled");
    localStorage.setItem("cadet_web_search_provider", "perplexity");
    localStorage.setItem("cadet_gemini_key", "gk-789");
    localStorage.setItem("cadet_perplexity_key", "pplx-abc");
    localStorage.setItem("cadet_brave_key", "BSA-def");
    localStorage.setItem("cadet_tavily_key", "tvly-ghi");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:ai:imageGenMode")).toBe("enabled");
    expect(localStorage.getItem("cadet:ai:webSearchProvider")).toBe(
      "perplexity",
    );
    expect(localStorage.getItem("cadet:ai:geminiKey")).toBe("gk-789");
    expect(localStorage.getItem("cadet:ai:perplexityKey")).toBe("pplx-abc");
    expect(localStorage.getItem("cadet:ai:braveKey")).toBe("BSA-def");
    expect(localStorage.getItem("cadet:ai:tavilyKey")).toBe("tvly-ghi");
    expect(localStorage.getItem("cadet_image_gen_mode")).toBeNull();
  });

  test("migrates ff:client: prefix", () => {
    localStorage.setItem("ff:client:my-flag", "true");
    localStorage.setItem("ff:client:another-flag", "false");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:ff:my-flag")).toBe("true");
    expect(localStorage.getItem("cadet:ff:another-flag")).toBe("false");
    expect(localStorage.getItem("ff:client:my-flag")).toBeNull();
  });

  test("carries the watch flag override onto the teach key", () => {
    localStorage.setItem("cadet:ff:watch", "true");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:ff:teach")).toBe("true");
    expect(localStorage.getItem("cadet:ff:watch")).toBeNull();
  });

  test("carries an off override too, rather than dropping it", () => {
    localStorage.setItem("cadet:ff:watch", "false");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:ff:teach")).toBe("false");
  });

  test("leaves an existing teach override alone", () => {
    localStorage.setItem("cadet:ff:watch", "false");
    localStorage.setItem("cadet:ff:teach", "true");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:ff:teach")).toBe("true");
    expect(localStorage.getItem("cadet:ff:watch")).toBeNull();
  });

  test("migrates gw: and local: keys", () => {
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of gateway token keys
    localStorage.setItem("gw:token", "jwt-abc");
    // generic-examples:ignore-next-line — reason: epoch timestamp, not a phone number
    localStorage.setItem("gw:expiresAt", "1700000000");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of gateway token keys
    localStorage.setItem("gw:tokenSource", "/auth/token");
    localStorage.setItem("local:lockfile", "{}");
    localStorage.setItem("local:selectedAssistantId", "asst-1");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:gw:token")).toBe("jwt-abc");
    // generic-examples:ignore-next-line — reason: epoch timestamp, not a phone number
    expect(localStorage.getItem("cadet:gw:expiresAt")).toBe("1700000000");
    expect(localStorage.getItem("cadet:gw:tokenSource")).toBe("/auth/token");
    expect(localStorage.getItem("cadet:local:lockfile")).toBe("{}");
    // local:selectedAssistantId is canonicalized then collapsed into the single
    // cadet:selectedAssistantId, so the intermediate key no longer survives.
    expect(localStorage.getItem("cadet:selectedAssistantId")).toBe("asst-1");
    expect(localStorage.getItem("cadet:local:selectedAssistantId")).toBeNull();
    expect(localStorage.getItem("gw:token")).toBeNull();
    expect(localStorage.getItem("local:lockfile")).toBeNull();
  });

  test("migrates disk-pressure-warning prefix", () => {
    localStorage.setItem("disk-pressure-warning-dismissed-asst-1", "true");
    localStorage.setItem("disk-pressure-warning-dismissed-asst-2", "true");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:diskPressureDismissed:asst-1")).toBe(
      "true",
    );
    expect(localStorage.getItem("cadet:diskPressureDismissed:asst-2")).toBe(
      "true",
    );
    expect(
      localStorage.getItem("disk-pressure-warning-dismissed-asst-1"),
    ).toBeNull();
  });

  test("collapses the legacy per-org assistant map into one key", () => {
    // Canonicalized first (cadet_current_assistant_id__ → cadet:currentAssistantId:),
    // then collapsed into the single cadet:selectedAssistantId. With no current
    // org at migration time, the lexicographically-smallest org suffix wins.
    localStorage.setItem("cadet_current_assistant_id__org-2", "asst-b");
    localStorage.setItem("cadet_current_assistant_id__org-1", "asst-a");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:selectedAssistantId")).toBe("asst-a");
    expect(localStorage.getItem("cadet:currentAssistantId:org-1")).toBeNull();
    expect(localStorage.getItem("cadet:currentAssistantId:org-2")).toBeNull();
    expect(
      localStorage.getItem("cadet_current_assistant_id__org-1"),
    ).toBeNull();
  });

  test("collapse prefers the persisted active org's per-org selection", () => {
    // Active org is org-2 even though org-1 sorts first; the active org's pick
    // must win so a multi-org user keeps their current selection on upgrade.
    sessionStorage.setItem("cadet_active_organization_id", "org-2");
    localStorage.setItem("cadet:currentAssistantId:org-1", "asst-1");
    localStorage.setItem("cadet:currentAssistantId:org-2", "asst-2");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:selectedAssistantId")).toBe("asst-2");
    expect(localStorage.getItem("cadet:currentAssistantId:org-1")).toBeNull();
    expect(localStorage.getItem("cadet:currentAssistantId:org-2")).toBeNull();
  });

  test("collapse prefers the tab-local key and is idempotent", () => {
    localStorage.setItem("cadet:local:selectedAssistantId", "tab-local");
    localStorage.setItem("cadet:currentAssistantId:org-1", "per-org");

    runStorageMigrations();
    expect(localStorage.getItem("cadet:selectedAssistantId")).toBe("tab-local");
    expect(localStorage.getItem("cadet:local:selectedAssistantId")).toBeNull();
    expect(localStorage.getItem("cadet:currentAssistantId:org-1")).toBeNull();

    // Re-running leaves the collapsed value untouched and removes nothing new.
    runStorageMigrations();
    expect(localStorage.getItem("cadet:selectedAssistantId")).toBe("tab-local");
  });

  test("migrates cadetDebug key", () => {
    localStorage.setItem(
      "cadetDebug.flags.impersonateAssistantVersion",
      "0.8.6",
    );

    runStorageMigrations();

    expect(
      localStorage.getItem("cadet:debug:impersonateAssistantVersion"),
    ).toBe("0.8.6");
    expect(
      localStorage.getItem("cadetDebug.flags.impersonateAssistantVersion"),
    ).toBeNull();
  });

  test("migrates skillsTabTipDismissed to new name", () => {
    localStorage.setItem("cadet:skillsTabTipDismissed", "true");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:skills:tipDismissed")).toBe("true");
    expect(localStorage.getItem("cadet:skillsTabTipDismissed")).toBeNull();
  });

  test("converts skills tip value from '1' to 'true'", () => {
    localStorage.setItem("cadet:skills:tipDismissed", "1");

    runStorageMigrations();

    expect(localStorage.getItem("cadet:skills:tipDismissed")).toBe("true");
  });

  test("does not touch unrelated device: keys", () => {
    localStorage.setItem("device:theme", "dark");
    localStorage.setItem("device:timezone", "UTC");

    runStorageMigrations();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("device:timezone")).toBe("UTC");
  });

  test("does not touch third-party keys", () => {
    localStorage.setItem("_ga", "GA1.2.123456");
    localStorage.setItem("intercom-session", "abc");

    runStorageMigrations();

    expect(localStorage.getItem("_ga")).toBe("GA1.2.123456");
    expect(localStorage.getItem("intercom-session")).toBe("abc");
  });

  test("removes legacy nudge keys and their cleanup flag", () => {
    localStorage.setItem("app.githubNudge.starred", "true");
    localStorage.setItem("app.discordNudge.joined", "true");
    localStorage.setItem("app.nudgeLegacy.cleaned", "true");

    runStorageMigrations();

    expect(localStorage.getItem("app.githubNudge.starred")).toBeNull();
    expect(localStorage.getItem("app.discordNudge.joined")).toBeNull();
    expect(localStorage.getItem("app.nudgeLegacy.cleaned")).toBeNull();
  });

  test("full migration is idempotent", () => {
    localStorage.setItem("assistantSidebarCollapsed", "true");
    localStorage.setItem("voice:ttsProvider", "openai");
    localStorage.setItem("onboarding.tosAccepted", "true");
    localStorage.setItem("ff:client:flag", "true");

    runStorageMigrations();
    const snapshot1 = { ...localStorage };

    runStorageMigrations();
    const snapshot2 = { ...localStorage };

    expect(snapshot1).toEqual(snapshot2);
  });
  test("converts a legacy imageGenMode into the equivalent provider", () => {
    localStorage.setItem("cadet:ai:imageGenMode", "managed");
    runStorageMigrations();
    expect(localStorage.getItem("cadet:ai:imageGenProvider")).toBe("cadet");

    localStorage.clear();
    localStorage.setItem("cadet:ai:imageGenMode", "your-own");
    runStorageMigrations();
    expect(localStorage.getItem("cadet:ai:imageGenProvider")).toBe("gemini");
  });

  test("a stored imageGenProvider wins over the legacy mode", () => {
    localStorage.setItem("cadet:ai:imageGenMode", "managed");
    localStorage.setItem("cadet:ai:imageGenProvider", "gemini");
    runStorageMigrations();
    expect(localStorage.getItem("cadet:ai:imageGenProvider")).toBe("gemini");
  });

  test("continues when image provider storage is unavailable", () => {
    const originalGetItem = localStorage.getItem;
    Object.defineProperty(localStorage, "getItem", {
      value(key: string) {
        if (key === "cadet:ai:imageGenProvider") {
          throw new DOMException("Storage unavailable", "SecurityError");
        }
        return originalGetItem.call(localStorage, key);
      },
      configurable: true,
    });

    try {
      expect(() => runStorageMigrations()).not.toThrow();
    } finally {
      Object.defineProperty(localStorage, "getItem", {
        value: originalGetItem,
        configurable: true,
      });
    }
  });
});
