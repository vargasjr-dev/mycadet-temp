/**
 * `assistant memory injection` CLI subgroup.
 *
 * Per-conversation memory-injection opt-out. Runs directly in the CLI
 * process — no IPC, no daemon required: each subcommand imports the memory
 * plugin's store (`memory-injection-store.ts`) and calls it against the
 * workspace's on-disk memory database. The daemon re-reads the flag on every
 * turn, so a change takes effect immediately.
 *
 * Subcommands:
 *
 *   - `enable <conversationId>` — turn memory injection on (the default).
 *   - `disable <conversationId>` — turn memory injection off: the plugin
 *     attaches no memory for the conversation — no fresh retrieval of any
 *     engine, no static essentials/threads block, no PKB context. Prior
 *     turns' already-cached blocks ride history untouched.
 *   - `list` — every conversation with injection turned off.
 */

import type { Command } from "commander";

import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";

export function registerMemoryInjectionCommand(memory: Command): void {
  const injection = subcommand(memory, "injection");

  const setOff = async (
    conversationId: string,
    off: boolean,
    verb: string,
  ): Promise<void> => {
    // Deferred: loads the memory plugin's store (and the memory connection)
    // into this process — the same direct invocation as
    // `assistant memory retrospective`.
    const { setMemoryInjectionOff } =
      await import("../../../plugins/defaults/memory/memory-injection-store.js");
    if (!setMemoryInjectionOff(conversationId, off)) {
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
      await setOff(conversationId, false, "enable");
    },
  );

  // ── disable ────────────────────────────────────────────────────────────

  subcommand(injection, "disable").action(
    async (conversationId: string, _opts: unknown, _cmd: Command) => {
      await setOff(conversationId, true, "disable");
    },
  );

  // ── list ───────────────────────────────────────────────────────────────

  subcommand(injection, "list").action(async () => {
    const { listMemoryInjectionOffConversations } =
      await import("../../../plugins/defaults/memory/memory-injection-store.js");
    const conversations = listMemoryInjectionOffConversations();
    if (conversations.length === 0) {
      log.info("Memory injection is on for every conversation.");
      return;
    }
    for (const conversationId of conversations) {
      log.info(`${conversationId}: off`);
    }
  });
}
