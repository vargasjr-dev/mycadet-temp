import { fetchAssistantLogsHost } from "@/runtime/local-mode-host";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

export async function exportLocalDebugBundle(
  assistant: LockfileAssistant,
  uploadUrl: string,
): Promise<void> {
  // The scoped data plane is plain same-origin /v1 and the trusted host
  // injects the gateway bearer on its forward — the renderer sends no
  // credential and mints nothing.
  const logs = await fetchAssistantLogsHost(assistant.assistantId);
  const upload = await fetch(uploadUrl, {
    method: "PUT",
    signal: AbortSignal.timeout(300_000),
    headers: { "Content-Type": "application/octet-stream" },
    body: logs,
  });
  if (!upload.ok) {
    throw new Error(`Diagnostic upload failed (HTTP ${upload.status}).`);
  }
}
