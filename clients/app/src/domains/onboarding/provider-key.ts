import type { OnboardingProviderId } from "@app/domains/onboarding/provider-catalog";

// Model-provider API key collected during onboarding. Held in sessionStorage
// (consume-once) between the API-key step and the post-hatch application, then
// written to the freshly hatched assistant. Mirrors the macOS flow, which
// holds the key in-memory and POSTs it to the daemon once the assistant is up.
//
// The storage half of web's `provider-key.ts` — same key, same origin, so a
// key staged here is consumed by the hatching screen (still web-side) through
// the shell's same-origin sessionStorage. The consume-and-apply half (the
// daemon SDK writes) stays web-side.

const PENDING_KEY_STORAGE = "onboarding.providerKey";

export interface PendingProviderKey {
  provider: OnboardingProviderId;
  /** Empty for keyless providers (e.g. Ollama). */
  key: string;
  /** Selected model for the initial local assistant profile. */
  model?: string;
  /** Base URL for openai-compatible providers. */
  baseUrl?: string;
  /** Comma-separated model identifiers for openai-compatible providers. */
  customModels?: string;
}

export function setPendingProviderKey(value: PendingProviderKey | null): void {
  try {
    if (value === null) {
      sessionStorage.removeItem(PENDING_KEY_STORAGE);
      return;
    }
    sessionStorage.setItem(PENDING_KEY_STORAGE, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode / quota) — degrade silently.
  }
}

function isPendingProviderKey(value: unknown): value is PendingProviderKey {
  return (
    value !== null &&
    typeof value === "object" &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "key" in value &&
    typeof value.key === "string" &&
    (!("model" in value) || typeof value.model === "string") &&
    (!("baseUrl" in value) || typeof value.baseUrl === "string") &&
    (!("customModels" in value) || typeof value.customModels === "string")
  );
}

export function peekPendingProviderKey(): PendingProviderKey | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY_STORAGE);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isPendingProviderKey(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function consumePendingProviderKey(): PendingProviderKey | null {
  const value = peekPendingProviderKey();
  try {
    sessionStorage.removeItem(PENDING_KEY_STORAGE);
  } catch {
    // ignore
  }
  return value;
}
