import type { SleepResult } from "@mycadet/local-mode";

/** Map the operation's structured result onto the command's narration. */
export function narrate(result: SleepResult): void {
  if (!result.ok) return;
  if (result.cancelled) {
    console.log("Sleep cancelled — the assistant is still running.");
    return;
  }
  if (result.kind === "containers") {
    console.log("Docker containers stopped.");
    return;
  }
  for (const note of result.notes) {
    console.log(note);
  }
  console.log(
    result.services.assistant === "stopped"
      ? "Assistant stopped."
      : "Assistant is not running.",
  );
  console.log(
    result.services.gateway === "stopped"
      ? "Gateway stopped."
      : "Gateway is not running.",
  );
  if (result.services.ces === "stopped") {
    console.log("credential-executor stopped.");
  }
}

/** 130 for a user-cancelled wait, 1 for a failed stop, 0 otherwise. */
export function exitCodeFor(result: SleepResult): number {
  if (!result.ok) return 1;
  return result.cancelled ? 130 : 0;
}
