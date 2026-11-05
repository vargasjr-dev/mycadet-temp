import { getDeviceSetting, setDeviceSetting } from "@/utils/device-settings";

export type ThemePreference = "system" | "light" | "dark";

function normalizeThemePreference(
  value: string | null | undefined,
): ThemePreference {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return "system";
}

export function readStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }
  const raw = getDeviceSetting("theme", "");
  return normalizeThemePreference(raw || null);
}

export function writeStoredThemePreference(theme: ThemePreference): void {
  setDeviceSetting("theme", theme);
}

export function applyThemePreference(theme: ThemePreference): void {
  if (typeof document === "undefined") {
    return;
  }

  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const shouldBeDark = theme === "dark" || (theme === "system" && prefersDark);

  const root = document.documentElement;
  root.setAttribute("data-theme", shouldBeDark ? "dark" : "light");
  root.classList.toggle("dark", shouldBeDark);
}
