/**
 * `gateway contacts` operator surface.
 *
 * Reads and writes gateway-owned contact ACL over the gateway IPC socket.
 * The risk-ceiling write is `set_contact_threshold`. inherit maps to null.
 */

import { ipcCall } from "@mycadet/gateway-client/ipc-client";

import { resolveIpcSocketPath } from "../ipc/endpoint.js";
import { getLogger } from "../logger.js";

const log = getLogger("gateway-cli");

export type ParsedContactsCommand =
  | { kind: "list"; json: boolean; role?: string }
  | { kind: "get"; contactId: string; json: boolean }
  | {
      kind: "set-risk-threshold";
      contactId: string;
      threshold: "none" | "low" | "medium" | "high" | null;
      json: boolean;
    };

interface ContactChannel {
  id?: string;
  type?: string;
  address?: string;
}

interface ContactRecord {
  id: string;
  displayName: string;
  role?: string | null;
  contactType?: string | null;
  autoApproveThreshold?: string | null;
  channels?: ContactChannel[];
}

export type GatewayIpcCall = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export async function defaultGatewayIpcCall(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const { path } = resolveIpcSocketPath("gateway.sock");
  return ipcCall(path, method, params, log);
}

export async function executeContactsCommand(
  parsed: ParsedContactsCommand,
  ipc: GatewayIpcCall = defaultGatewayIpcCall,
): Promise<number> {
  if (parsed.kind === "list") {
    const result = await ipc("contacts_list_rich", {
      ...(parsed.role ? { role: parsed.role } : {}),
    });
    if (!isOkList(result)) {
      return failUnreachable();
    }
    const contacts = result.contacts;
    if (parsed.json) {
      console.log(JSON.stringify({ ok: true, contacts }));
      return 0;
    }
    if (contacts.length === 0) {
      console.log("No contacts found.");
      return 0;
    }
    for (const contact of contacts) {
      const ceiling = contact.autoApproveThreshold ?? "inherit";
      const role = contact.role ?? "contact";
      console.log(
        `${contact.id}  ${contact.displayName}  ${role}  access:${ceiling}`,
      );
    }
    console.log("");
    console.log(
      `${contacts.length} ${contacts.length === 1 ? "contact" : "contacts"}`,
    );
    return 0;
  }

  if (parsed.kind === "get") {
    const result = await ipc("contacts_get_rich", {
      contactId: parsed.contactId,
    });
    if (result == null) {
      console.error(
        `Contact "${parsed.contactId}" not found. Run 'gateway contacts list' to see IDs.`,
      );
      return 1;
    }
    if (!isOkGet(result)) {
      return failUnreachable();
    }
    if (parsed.json) {
      console.log(JSON.stringify(result));
      return 0;
    }
    console.log(formatContact(result.contact));
    return 0;
  }

  const result = await ipc("set_contact_threshold", {
    contactId: parsed.contactId,
    threshold: parsed.threshold,
  });
  if (result === undefined) {
    return failUnreachable();
  }
  if (!isSetResult(result)) {
    return failUnreachable();
  }
  if (result.ok === false) {
    console.error(
      `Contact "${parsed.contactId}" not found. Run 'gateway contacts list' to see IDs.`,
    );
    return 1;
  }
  if (parsed.json) {
    console.log(JSON.stringify(result));
    return 0;
  }
  const ceiling = result.threshold ?? "inherit";
  console.log(`Set assistant access for ${result.contactId} to ${ceiling}`);
  return 0;
}

function failUnreachable(): number {
  console.error(
    "Gateway is not running or is unreachable over IPC. Start it with 'cadet wake', then retry.",
  );
  return 1;
}

function isOkList(
  value: unknown,
): value is { ok: true; contacts: ContactRecord[] } {
  if (value == null || typeof value !== "object") {
    return false;
  }
  if (!("ok" in value) || !("contacts" in value)) {
    return false;
  }
  return Array.isArray((value as { contacts: unknown }).contacts);
}

function isOkGet(
  value: unknown,
): value is { ok: true; contact: ContactRecord } {
  if (value == null || typeof value !== "object") {
    return false;
  }
  return "ok" in value && "contact" in value;
}

function isSetResult(
  value: unknown,
): value is
  | { ok: true; contactId: string; threshold: string | null }
  | { ok: false; error: string } {
  if (value == null || typeof value !== "object") {
    return false;
  }
  return "ok" in value;
}

function formatContact(contact: ContactRecord): string {
  const lines = [
    `ID:           ${contact.id}`,
    `Display Name: ${contact.displayName}`,
    `Role:         ${contact.role ?? "contact"}`,
    `Access:       ${contact.autoApproveThreshold ?? "inherit"}`,
  ];
  const channels = contact.channels ?? [];
  if (channels.length > 0) {
    lines.push("");
    lines.push("Channels:");
    for (const channel of channels) {
      lines.push(
        `  ${channel.id ?? "?"}  ${channel.type ?? "?"}  ${channel.address ?? "?"}`,
      );
    }
  }
  return lines.join("\n");
}
