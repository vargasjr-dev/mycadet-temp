/**
 * Shared User-Agent for HTTP calls made from the assistant container
 * (GitHub APIs, plugin catalog, platform installs). One value so every
 * request identifies the same client; keep generate-plugin-icons.mjs in
 * sync (it runs under plain node and can't import this module).
 */
export const USER_AGENT = "cadet-assistant";
