/**
 * `assistant memory injection` CLI subgroup.
 *
 * Per-conversation memory-injection opt-out. Runs directly in the CLI
 * process — no IPC, no daemon required: each subcommand imports the memory
 * plugin's mode store (`conversation-mode-store.ts`) and calls it against
 * the workspace's on-disk memory database. The daemon re-reads the mode on
 * every turn, so a change takes effect immediately.
 *
 * Subcommands:
 *
 *   - `enable <conversationId>` — restore standard injection (the default).
 *   - `disable <conversationId>` — inject no memory for the conversation: no
 *     fresh retrieval of any engine, no static essentials/threads block, no
 *     PKB context. Prior turns' already-cached blocks ride history untouched.
 *   - `list` — every conversation with an explicit mode.
 */

import type { Command } from "commander";

import type { ConversationMemoryMode } from "../../../plugins/defaults/memory/conversation-mode-store.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";

export function registerMemoryInjectionCommand(memory: Command): void {
  const injection = subcommand(memory, "injection");

  const setMode = async (
    conversationId: string,
    mode: ConversationMemoryMode,
    verb: string,
  ): Promise<void> => {
    // Deferred: loads the memory plugin's store (and the memory connection)
    // into this process — the same direct invocation as
    // `assistant memory retrospective`.
    const { setConversationMemoryMode } = await import(
      "../../../plugins/defaults/memory/conversation-mode-store.js"
    );
    if (!setConversationMemoryMode(conversationId, mode)) {
      log.error(
        `${conversationId}: memory injection not ${verb}d (memory database unavailable)`,
      );
      process.exitCode = 1;
      return;
    }
    log.info(`${conversationId}: memory injection ${verb}d`);
  };

  // ── enable ─────────────────────────────────────────────────────────────

  subcommand(injection, "enable").action(
    async (conversationId: string, _opts: unknown, _cmd: Command) => {
      await setMode(conversationId, "standard", "enable");
    },
  );

  // ── disable ────────────────────────────────────────────────────────────

  subcommand(injection, "disable").action(
    async (conversationId: string, _opts: unknown, _cmd: Command) => {
      await setMode(conversationId, "off", "disable");
    },
  );

  // ── list ───────────────────────────────────────────────────────────────

  subcommand(injection, "list").action(async () => {
    const { listConversationMemoryModes } = await import(
      "../../../plugins/defaults/memory/conversation-mode-store.js"
    );
    const modes = listConversationMemoryModes();
    if (modes.length === 0) {
      log.info("No conversations with an explicit memory-injection mode.");
      return;
    }
    for (const row of modes) {
      log.info(`${row.conversationId}: ${row.mode}`);
    }
  });
}
