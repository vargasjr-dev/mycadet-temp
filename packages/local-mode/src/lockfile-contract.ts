/**
 * The lockfile wire contract — one Zod schema that is the single source of truth
 * for an assistant entry's shape, its validation, the `cloud` taxonomy, the
 * normalization, and the redaction policy.
 *
 * Kept in its own module, exported from the package as `./contract`, so
 * consumers import the contract without pulling in the host I/O graph
 * (`node:fs`, the CLI resolver). The CLI, the host I/O layer, the Electron and
 * dev-server bridges, and the renderer all depend on this one definition. It
 * references no node built-ins — the renderer bundles it directly — and `zod`
 * is its only third-party import.
 *
 * The lockfile is written by the Cadet CLI and read across the macOS↔CLI
 * boundary, which do not release in lockstep, so the parser is permissive: it
 * validates each entry whole through the schema (a malformed field drops that
 * entry, never the file), ignores unknown fields so a newer writer never
 * breaks an older reader, and defaults `cloud` when it is absent or unknown.
 * Unknown fields are preserved on disk by the write
 * path (see `lockfile.ts`); the validated value carries only the modeled,
 * renderer-safe shape.
 */
import { z } from "zod";

/**
 * Known deployment topologies. The set is enumerated here so callers switch
 * on it exhaustively instead of matching string literals scattered across the
 * codebase — and so the lockfile's `cloud` field and the clients' injected
 * `remote` field are the same schema and type:
 *  - `local` — on-machine daemon
 *  - `docker` — local container
 *  - `apple-container` — macOS-app-managed container
 *  - `cloud` — cloud-managed (uses the X-Session-Token auth path)
 *  - `custom` — remote, user-managed (e.g. SSH)
 *
 * Pairing is not a topology: a paired entry is distinguished by its `paired`
 * flag and reached through its `runtimeUrl`, never by a `cloud` value.
 * Unknown on-disk values — including the retired `cadet`, `gcp`, `aws`, and
 * `paired` spellings — parse through the lockfile field's `catch` as "local".
 */
export const KNOWN_CLOUDS = [
  "local",
  "docker",
  "apple-container",
  "cloud",
  "custom",
] as const;
export type KnownCloud = (typeof KNOWN_CLOUDS)[number];

/**
 * The topology values as one zod enum, shared by the lockfile schema (which
 * wraps it in a `catch`) and the clients' injected-config schema, so the two
 * can never drift.
 */
export const CloudSchema = z.enum(KNOWN_CLOUDS);
export type Cloud = z.infer<typeof CloudSchema>;

/**
 * Keys that must never cross the host→renderer boundary. Stripped from raw
 * lockfile JSON before it leaves a host (see `stripSensitiveFields`) and absent
 * from the renderer-facing schema below; the CLI's extended type is the only
 * place they are modeled.
 */
export const SENSITIVE_KEYS = [
  "signingKey",
  "bearerToken",
  "guardianBootstrapSecret",
] as const;

/**
 * Strip every `SENSITIVE_KEYS` field from a parsed lockfile, in place: from
 * each assistant entry and from that entry's `resources`. The one redaction
 * every host runs before lockfile data crosses to the renderer — pure, no
 * node built-ins, so it lives beside the keys it enforces and bundles into
 * the renderer through the `./contract` subpath.
 */
export function stripSensitiveFields(data: Record<string, unknown>): void {
  const assistants = data.assistants;
  if (!Array.isArray(assistants)) return;
  for (const assistant of assistants) {
    if (assistant && typeof assistant === "object") {
      const entry = assistant as Record<string, unknown>;
      for (const field of SENSITIVE_KEYS) {
        delete entry[field];
      }
      const resources = entry.resources;
      if (resources && typeof resources === "object") {
        for (const field of SENSITIVE_KEYS) {
          delete (resources as Record<string, unknown>)[field];
        }
      }
    }
  }
}

/**
 * Whether a cloud value denotes the cloud-managed topology. Every reader
 * classifying an entry as platform-managed switches on this instead of
 * matching the literal.
 */
export function isCloudHome(cloud: unknown): boolean {
  return cloud === "cloud";
}

/**
 * Whether an entry's `runtimeUrl` is one a serving host can forward to: an
 * absolute http(s) URL. Shared by the renderer's paired-gateway URL derivation
 * and the host-side paired allowlist reader so the two can't drift.
 */
