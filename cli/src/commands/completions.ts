import { loadAllAssistants } from "../lib/assistant-config.js";

/**
 * Commands whose first positional argument is an assistant name — completing
 * their first word offers the names of known assistants (from the lockfile)
 * instead of falling through to shell file completion.
 */
const ASSISTANT_NAME_COMMANDS = new Set([
  "exec",
  "logs",
  "message",
  "restart",
  "restore",
  "retire",
  "sleep",
  "teleport",
  "terminal",
  "upgrade",
  "use",
  "wake",
]);

/** First-positional subcommands, for commands that take no assistant name. */
const SUBCOMMAND_COMPLETIONS: Record<string, string[]> = {
  app: ["start", "stop"],
  tunnel: ["start", "stop"],
};

/** Assistant names known to this CLI's lockfile; [] when the lockfile is unreadable. */
function assistantNames(): string[] {
  try {
    return loadAllAssistants()
      .map((entry) => entry.assistantId)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve completion candidates for the word the cursor is on.
 *
 * `words` carries every command-line word after `cadet` up to the cursor,
 * INCLUDING the (possibly empty) word being completed — the same shape bash
 * passes via `COMP_WORDS[@]:1`. The returned list is UNFILTERED: the shell
 * (`compgen -W`) does the prefix filtering, so the CLI only decides WHAT
 * KIND of thing completes here.
 */
export function completeCadet(
  input: string[],
  commandNames: readonly string[],
): string[] {
  const words = [...input];
  const toComplete = words.pop() ?? "";
  const preceding = words;

  // Completing the command word itself (or nothing typed yet).
  if (preceding.length === 0) {
    return [...commandNames].sort();
  }

  // First positional of an assistant-name command: offer instance names.
  // Flag prefixes fall through to shell default (no flag completion yet).
  if (
    preceding.length === 1 &&
    ASSISTANT_NAME_COMMANDS.has(preceding[0]) &&
    !toComplete.startsWith("-")
  ) {
    return assistantNames();
  }

  // First positional of a subcommand-style command: offer its subcommands.
  if (preceding.length === 1 && !toComplete.startsWith("-")) {
    const subcommands = SUBCOMMAND_COMPLETIONS[preceding[0]];
    if (subcommands) return subcommands;
  }

  return [];
}

const BASH_COMPLETION_SCRIPT = `# bash completion for the cadet CLI — load with:  eval "$(cadet completions)"
_cadet_completions() {
  local candidates
  candidates=$(cadet __complete "\${COMP_WORDS[@]:1}" 2>/dev/null)
  COMPREPLY=($(compgen -W "$candidates" -- "\${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _cadet_completions cadet`;

// ── Entry point ─────────────────────────────────────────────────

export const completions = Object.assign(
  async function completions(): Promise<void> {
    console.log(BASH_COMPLETION_SCRIPT);
  },
  { description: `Print bash completion setup (eval "$(cadet completions)")` },
);
