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
 * What a host stamps into a served document before parsing is in play: the
 * recorded `remote` may be omitted outright (the schema's parse-time
 * default answers for it) — the edge stamps the truthful recorded kind or
 * nothing, never a served-spelling alias.
 */
export type InjectedConfigStamp = Omit<InjectedConfig, "remote"> & {
  remote?: Remote;
};

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
  if (
    entry.cloud === "local" ||
    entry.cloud === "docker" ||
    entry.cloud === "apple-container"
  ) {
    return entry.resources?.gatewayPort;
  }
  return undefined;
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
  // Baseten: the gateway rides the sandbox API server's `/port/<PORT>/` route.
  if (entry.cloud === "baseten") {
    return `${entry.sandboxUrl.replace(/\/+$/, "")}/port/${entry.port}`;
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
 * The fields every topology actually uses: the identity every reader looks
 * entries up by, the display name, and the hatch/onboarding/conversation
 * bookkeeping that is topology-agnostic.
 */
const BaseAssistantSchema = z.object({
  assistantId: z.string(),
  name: z.string().optional(),
  hatchedAt: z.string().optional(),
  /**
   * When this assistant finished first-run onboarding. Absent for entries that
   * predate the record, which fall back to hatch age (see the web client's
   * `onboarded-assistant.ts`).
   */
  onboardedAt: z.string().optional(),
  /**
   * Client-minted uuid (web's temp-client-id pattern) the CLI addresses this
   * assistant's chat conversation by. Minted once on first `cadet client`
   * launch and persisted so every session shares one conversation.
   */
  conversationKey: z.string().optional(),
});

/**
 * The fields the self-hosted, on-machine topologies (local, docker,
 * apple-container) share: host-recorded ports and instance dir, the bearer
 * helper token, and the platform self-hosted registration the login flow
 * stamps onto whichever runtime is active.
 */
const LocalRuntimeAssistantFields = {
  resources: LocalAssistantResourcesSchema.optional(),
  /** Helper token for the assistant API bearer; host-only secret. */
  bearerToken: z.string().optional(),
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
};

/** A plain on-machine assistant: host-managed ports and instance dir. */
const LocalAssistantSchema = BaseAssistantSchema.extend({
  ...LocalRuntimeAssistantFields,
  cloud: z.literal("local"),
  /** Bootstrap secret used to lease guardian tokens after detached hatch. */
  guardianBootstrapSecret: z.string().optional(),
});

/** A docker-hosted assistant: container metadata for rollback/upgrade. */
const DockerAssistantSchema = BaseAssistantSchema.extend({
  ...LocalRuntimeAssistantFields,
  cloud: z.literal("docker"),
  /** Docker image metadata for rollback. Only present for docker topology entries. */
  containerInfo: ContainerInfoSchema.optional(),
  /** Bootstrap secret used to lease guardian tokens after detached hatch. */
  guardianBootstrapSecret: z.string().optional(),
  /** PID of the file watcher process for docker instances hatched with --watch. */
  watcherPid: z.number().optional(),
});

/** An apple-container assistant, driven through its management socket. */
const AppleContainerAssistantSchema = BaseAssistantSchema.extend({
  ...LocalRuntimeAssistantFields,
  cloud: z.literal("apple-container"),
  /** Management socket path for apple-container assistants; written by the macOS host. */
  mgmtSocket: z.string().optional(),
});

/** A platform-hosted assistant, registered against the cloud API. */
const CloudAssistantSchema = BaseAssistantSchema.extend({
  cloud: z.literal("cloud"),
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
  /** Helper token for the assistant API bearer; host-only secret. */
  bearerToken: z.string().optional(),
});

/** A self-hosted remote assistant, reached at its own address. */
const CustomAssistantSchema = BaseAssistantSchema.extend({
  cloud: z.literal("custom"),
  /** Host address of the custom remote's gateway. */
  ipAddress: z.string().optional(),
  /** Gateway port on the custom remote. */
  port: z.number().optional(),
});

/**
 * A Baseten sandbox entry: the sandbox server URL and the sandbox-internal
 * gateway port are pinned at creation, so every reader can address
 * `{sandboxUrl}/port/{port}` without a fallback.
 */
const BasetenAssistantSchema = BaseAssistantSchema.extend({
  cloud: z.literal("baseten"),
  /** The Baseten sandbox server URL; the gateway rides `{sandboxUrl}/port/{port}`. */
  sandboxUrl: z.string(),
  /** The sandbox-internal gateway port, piped in as `GATEWAY_PORT` at creation. */
  port: z.number(),
});

/**
 * Route absent and unknown topology values to the local default before the
 * union discriminates, keeping the on-disk contract permissive about clouds
 * this build has never heard of.
 */
function withDefaultCloud(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null) return entry;
  const cloud = "cloud" in entry ? entry.cloud : undefined;
  if (typeof cloud === "string" && RemoteSchema.safeParse(cloud).success) {
    return entry;
  }
  return { ...entry, cloud: "local" };
}

