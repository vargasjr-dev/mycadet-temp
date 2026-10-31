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
 * boundary, which do not release in lockstep, so the parser is permissive at
 * the file level: it validates each entry whole through the schema (a
 * malformed field drops that entry, never the file), accepts — but drops from
 * the validated value — entry fields this build has never heard of, and
 * defaults `cloud` when it is absent or unknown. The schema is strict over
 * the fields it models: every field a reader needs is IN the schema, so a
 * CLI read-modify-write round-trip preserves it by construction. The
 * local-mode write path still merges raw JSON (unknown root fields survive
 * on disk; see `lockfile.ts`); the validated value carries only the modeled
 * shape.
 */
import { TUNNEL_PROVIDERS } from "@mycadet/service-contracts/ingress";
import { SEEDS } from "@mycadet/environments";
import { z } from "zod";

import { resolveEnvironmentName } from "./environment";
import { readLockfile } from "./lockfile";

/**
 * Known deployment topologies of a Cadet:
 *  - `local` — on-machine bare-metal processes
 *  - `docker` — docker-managed container
 *  - `apple-container` — macOS-app-managed container
 *  - `cloud` — managed by Cadet Cloud
 *  - `custom` — remote VM accessible via SSH
 */
export const KNOWN_REMOTES = [
  "local",
  "docker",
  "apple-container",
  "cloud",
  "custom",
  "baseten",
] as const;

/**
 * The topology values as one zod enum, shared by the lockfile schema (which
 * wraps it in a `catch`) and the clients' injected-config schema, so the two
 * can never drift.
 */
export const RemoteSchema = z.enum(KNOWN_REMOTES);
export type Remote = z.infer<typeof RemoteSchema>;

/**
 * Keys that must never cross the host→renderer boundary. Stripped from raw
 * lockfile JSON before it leaves a host (see `stripSensitiveFields`) and absent
 * from the renderer-facing schema below; the CLI's extended type is the only
 * place they are modeled.
 */
export const SENSITIVE_KEYS = [
  "bearerToken",
  "guardianBootstrapSecret",
] as const;

/**
 * The runtime config a shell injects (`window.__CADET_CONFIG__`). This schema
 * is the single shape: hosts stamp it, served bundles parse the window
 * through it instead of re-declaring per-file object types.
 *
 * The URL fields are distinct origins in the topology, not synonyms:
 * `cloudUrl` is the cloud API base and `hubUrl` the cloud hub SPA the
 * pairing/settings pages link back to. The cloud login base is
 * deliberately absent: the loopback handoff reads it from the build's
 * environment seed (see startLoopbackAuth), keeping this config to the
 * origins a served bundle can't infer.
 */
export const InjectedConfigSchema = z.object({
  /** Nothing injected (SSR) or an unparseable config means the local cadet. */
  remote: RemoteSchema.catch("local"),
  /** Cloud API base (auth endpoints + assistant API). */
  cloudUrl: z.string().optional(),
  /** Device id stamped by the Electron host (device management). */
  deviceId: z.string().optional(),
  /** Version of the shell bundle serving this page (stamped by the host). */
  version: z.string().optional(),
  /** Serving assistant's id, stamped by every host that fronts one assistant. */
  assistantId: z.string().optional(),
  /** Serving assistant's display name, stamped by every host that fronts one assistant. */
  assistantName: z.string().optional(),
  /** Cloud web SPA base for this build's environment (remote-web ingress configs only). */
  hubUrl: z.string().optional(),
});

