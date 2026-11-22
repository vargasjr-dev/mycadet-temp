// The sidebar's section-key namespace. The fold state this file used to hold
// (per-assistant open/closed buckets in localStorage, plus the sections the
// user had expanded past their mid height) died with the fold: sections do
// not collapse and do not cap, so there is nothing left to persist.
//
// What survives is the key convention the sections themselves are keyed by.

/** Prefix marking a collapsible category as a per-channel origin section. */
const CHANNEL_SECTION_PREFIX = "channel:";

/**
 * Collapse-state key for an origin channel's sidebar section (e.g.
 * `"telegram"` → `"channel:telegram"`). Prefixed so it can accept any
 * channel without an exhaustive allowlist.
 */
export function channelSectionKey(channelId: string): string {
  return `${CHANNEL_SECTION_PREFIX}${channelId}`;
}

/** True for a per-origin-channel section key (e.g. `"channel:slack"`). */
export function isChannelSectionKey(key: string): boolean {
  return key.startsWith(CHANNEL_SECTION_PREFIX);
}
