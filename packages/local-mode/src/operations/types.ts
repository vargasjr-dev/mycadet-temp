import { LockfileAssistant } from "../lockfile-contract";

export type HatchAssistantResult =
  | {
      ok: true;
      assistant: LockfileAssistant;
      ready: boolean;
      status?: string;
      cookies: string[];
    }
  | { ok: false; status: number; error: string; assistantId?: string };
