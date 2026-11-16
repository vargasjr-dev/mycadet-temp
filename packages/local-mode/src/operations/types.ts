import type { LockfileAssistant } from "../lockfile-contract";

export type HatchAssistantResult =
  | {
      ok: true;
      assistant: LockfileAssistant;
      /**
       * Whether the leg confirmed the assistant is up and serving — the
       * gate for the CLI's next-steps narration. The cloud and baseten
       * legs return before anything is confirmed ready (the platform
       * provisions asynchronously; the sandbox wakes itself), so they
       * report false.
       */
      ready: boolean;
      /** The hatched assistant's platform status (the cloud leg). */
      status?: string;
      /**
       * Set-Cookie values the hatch feed ships to the hatched assistant's
       * webview: the credential pair the leg's own lease step just minted,
       * so the webview starts with a jar instead of a bearer-token handoff.
       * Legs without a local lease (the platform-hosted ones) ship none.
       */
      cookies: string[];
    }
  | { ok: false; status: number; error: string; assistantId?: string };
