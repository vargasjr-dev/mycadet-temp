import { afterEach, expect, test } from "bun:test";
import { runStorageMigrations } from "@app/utils/storage-migration";
afterEach(() => localStorage.clear());

test("account startup migrates consent without touching assistant settings", () => {
  localStorage.setItem("onboarding.tosAccepted", "true");
  localStorage.setItem("onboarding.aiDataConsent", "false");
  localStorage.setItem("voice:ttsProvider", "legacy");
  localStorage.setItem("local:selectedAssistantId", "assistant-1");
  runStorageMigrations();
  expect(localStorage.getItem("cadet:onboarding:tosAccepted")).toBe("true");
  expect(localStorage.getItem("cadet:onboarding:aiDataConsent")).toBe("false");
  expect(localStorage.getItem("onboarding.tosAccepted")).toBeNull();
  expect(localStorage.getItem("voice:ttsProvider")).toBe("legacy");
  expect(localStorage.getItem("local:selectedAssistantId")).toBe("assistant-1");
});

test("account migrations preserve newer consent and are idempotent", () => {
  localStorage.setItem("onboarding.tosAccepted", "false");
  localStorage.setItem("cadet:onboarding:tosAccepted", "true");
  runStorageMigrations();
  runStorageMigrations();
  expect(localStorage.getItem("cadet:onboarding:tosAccepted")).toBe("true");
  expect(localStorage.getItem("onboarding.tosAccepted")).toBeNull();
});
