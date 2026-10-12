/**
 * Default `init` hook for the Discord channel plugin — a no-op in this
 * skeleton. Phase 1 of the gateway→plugin migration lands here: this hook
 * will dial Discord's gateway directly (using the bot token already managed
 * through the integrations/discord config surface) and route inbound events
 * in-process instead of round-tripping through the gateway's
 * /deliver/discord callback. Nothing dials out yet; the hook exists so the
 * plugin lifecycle is populated and the manifest is addressable.
 */

import { type HookFunction, type InitContext } from "@mycadet/plugin-api";

const init: HookFunction<InitContext> = async () => {};

export default init;
