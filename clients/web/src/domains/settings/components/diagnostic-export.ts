import { z } from "zod";
import { getLocalGatewayUrl } from "@/lib/local-mode";
import {
  fetchGuardianTokenHost,
  type LockfileAssistant,
} from "@/runtime/local-mode-host";

export async function exportLocalDebugBundle(
  assistant: LockfileAssistant,
  uploadUrl: string,
): Promise<void> {
  const gateway = getLocalGatewayUrl(assistant);
  if (!gateway) {
    throw new Error("No local gateway is available.");
  }
  const base = `${window.location.origin}${gateway}`;
  const guardian = await fetchGuardianTokenHost(assistant.assistantId);
  const minted = await fetch(`${base}/auth/token`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${guardian}` },
  });
  if (!minted.ok) {
    throw new Error(`Gateway authentication failed (HTTP ${minted.status}).`);
  }
  const { token } = z
    .object({ token: z.string().min(1) })
    .parse(await minted.json());
  const logs = await fetch(`${base}/v1/logs/export`, {
    method: "POST",
    signal: AbortSignal.timeout(180_000),
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!logs.ok) {
    throw new Error(`Diagnostic export failed (HTTP ${logs.status}).`);
  }
  const upload = await fetch(uploadUrl, {
    method: "PUT",
    signal: AbortSignal.timeout(300_000),
    headers: { "Content-Type": "application/octet-stream" },
    body: await logs.blob(),
  });
  if (!upload.ok) {
    throw new Error(`Diagnostic upload failed (HTTP ${upload.status}).`);
  }
}
