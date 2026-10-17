import { z } from "zod";
import { readInjectedConfig } from "@app/lib/injected-config";
import { getElectronBridge } from "@app/runtime/electron-bridge";

const commandResultSchema = z.object({ ok: z.boolean() });

/** Only Electron and explicitly injected local hosts expose these endpoints. */
export function isLocalModeHostAvailable(): boolean {
  return (
    Boolean(getElectronBridge()) || readInjectedConfig()?.remote === "local"
  );
}

/** A local-host command always settles, including offline or non-JSON replies. */
export async function postLocalCommand(
  path: string,
  body: unknown,
): Promise<{ ok: boolean }> {
  if (!isLocalModeHostAvailable()) return { ok: false };
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = commandResultSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { ok: false };
  } catch {
    return { ok: false };
  }
}
