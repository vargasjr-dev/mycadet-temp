const LOCALE_KEY = "device:locale";

// Retain the existing device preference so login keeps the selected language.
export function readLocalePreference(): string {
  try {
    return localStorage.getItem(LOCALE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeLocalePreference(locale: string): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale);
    window.dispatchEvent(
      new CustomEvent("cadet:pref-changed", {
        detail: { key: LOCALE_KEY, value: locale },
      }),
    );
  } catch {
    // Language changes must still work when browser storage is unavailable.
  }
}