export function isUsableRuntimeUrl(url: unknown): url is string {
  if (typeof url !== "string" || url === "") {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The id-keyed, same-origin gateway proxy base for any assistant entry: the
 * serving host (Electron `app://` handler, Vite dev middleware, CLI web
 * server) resolves the id through the lockfile to a loopback port (locally
 * hatched) or a recorded remote `runtimeUrl` (imported pairing), so the
 * renderer never encodes either.
 */
/**
 * First segments whose scoped `/v1/assistants/{id}/` prefix the gateway does
 * not serve: the contact family lives on flat `/v1/...` control-plane routes
 * (the shape the cloud's Django `RuntimeProxyView` strip delivers). Every
 * forwarder to the gateway — the scoped host proxy and the request
 * interceptor's remote-ingress rewrite alike — flattens them to match.
 */
export const FLATTENED_FIRST_SEGMENTS = new Set<string>([
  "contacts",
  "contact-channels",
]);

export function gatewayProxyUrl(assistantId: string): string {
  return `/assistant/__gateway/${encodeURIComponent(assistantId)}`;
}

/**
 * User-facing hosting label for a paired entry: "Paired · <hostname>" when
 * `runtimeUrl` names the remote host, plain "Paired" otherwise. Shared by the
 * macOS tray switcher and the web chooser so their renderings cannot drift.
 */
export function pairedHostLabel(runtimeUrl: string | undefined): string {
  if (runtimeUrl) {
    try {
      return `Paired · ${new URL(runtimeUrl).hostname}`;
    } catch {
      // Unparseable runtimeUrl: plain "Paired".
    }
  }
  return "Paired";
}

/**
 * Clouds whose gateway listens on a loopback port of this machine: the
 * on-machine daemon ("local") and local Docker instances ("docker").
 */
export const LOOPBACK_GATEWAY_CLOUDS: readonly Cloud[] = ["local", "docker"];

export function isLoopbackGatewayCloud(cloud: Cloud): boolean {
  return LOOPBACK_GATEWAY_CLOUDS.includes(cloud);
}

/**
 * The loopback gateway port recorded for an assistant entry:
 * `resources.gatewayPort` when present, else the port of a loopback
 * `runtimeUrl` (how docker hatch records its published gateway). A
 * non-loopback `runtimeUrl` yields nothing.
 */
export function getLoopbackGatewayPort(entry: {
  resources?: { gatewayPort?: number };
  runtimeUrl?: string;
}): number | undefined {
  const recorded = entry.resources?.gatewayPort;
  if (recorded != null) {
    return recorded;
  }
  if (!entry.runtimeUrl) {
    return undefined;
  }
  try {
    const url = new URL(entry.runtimeUrl);
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return undefined;
    }
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Per-instance resources for a local assistant: the renderer-facing subset of
 * ports, the instance directory, and the local runtime install metadata.
 * Richer host-only fields (other ports, the signing key) live on the CLI's
 * type and are stripped from this shape.
 */
export const LocalAssistantResourcesSchema = z.object({
  instanceDir: z.string().optional(),
  gatewayPort: z.number(),
  daemonPort: z.number(),
  runtimeVersion: z.string().optional(),
  runtimeInstallDir: z.string().optional(),
});
export type LocalAssistantResources = z.infer<
  typeof LocalAssistantResourcesSchema
>;

/**
 * The renderer-safe shape of one assistant entry. `assistantId` is the only
 * strictly-required field — the identity every reader looks entries up by —
 * and `cloud` always parses (absent and unknown values default to "local").
 * The CLI extends this with its host-only and sensitive fields; this base
 * carries only what is safe to surface in the renderer.
 */
export const LockfileAssistantSchema = z.object({
  assistantId: z.string(),
  name: z.string().optional(),
  /** Deployment topology; absent or unknown on-disk values parse as "local". */
  cloud: CloudSchema.catch("local"),
  runtimeUrl: z.string().optional(),
  hatchedAt: z.string().optional(),
  /**
   * When this assistant finished first-run onboarding. Absent for entries that
   * predate the record, which fall back to hatch age (see the web client's
   * `onboarded-assistant.ts`).
   */
  onboardedAt: z.string().optional(),
  /** Platform assistant UUID for a self-hosted local assistant registration. */
  cloudAssistantId: z.string().optional(),
  /** Platform base URL used for a self-hosted local assistant registration. */
  cloudBaseUrl: z.string().optional(),
  /** Platform organization UUID used for a self-hosted local assistant registration. */
  cloudOrganizationId: z.string().optional(),
  /**
   * Public https URL a `cadet tunnel` provider recorded for this assistant
   * (mirrored from the workspace ingress config). A public address, so it is
   * renderer-safe: remote-web pairing surfaces (the `cadet pair` flow, the web
   * "Pair a device" card) default to it instead of asking the user to retype it.
   */
  ingressUrl: z.string().optional(),
  /**
   * The connect-import marker: this entry was created by pairing to a remote
   * assistant from another machine (`cadet connect import`). Identity readers
   * switch on this flag — the `cloud` value never encodes pairing.
   */
  paired: z.boolean().optional(),
  resources: LocalAssistantResourcesSchema.optional(),
});

/**
 * A validated, normalized assistant entry. `cloud` is always present (the
 * schema's `catch` defaults absent and unknown on-disk values to "local"), so
 * readers never special-case its absence.
 */
export type LockfileAssistant = z.infer<typeof LockfileAssistantSchema>;

export interface Lockfile {
  assistants: LockfileAssistant[];
  activeAssistant: string | null;
}

/**
 * Renderer-facing result of a lockfile write, returned across the host bridge.
 * Carries no HTTP-style status — hosts map that away because the renderer
 * surfaces failures by message alone.
 */
export type LockfileWriteResult =
  | { ok: true; lockfile: Lockfile }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce parsed JSON into a validated {@link Lockfile}. Total and non-throwing:
 * each assistant entry parses through {@link LockfileAssistantSchema} and an
 * entry that fails validation is dropped whole (one malformed entry can't
 * discard the file), a missing or non-array `assistants` becomes `[]`, and a
 * non-string `activeAssistant` becomes null.
 */
export function parseLockfile(raw: unknown): Lockfile {
  const root = isRecord(raw) ? raw : {};
  const rawAssistants = Array.isArray(root.assistants) ? root.assistants : [];
  const assistants: LockfileAssistant[] = [];
  for (const entry of rawAssistants) {
    const parsed = LockfileAssistantSchema.safeParse(entry);
    if (parsed.success) assistants.push(parsed.data);
  }
  const activeAssistant =
    typeof root.activeAssistant === "string" ? root.activeAssistant : null;
  return { assistants, activeAssistant };
}
