/** Account-consent migrations only; assistant migration policy lives in web. */
export function migrateKey(oldKey: string, newKey: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const value = localStorage.getItem(oldKey);
    if (value === null) {
      return;
    }
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, value);
    }
    if (localStorage.getItem(newKey) !== null) {
      localStorage.removeItem(oldKey);
    }
  } catch {
    // Storage unavailable — migration retries on next load.
  }
}

export function runStorageMigrations(): void {
  migrateKey("onboarding.tosAccepted", "cadet:onboarding:tosAccepted");
  migrateKey("onboarding.aiDataConsent", "cadet:onboarding:aiDataConsent");
}
