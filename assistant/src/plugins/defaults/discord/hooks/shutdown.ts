/**
 * Default `shutdown` hook for the Discord channel plugin — a no-op in this
 * skeleton. Phase 1 will close the plugin-owned Discord gateway connection
 * here so a daemon shutdown or an in-place plugin redeploy never leaks the
 * socket.
 */

import { type HookFunction, type ShutdownContext } from "@mycadet/plugin-api";

const shutdown: HookFunction<ShutdownContext> = async () => {};

export default shutdown;
