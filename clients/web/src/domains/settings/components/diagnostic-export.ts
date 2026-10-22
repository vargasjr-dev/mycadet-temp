import type { LockfileAssistant } from "@/runtime/local-mode-host";

export async function exportLocalDebugBundle(
  assistant: LockfileAssistant,
  uploadUrl: string,
): Promise<void> {
  // The scoped data plane is plain same-origin /v1 and the trusted host
  // injects the gateway bearer on its forward — the renderer sends no
  // credential and mints nothing.
  const logs = await fetch(
    `/v1/assistants/${encodeURIComponent(assistant.assistantId)}/logs/export`,
    {
      method: "POST",
      signal: AbortSignal.timeout(180_000),
    },
  );
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
