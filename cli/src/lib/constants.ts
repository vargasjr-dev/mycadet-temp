/**
 * Canonical internal assistant ID used as the default/fallback across the CLI
 * and daemon. Mirrors `DAEMON_INTERNAL_ASSISTANT_ID` from
 * `assistant/src/runtime/assistant-scope.ts`.
 */
export const DAEMON_INTERNAL_ASSISTANT_ID = "self" as const;

export const FIREWALL_TAG = "mycadet";
export const GATEWAY_PORT = process.env.GATEWAY_PORT
  ? Number(process.env.GATEWAY_PORT)
  : 7830;

/** Default ports used as scan start points for multi-instance allocation. */
export const DEFAULT_DAEMON_PORT = 7821;
export const DEFAULT_GATEWAY_PORT = 7830;
export const DEFAULT_QDRANT_PORT = 6333;
export const DEFAULT_CES_PORT = 8090;

export const VALID_REMOTE_HOSTS = [
  "local",
  "docker",
  "custom",
  "cloud",
] as const;
export type RemoteHost = (typeof VALID_REMOTE_HOSTS)[number];
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  magenta: "\x1b[35m",
} as const;

/** Hatch identity: the color shown while an assistant hatches. */
export const HATCH_COLOR = ANSI.magenta;

/** Hatch identity: the ASCII art shown while an assistant hatches. */
export const HATCH_ART = [
  `${ANSI.magenta}  *     .--.${ANSI.reset}`,
  `${ANSI.magenta}       |${ANSI.reset}${ANSI.bold}o_o${ANSI.reset}${ANSI.magenta}|${ANSI.reset}`,
  `${ANSI.magenta} *     |${ANSI.reset}${ANSI.bold}:_/${ANSI.reset}${ANSI.magenta}|${ANSI.reset}`,
  `${ANSI.magenta}      //   \\ \\${ANSI.reset}`,
  `${ANSI.magenta}     (|     | )${ANSI.reset}`,
  `${ANSI.magenta}    /'\\_   _/\`\\${ANSI.reset}`,
  `${ANSI.magenta}    \\___)=(___/${ANSI.reset}`,
];

/** Hatch identity: emoji shown when an assistant has hatched. */
export const HATCHED_EMOJI = "👾";
