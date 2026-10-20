/**
 * JS side of the `SelfHostedServers` Capacitor plugin
 * (`clients/ios/App/App/SelfHostedServersPlugin.swift` and its Android
 * twin), scoped to what the app bundle needs: the origin swap. Web's
 * wrapper also backfills the remembered-origins store from the native list
 * and clears the iOS widget snapshot before a swap; this bundle keeps its
 * origins device-local in localStorage and has no widget machinery, so only
 * the two switch bridges are ported.
 *
 * On a native shell only the plugin can point the webview at another origin
 * without leaving the app, so `switchToOrigin` routes through these before
 * falling back to a plain navigation.
 *
 * **Skew contract** (web's `docs/CAPACITOR.md` § The skew rule): this bundle
 * is live for every user on their next app load while the installed shell
 * only changes after store review, so the plugin may always be absent.
 * Every bridge call is wrapped: a failure is an expected older shell, so it
 * logs `console.debug` and degrades to the behavior that shell already had —
 * a plain navigation off the app's own origin.
 */

import { registerPlugin } from "@capacitor/core";

interface SelfHostedServersPlugin {
  /** An absent `url` returns the shell to its baked Cadet Cloud origin. */
  switchTo(options: { url?: string }): Promise<{ ok: boolean }>;
  /** Switches origin and loads a route relative to the assistant app entry. */
  switchToPath(options: { url?: string; path: string }): Promise<{ ok: boolean }>;
}

/**
 * `registerPlugin` only builds the bridge Proxy, so this is inert until a
 * method is called: nothing reaches the shell before a switch is asked for.
 */
const SelfHostedServers =
  registerPlugin<SelfHostedServersPlugin>("SelfHostedServers");

/**
 * Swap the shell's origin in place, resolving whether the shell took the
 * switch, so a caller on an older shell (or off native mobile) can fall
 * back to a plain navigation.
 */
export async function nativeSwitchToOrigin(url: string): Promise<boolean> {
  try {
    await SelfHostedServers.switchTo({ url });
    return true;
  } catch (err) {
    console.debug("[self-hosted-servers] switchTo unavailable:", err);
    return false;
  }
}

/**
 * Switch the shell to an origin and load a route atomically. A separate
 * bridge method preserves the skew fallback when an older shell lacks path
 * support.
 */
export async function nativeSwitchToOriginPath(
  url: string,
  path: string,
): Promise<boolean> {
  try {
    await SelfHostedServers.switchToPath({ url, path });
    return true;
  } catch (err) {
    console.debug("[self-hosted-servers] switchToPath unavailable:", err);
    return false;
  }
}