export type InjectedConfig = z.infer<typeof InjectedConfigSchema>;

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
export function isUsableBaseUrl(url: unknown): url is string {
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
 * The local build's control-plane base, read from the lockfile alone: the
 * auto-tunnel's recorded `publicUrl` when one is up, else the app server
 * edge's loopback port. A loopback base is reachable from the iOS simulator
 * only — a device's `127.0.0.1` is the phone itself — so a device build
 * wants a tunnel up before it stamps. `undefined` when neither record
 * carries a usable address.
 *
 * The assistants play no role in this resolution — the capacitor app shell
 * only deals with the app server — and the CLI's workspace config is never
 * touched: the lockfile is the single home for edge state.
 */
export function resolveLocalServerUrl(): string | undefined {
  const lockfile = readLockfile();
  const tunnelUrl = lockfile.tunnel?.publicUrl;
  if (isUsableBaseUrl(tunnelUrl)) {
    return tunnelUrl;
  }
  const port = lockfile.app?.port;
  if (typeof port === "number") {
    return `http://127.0.0.1:${port}`;
  }
  return undefined;
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
 * (the shape the cloud's runtime-proxy strip delivers). Every
 * forwarder to the gateway — the scoped host proxy and the request
 * interceptor's remote-ingress rewrite alike — flattens them to match.
 */
export const FLATTENED_FIRST_SEGMENTS = new Set<string>([
  "contacts",
  "contact-channels",
]);

/**
 * Clouds whose gateway listens on a loopback port of this machine: the
 * on-machine daemon ("local") and local Docker instances ("docker").
 */
export const LOOPBACK_GATEWAY_CLOUDS: readonly Remote[] = ["local", "docker"];

export function isLoopbackGatewayCloud(cloud: Remote): boolean {
  return LOOPBACK_GATEWAY_CLOUDS.includes(cloud);
}

/**
 * The loopback gateway port recorded for an assistant entry:
 * `resources.gatewayPort`. Entries without one derive the default gateway
 * port through {@link getGatewayUrl}.
 */
export function getLoopbackGatewayPort(
  entry: LockfileAssistant,
): number | undefined {
  return entry.resources?.gatewayPort;
}

/**
 * The gateway port a freshly hatched assistant's gateway listens on, with
 * the `GATEWAY_PORT` env override the CLI tooling honors.
 */
export const GATEWAY_PORT = process.env.GATEWAY_PORT
  ? Number(process.env.GATEWAY_PORT)
  : 7830;

/**
 * The cloud URL stack: the lockfile's platform base url (what the active
 * assistant was last hatched/waked against), else the `CADET_CLOUD_URL`
 * override, else the resolved environment's cloud url.
 */
function getCloudUrl(): string {
  const lockfileUrl = readLockfile().cloudBaseUrl;
  return (
    (typeof lockfileUrl === "string" && lockfileUrl.trim()) ||
    process.env.CADET_CLOUD_URL?.trim() ||
    SEEDS[resolveEnvironmentName()]?.cloudUrl ||
    SEEDS.production!.cloudUrl
  );
}

/**
 * The URL to dial an entry's gateway on, derived from the entry's canonical
 * fields — the one seam every consumer addresses a gateway through:
 *
 * - `custom` remotes: their recorded host and port.
 * - cloud-managed: the cloud URL stack.
 * - loopback topologies (`local`, `docker`, `apple-container`): the
 *   recorded loopback gateway port, else the default gateway port.
 */
export function getGatewayUrl(entry: LockfileAssistant): string {
  // Baseten sandboxes: every client rides the sandbox API server's
  // `/port/<PORT>/` reverse-proxy route — the gateway port is fixed at
  // sandbox creation (the `GATEWAY_PORT` env), so the address is derivable
  // from the entry alone.
  if (entry.cloud === "baseten" && entry.basetenSandboxUrl && entry.port) {
    return `${entry.basetenSandboxUrl.replace(/\/+$/, "")}/port/${entry.port}`;
  }
  if (entry.cloud === "custom" && entry.ipAddress && entry.port) {
    // Custom remotes speak TLS. Default ports elided the way a URL prints
    // them.
    const elided = entry.port === 443;
    return `https://${entry.ipAddress}${elided ? "" : `:${entry.port}`}`;
  }
  if (isCloudHome(entry.cloud)) {
    return getCloudUrl().replace(/\/+$/, "");
  }
  const port = getLoopbackGatewayPort(entry);
  return `http://127.0.0.1:${port ?? GATEWAY_PORT}`;
}

/**

 * Per-instance resources for a local assistant: the renderer-facing ports,
 * the instance directory, the local runtime install metadata, and the
 * host-only ports. Strict: every field the CLI round-trips is modeled, so
 * nothing is dropped by the parse. The secrets are stripped from renderer
 * reads by {@link stripSensitiveFields} before the parse ever sees them.
 */
export const LocalAssistantResourcesSchema = z.object({
  instanceDir: z.string().optional(),
  gatewayPort: z.number(),
  daemonPort: z.number(),
  /** HTTP port for the CES (Claude Extension Server) (host-only). */
  cesPort: z.number().optional(),
  runtimeVersion: z.string().optional(),
  runtimeInstallDir: z.string().optional(),
});
export type LocalAssistantResources = z.infer<
  typeof LocalAssistantResourcesSchema
>;

/** Docker image metadata for the service group. Enables rollback to known-good refs. */
export const ContainerInfoSchema = z.object({
  assistantImage: z.string(),
  gatewayImage: z.string(),
  cesImage: z.string(),
  /**
   * Host-side port the assistant HTTP API is published on. Dynamically
   * allocated at hatch time so concurrent instances don't collide on the
   * default (7821). Stored so rollback/upgrade can rebind the same port
   * instead of re-allocating (which could grab a different port if another
   * process took it in the interim).
   */
  assistantPort: z.number().optional(),
});
export type ContainerInfo = z.infer<typeof ContainerInfoSchema>;

/**
 * The shape of one assistant entry. `assistantId` is the only
 * strictly-required field — the identity every reader looks entries up by —
 * and `cloud` always parses (absent and unknown values default to "local").
 * Strict: every field the CLI read-modify-writes is modeled, so the parse
 * drops nothing a reader needs; fields unknown to this build are accepted on
 * disk but dropped from the validated value. The renderer boundary is
 * enforced by {@link stripSensitiveFields} on the hosts, before this parse
 * runs.
 */
export const LockfileAssistantSchema = z.object({
  assistantId: z.string(),
  name: z.string().optional(),
  /** Deployment topology; absent or unknown on-disk values parse as "local". */
  cloud: RemoteSchema.catch("local"),
  /** Host address of a custom remote's gateway (cloud "custom"). */
  ipAddress: z.string().optional(),
  /**
   * Gateway port on a custom remote (cloud "custom"), or the
   * sandbox-internal gateway port a Baseten sandbox's gateway listens on
   * (cloud "baseten" — piped in as `GATEWAY_PORT` at sandbox creation so
   * clients can address `{basetenSandboxUrl}/port/{port}` a priori).
   */
  port: z.number().optional(),
  /**
   * The Baseten sandbox server URL (cloud "baseten") — the address every
   * client hits; the assistant's gateway is reached at
   * `{basetenSandboxUrl}/port/{port}/` with the sandbox access token the
   * hatch saved beside the lockfile (see `basetenTokenPath`). Not a secret.
   */
  basetenSandboxUrl: z.string().optional(),
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
  /**
   * Platform organization the entry belongs to — set by the self-hosted
   * registration and carried by the platform sync (org-scoped readers key
   * on it).
   */
  cloudOrganizationId: z.string().optional(),
  resources: LocalAssistantResourcesSchema.optional(),
  /** Helper token for cloud assistants' API bearer; host-only secret. */
  bearerToken: z.string().optional(),
  /** PID of the file watcher process for docker instances hatched with --watch. */
  watcherPid: z.number().optional(),
  /** Local bootstrap secret used to lease guardian tokens for Docker assistants after detached hatch. */
  guardianBootstrapSecret: z.string().optional(),
  /** Docker image metadata for rollback. Only present for docker topology entries. */
  containerInfo: ContainerInfoSchema.optional(),
  /** Management socket path for apple-container assistants; written by the macOS host. */
  mgmtSocket: z.string().optional(),
  /**
   * Client-minted uuid (web's temp-client-id pattern) the CLI addresses this
   * assistant's chat conversation by. Minted once on first `cadet client`
   * launch and persisted so every session shares one conversation.
   */
  conversationKey: z.string().optional(),
});

/**
 * A validated, normalized assistant entry. `cloud` is always present (the
 * schema's `catch` defaults absent and unknown on-disk values to "local"), so
 * readers never special-case its absence.
 */
export type LockfileAssistant = z.infer<typeof LockfileAssistantSchema>;

/**
 * A CLI-managed OS process recorded at the lockfile root under `tunnel`:
 * the auto-tunnel agent fronting the edge. `cadet ps` renders it alongside
 * the per-assistant process trees, and the stop paths verify the pid before
 * signaling it.
 */
export const TunnelProcessRecordSchema = z.object({
  pid: z.number(),
  /** Which tunnel provider owns the process. */
  provider: z.enum(TUNNEL_PROVIDERS),
  startedAt: z.string(),
  /** The public URL the tunnel agent serves. */
  publicUrl: z.string().optional(),
});
export type TunnelProcessRecord = z.infer<typeof TunnelProcessRecordSchema>;

/**
 * A CLI-managed OS process recorded at the lockfile root under `app`: the
 * nginx ingress edge (web artifacts, `/v1` proxying, the outer shell).
 * Shares nothing with the tunnel record beyond the pid bookkeeping — a
 * tunnel serves a URL, the edge serves a port.
 */
export const AppProcessRecordSchema = z.object({
  /** The edge process's bookkeeping, present while the edge runs. */
  pid: z.number().optional(),
  startedAt: z.string().optional(),
  /** Listening port for the nginx edge. */
  port: z.number(),
  /**
   * The commit the edge's source-built client bundles were last built from
   * — the auto-build staleness stamp. Rides the running edge's record: a
   * build only stamps when an edge record exists to carry it.
   */
  builtSha: z.string().optional(),
});
export type AppProcessRecord = z.infer<typeof AppProcessRecordSchema>;

/**
 * Renderer-facing result of a lockfile write, returned across the host bridge.
 * Carries no HTTP-style status — hosts map that away because the renderer
 * surfaces failures by message alone.
 */
export type LockfileWriteResult =
  | { ok: true; lockfile: Lockfile }
  | { ok: false; error: string };

export const LockfileSchema = z.looseObject({
  assistants: z
    .array(LockfileAssistantSchema.nullable().catch(null))
    .catch([])
    .transform((entries) =>
      entries.filter((entry): entry is LockfileAssistant => entry !== null),
    ),
  activeAssistant: z.union([z.string(), z.null()]).catch(null),
  tunnel: TunnelProcessRecordSchema.optional().catch(undefined),
  app: AppProcessRecordSchema.optional().catch(undefined),
});

/**
 * A validated, normalized lockfile — this schema's own output. Loose at the
 * root so the CLI's read-modify-write round-trip preserves the root keys it
 * owns (`cloudBaseUrl`) and anything a newer writer added; readers key on the
 * modeled fields.
 */
export type Lockfile = z.infer<typeof LockfileSchema>;

/**
 * Coerce parsed JSON into a validated {@link Lockfile}. Total and non-throwing:
 * the whole file parses through {@link LockfileSchema} — an entry that fails
 * validation is dropped whole (one malformed entry can't discard the file), a
 * missing or non-array `assistants` becomes `[]`, a non-string
 * `activeAssistant` becomes null, and a non-object root becomes an empty
 * lockfile.
 */
export function parseLockfile(raw: unknown): Lockfile {
  const parsed = LockfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : LockfileSchema.parse({});
}
