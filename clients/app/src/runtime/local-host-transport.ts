import { z } from "zod";

const commandResultSchema = z.object({ ok: z.boolean() });

/** A local-host command always settles, including offline or non-JSON replies. */
export async function postLocalCommand(
  path: string,
  body: unknown,
): Promise<{ ok: boolean }> {
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
