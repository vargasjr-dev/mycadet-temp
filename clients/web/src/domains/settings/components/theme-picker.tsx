import { Monitor, Moon, Sun } from "lucide-react";

import { useThemePreference } from "@/hooks/use-theme-preference";
import { useTranslation } from "@/i18n";
import { type ThemePreference } from "@/utils/theme-preferences";
import { SegmentControl } from "@mycadet/design-library/components/segment-control";

/**
 * Theme picker (System / Light / Dark), shown inline in the Preferences card
 * on Settings → General. Not Electron-gated — theme applies on every platform.
 * This card owns the theme UI; the chat menu's Theme section was removed.
 */
export function ThemePicker() {
  const { t } = useTranslation("settings");
  const { theme, setThemePreference } = useThemePreference();

  const themeItems = [
    {
      value: "system" as const,
      label: t("themePicker.system"),
      icon: <Monitor className="h-4 w-4" />,
    },
    {
      value: "light" as const,
      label: t("themePicker.light"),
      icon: <Sun className="h-4 w-4" />,
    },
    {
      value: "dark" as const,
      label: t("themePicker.dark"),
      icon: <Moon className="h-4 w-4" />,
    },
  ];

  return (
    <section>
      <h3 className="text-title-small text-[var(--content-emphasised)]">
        {t("themePicker.title")}
      </h3>
      <div className="mt-2 max-w-[360px]">
        <SegmentControl<ThemePreference>
          ariaLabel={t("themePicker.ariaLabel")}
          value={theme}
          onChange={setThemePreference}
          items={themeItems}
        />
      </div>
    </section>
  );
}