export const LockfileAssistantSchema = z.preprocess(
  withDefaultCloud,
  z.discriminatedUnion("cloud", [
    LocalAssistantSchema,
    DockerAssistantSchema,
    AppleContainerAssistantSchema,
    CloudAssistantSchema,
    CustomAssistantSchema,
    BasetenAssistantSchema,
  ]),
);

/**
 * A validated, normalized assistant entry — a discriminated union on
 * `cloud`, so each topology carries exactly the fields it uses: a baseten
 * entry's `sandboxUrl`/`port` are always defined, a docker entry's
 * `containerInfo` reads without touching unrelated topologies, and absent or
 * unknown on-disk clouds route to the local branch.
 */
export type LockfileAssistant = z.infer<typeof LockfileAssistantSchema>;

/** The local entry shape (cloud "local"). */
export type LocalAssistant = z.infer<typeof LocalAssistantSchema>;
/** The docker entry shape (cloud "docker"). */
export type DockerAssistant = z.infer<typeof DockerAssistantSchema>;
/** The apple-container entry shape (cloud "apple-container"). */
export type AppleContainerAssistant = z.infer<
  typeof AppleContainerAssistantSchema
>;
/** The cloud entry shape (cloud "cloud"). */
export type CloudAssistant = z.infer<typeof CloudAssistantSchema>;
/** The custom remote entry shape (cloud "custom"). */
export type CustomAssistant = z.infer<typeof CustomAssistantSchema>;
/** The baseten sandbox entry shape (cloud "baseten"). */
export type BasetenAssistant = z.infer<typeof BasetenAssistantSchema>;

/**
 * The topologies whose gateway runs on this machine with host-recorded
 * `resources`: local, docker, and apple-container.
 */
export type LocalRuntimeAssistant = Exclude<
  LockfileAssistant,
  { cloud: "custom" | "cloud" | "baseten" }
>;

/** Whether the entry's gateway runs on this machine with host `resources`. */
export function isLocalRuntimeEntry(
  entry: LockfileAssistant,
): entry is LocalRuntimeAssistant {
  return (
    entry.cloud === "local" ||
    entry.cloud === "docker" ||
    entry.cloud === "apple-container"
  );
}

/** Whether the entry is a docker-hosted assistant. */
export function isDockerEntry(
  entry: LockfileAssistant,
): entry is DockerAssistant {
  return entry.cloud === "docker";
}

/** Whether the entry is an apple-container assistant. */
export function isAppleContainerEntry(
  entry: LockfileAssistant,
): entry is AppleContainerAssistant {
  return entry.cloud === "apple-container";
}

/** Whether the entry is a plain on-machine assistant. */
export function isLocalEntry(
  entry: LockfileAssistant,
): entry is LocalAssistant {
  return entry.cloud === "local";
}

/**
 * The platform self-hosted registration the login flows stamp, plus the
 * recorded runtime version for the on-machine topologies. Identity-only:
 * no secrets, no addresses. Custom and baseten remotes are never registered.
 */
export function registrationSummary(entry: LockfileAssistant): {
  cloudAssistantId?: string;
  cloudBaseUrl?: string;
  cloudOrganizationId?: string;
  runtimeVersion?: string;
} {
  if (entry.cloud === "custom" || entry.cloud === "baseten") return {};
  return {
    cloudAssistantId: entry.cloudAssistantId,
    cloudBaseUrl: entry.cloudBaseUrl,
    cloudOrganizationId: entry.cloudOrganizationId,
    runtimeVersion: isLocalRuntimeEntry(entry)
      ? entry.resources?.runtimeVersion
      : undefined,
  };
}

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
