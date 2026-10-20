import { formatLocale } from "@app/i18n";

/**
 * Compact relative-time label for inline metadata ("just now", "2h ago").
 * Port of web's `formatRelativeDate` (clients/web/src/utils/format-date.ts)
 * for the chooser's row subtitles, which pair it with a hosting label.
 * Mirrors the macOS client's `Date.relativeShortString()`.
 */
export function formatRelativeDate(dateStr: string | null | undefined): string {
  if (!dateStr) {
    return "—";
  }

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const MINUTE_MS = 1000 * 60;
  const HOUR_MS = MINUTE_MS * 60;
  const DAY_MINUTES = 60 * 24;
  const DAY_MS = MINUTE_MS * DAY_MINUTES;

  if (diffMs < 0) {
    const absDiffMs = -diffMs;
    if (absDiffMs < HOUR_MS) {
      return "in <1h";
    }
    const roundedMinutes = Math.round(absDiffMs / MINUTE_MS);
    const hours = Math.round(roundedMinutes / 60);
    if (hours < 24) {
      return `in ${hours}h`;
    }
    return `in ${Math.round(roundedMinutes / DAY_MINUTES)}d`;
  }

  const diffDays = Math.floor(diffMs / DAY_MS);
  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / HOUR_MS);
    if (diffHours === 0) {
      const diffMins = Math.floor(diffMs / MINUTE_MS);
      return diffMins <= 1 ? "just now" : `${diffMins}m ago`;
    }
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) {
    return "yesterday";
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks}w ago`;
  }
  return date.toLocaleDateString(formatLocale());
}
