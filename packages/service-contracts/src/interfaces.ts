import { z } from "zod";

/**
 * Canonical interface-id vocabulary shared between the assistant daemon and
 * its clients.
 *
 * An "interface" is the client surface a connection or turn comes through —
 * native desktop shells (macos/windows/linux), mobile shells, the CLI, the
 * web client, chat channels (telegram, whatsapp, slack, email, discord),
 * phone, the chrome extension, plus a couple of internal ids. This is the
 * single source of truth for that set:
 *
 * - `web` is the web client's transport registration. An embedded web client
 *   (the desktop and mobile shells frame the same web bundle) reports the
 *   shell's own interface on TURNS — the daemon derives host-proxy
 *   capabilities server-side, purely from this id, so a renderer connection
 *   registers as `web` and never advertises host capabilities.
 * - `route` names turns injected by workspace custom routes (webhook
 *   receivers, cron jobs, device/service callbacks). Non-interactive —
 *   permission prompts route through the guardian system, not an
 *   interactive client — and non-host-proxy.
 * - `plugin` names every channel a plugin brings; which plugin it was is in
 *   `sourceMetadata.plugin`.
 *
 * Both the daemon and the web client depend on
 * `@mycadet/service-contracts`, so hoisting the set here (rather than
 * maintaining a copy on each side) means adding or renaming an interface
 * happens in exactly one place. A consumer may legitimately handle only a
 * subset — use a local list guarded by
 * `satisfies readonly InterfaceId[]` for those cases rather than redefining
 * the union.
 */

export const INTERFACE_IDS = [
  "macos",
  "windows",
  "linux",
  "ios",
  "android",
  "cli",
  "telegram",
  "phone",
  "web",
  "whatsapp",
  "slack",
  "email",
  "chrome-extension",
  "discord",
  "route",
  "plugin",
] as const;

export type InterfaceId = (typeof INTERFACE_IDS)[number];

export function isInterfaceId(value: unknown): value is InterfaceId {
  return (
    typeof value === "string" &&
    (INTERFACE_IDS as readonly string[]).includes(value)
  );
}

export const interfaceIdSchema = z.enum(INTERFACE_IDS);
