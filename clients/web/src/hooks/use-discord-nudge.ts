/**
 * Discord community page helpers.
 *
 * The chat nudge stack is gone; what survives is the community page's
 * join action over the public invite URL.
 */

import { useNudgeStore } from "@/stores/nudge-store";

/** Public Discord invite URL for the Cadet community. */
export const DISCORD_INVITE_URL = "https://discord.gg/ZABd9V2zM8";

export function openDiscordInvite(): void {
  window.open(DISCORD_INVITE_URL, "_blank", "noopener,noreferrer");
}

export function joinDiscord(): void {
  openDiscordInvite();
  useNudgeStore.getState().markDiscordJoined();
}
