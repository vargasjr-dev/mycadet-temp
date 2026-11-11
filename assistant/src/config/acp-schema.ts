import { z } from "zod";

export const AcpAgentConfigSchema = z
  .object({
    command: z
      .string()
      .optional()
      .describe(
        "Command to spawn the ACP agent process. Required unless the id has a bundled profile, whose command is inherited when this is unset",
      ),
    args: z
      .array(z.string())
      .default([])
      .describe("Arguments passed to the agent command"),
    description: z
      .string()
      .optional()
      .describe("Human-readable description of what this agent does"),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables set for the agent process"),
    model: z
      .string()
      .optional()
      .describe(
        "Model sessions of this agent start on when the ask names none (an adapter-reported alias such as 'opus' or 'sonnet' for Claude, not an Assistant catalog id). Overrides the bundled profile's value; unset inherits it.",
      ),
  })
  .describe("Configuration for an individual ACP agent");

export const AcpConfigSchema = z
  .object({
    maxConcurrentSessions: z
      .number()
      .int()
      .positive()
      .default(4)
      .describe(
        "Maximum number of ACP agent sessions that can run simultaneously",
      ),
    agents: z
      .record(z.string(), AcpAgentConfigSchema)
      .superRefine((agents, ctx) => {
        for (const [id, agent] of Object.entries(agents)) {
          if (
            agent.command !== undefined ||
            Object.hasOwn(DEFAULT_ACP_AGENT_PROFILES, id)
          ) {
            continue;
          }
          ctx.addIssue({
            code: "custom",
            path: [id, "command"],
            message: `acp.agents.${id} needs a command: only the bundled ids (${Object.keys(DEFAULT_ACP_AGENT_PROFILES).join(", ")}) inherit one`,
          });
        }
      })
      .default({})
      .describe("Map of agent names to their configurations"),
  })
  .describe(
    "Agent Communication Protocol (ACP) — inter-agent communication and delegation",
  );

export type AcpConfig = z.infer<typeof AcpConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;

// ── Bundled defaults ──────────────────────────────────────────────────────
// Lives beside the schema it types: the refinement above reads
// DEFAULT_ACP_AGENT_PROFILES to decide which agent ids may omit `command`,
// so the two halves of that contract belong in one file.

/**
 * A bundled profile always names its command; a user entry for the same id
 * may omit `command` and inherit this one.
 */
export type AcpAgentProfile = AcpAgentConfig & { command: string };

// Shared frozen empty args array — these defaults are read by every ACP spawn,
// so a single accidental `args.push(...)` from one caller would corrupt every
// subsequent read. Cast through `unknown` because `AcpAgentConfig.args` is
// `string[]` (Zod-inferred) but the value is genuinely immutable at runtime.
const FROZEN_EMPTY_ARGS = Object.freeze([] as string[]) as unknown as string[];

/**
 * Default ACP agent profiles that ship with the assistant.
 *
 * When the user has not provided a config entry for an agent id, the resolver
 * falls back to this map so common agents like `claude` and `codex` Just Work
 * without requiring per-user config.
 *
 * A profile's `model` is the model a session of that agent starts on when the
 * ask names none, and is the rung `acp.agents.<id>.model` fills: a user config
 * entry that names a model overrides it, one that omits it inherits it.
 *
 * Keyed by agent id. Deeply frozen: the outer object, each profile, and the
 * `args` arrays, so mutation throws in strict mode rather than silently
 * corrupting the shared defaults.
 */
export const DEFAULT_ACP_AGENT_PROFILES: Readonly<
  Record<string, AcpAgentProfile>
> = Object.freeze({
  claude: Object.freeze({
    command: "claude-agent-acp",
    args: FROZEN_EMPTY_ARGS,
    description: "Claude Code (via @agentclientprotocol/claude-agent-acp)",
    model: "opus",
  }),
  codex: Object.freeze({
    command: "codex-acp",
    args: FROZEN_EMPTY_ARGS,
    description: "OpenAI Codex CLI (via @agentclientprotocol/codex-acp)",
  }),
});

/**
 * Single source of truth for adapter binary → npm package spec. Automatic
 * installation and the resolver's install hints use this map, so a new
 * adapter only needs one entry here.
 *
 * Keyed by command name (not agent id) so the mapping follows the binary
 * regardless of how a user's config aliases an agent.
 *
 * Values carry an exact version, so a clean install lands the adapter version
 * the daemon was tested against instead of whatever npm calls latest today.
 * An adapter already on PATH is left alone: installation runs only when
 * preflight found no binary at all, so this never moves a version the user
 * installed themselves.
 */
export const DEFAULT_AGENT_NPM_PACKAGES: Readonly<Record<string, string>> =
  Object.freeze({
    "claude-agent-acp": "@agentclientprotocol/claude-agent-acp@0.75.1",
    "codex-acp": "@agentclientprotocol/codex-acp@1.10.0",
  });
