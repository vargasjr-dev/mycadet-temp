import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { dirname, join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { GATEWAY_PORT } from "../constants.js";
import {
  clearRootProcess,
  readRootProcesses,
  stampRootProcess,
  type TunnelProcessRecord,
} from "../assistant-config.js";
import { ensureBinaryInstalled, readLineText } from "../ensure-binary.js";
import {
  clearIngressUrl,
  getDefaultWorkspaceDir,
  loadRawConfig,
  saveIngressUrl,
} from "../ingress-config.js";
import { getConfigDir } from "../environments/paths.js";
import { getCurrentEnvironment } from "../environments/resolve.js";
import { cliCommand } from "../cli-name.js";
import { loopbackSafeFetch } from "../loopback-fetch.js";
import { readProcessCommandLine, stopProcess } from "../process.js";
import { z } from "zod";
import { stopOwnedTunnelAgent } from "./process-lifecycle.js";
import type {
  TunnelProvider,
  ProviderMeta,
  ProviderTunnelResult,
  TunnelStartOptions,
} from "../tunnel.js";
import { notifyGatewayOfPublicUrl } from "./gateway-notify.js";

const NGROK_DEFAULT_API_ADDR = "127.0.0.1:4040";
const NGROK_API_URL = `http://${NGROK_DEFAULT_API_ADDR}/api/tunnels`;
const NGROK_POLL_INTERVAL_MS = 500;
const NGROK_POLL_TIMEOUT_MS = 15_000;

/**
 * Inspection-port band for agents this CLI starts beyond the first. ngrok's
 * web interface/API port (`web_addr`) is config-file only — it cannot be set
 * on the command line — so a second concurrent agent needs its own address
 * layered in through a config file. Ports 4041-4049 sit next to ngrok's
 * default 4040 and away from the environment port blocks.
 */
const NGROK_SECONDARY_ADDR_CANDIDATES = Array.from(
  { length: 9 },
  (_, i) => `127.0.0.1:${4041 + i}`,
);

const NgrokTunnelSchema = z.object({
  public_url: z.string(),
  config: z
    .object({
      addr: z.string().optional(),
    })
    .optional(),
});

type NgrokTunnel = z.infer<typeof NgrokTunnelSchema>;

const NgrokTunnelsResponseSchema = z.object({
  tunnels: z.array(NgrokTunnelSchema).optional(),
});

/**
 * The ingress block of the workspace config, as read by the app server:
 * explicitly enabled with a saved public URL.
 */
export const IngressConfigSchema = z.object({
  enabled: z.boolean().optional(),
  publicBaseUrl: z.string().optional(),
});

/** Per-provider copy `cadet tunnel`'s help renders for ngrok. */
export const NGROK_TUNNEL_META: ProviderMeta = {
  reach: "Public tunnel that webhook integrations can reach",
  install: "install: brew install ngrok/ngrok/ngrok",
  domainExample: "my-assistant.ngrok.app",
  supportsReservedDomain: true,
};

/**
 * Check whether ngrok is installed and accessible on the PATH.
 * Returns the version string if installed, null otherwise.
 */
export function getNgrokVersion(): string | null {
  try {
    const output = execFileSync("ngrok", ["version"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return output.trim();
  } catch {
    return null;
  }
}

/** Whether captured agent output says the startup failure was authentication. */
export function isNgrokAuthError(output: string): boolean {
  return /authtoken|authenticat|unauthorized|usage limit|ERR_NGROK_10\d\d|ERR_NGROK_40\d\d/i.test(
    output,
  );
}

/**
 * Whether the agent was refused because the account is already running its
 * plan's maximum of concurrent agent sessions. Checked before the auth-error
 * path (whose regex also matches ERR_NGROK_108), because the recovery is
 * different: pasting an authtoken cannot fix a session-count limit.
 */
export function isNgrokSessionLimitError(output: string): boolean {
  return /simultaneous ngrok agent sessions|ERR_NGROK_108/i.test(output);
}

/**
 * Whether the agent was refused because the endpoint it tried to claim is
 * already online. On the free plan a bare `ngrok http` reuses the account's
 * single assigned dev domain, so any other running agent — including a
 * leftover one from an earlier run — holds the domain the fresh agent needs.
 * Checked before the auth-error path, whose recovery cannot fix a held
 * domain.
 */
export function isNgrokEndpointOnlineError(output: string): boolean {
  return /is already online|ERR_NGROK_334/i.test(output);
}

/**
 * The endpoint URL ngrok reported as already online, if named in the output
 * (e.g. the free plan's auto-assigned dev domain).
 */
export function ngrokOnlineEndpoint(output: string): string | null {
  return output.match(/'(https:\/\/[^'\s]+)' is already online/i)?.[1] ?? null;
}

/** The host of an endpoint URL named in an ngrok error, if parseable. */
export function endpointHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
}

/** The answer to a stop-the-stale-tunnel confirmation: Enter and y/yes go, anything else stays. */
export function confirmStopAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}

/** An ngrok agent that exited during startup, with its captured output. */
export class NgrokStartupError extends Error {
  readonly exitCode: number;
  readonly output: string;

  constructor(exitCode: number, output: string) {
    super(`ngrok exited with code ${exitCode}`);
    this.exitCode = exitCode;
    this.output = output;
  }
}

/** Paste-in attempts before the tunnel command gives up and says how. */
const MAX_AUTH_RETRIES = 2;
/** Only one confirm-then-stop round for the endpoint-online collision. */
const MAX_STALE_STOPS = 1;

/**
 * Run `ngrok config add-authtoken <token>` — writing the user's default
 * ngrok config, which is exactly the config the tunnel spawn loads. The
 * token is never echoed: output is piped and any failure message has the
 * token scrubbed.
 */
export function saveNgrokAuthToken(token: string): boolean {
  try {
    execFileSync("ngrok", ["config", "add-authtoken", token], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `⚠ Couldn't save the authtoken: ${message.replaceAll(token, "***")}`,
    );
    return false;
  }
}

/**
 * Query an ngrok local API for running tunnels.
 * Returns the list of tunnels, or null if the API is unreachable.
 */
async function queryNgrokTunnels(
  apiUrl: string = NGROK_API_URL,
): Promise<NgrokTunnel[] | null> {
  try {
    const res = await loopbackSafeFetch(apiUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const parsed = NgrokTunnelsResponseSchema.safeParse(await res.json());
    return parsed.success ? (parsed.data.tunnels ?? []) : null;
  } catch {
    return null;
  }
}

/** A live ngrok agent seen through its local inspection API. */
interface NgrokAgentView {
  /** Base inspection address (`host:port`) the agent answers on. */
  apiAddr: string;
  tunnels: NgrokTunnel[];
}

/**
 * Every inspection address a relevant agent could be answering on: ngrok's
 * default, the one in the user's own ngrok config (they may have moved
 * `web_addr`), and the one recorded for agents this CLI started beyond the
 * first. Sibling environments' records are not read — their agents tunnel
 * their own edge ports, so the only thing a sibling agent can offer this
 * environment is a port to avoid, which the free-port probe handles.
 */
function agentAddrCandidates(): string[] {
  const candidates = [NGROK_DEFAULT_API_ADDR];
  const userWebAddr = readUserDefaultNgrokWebAddr();
  if (userWebAddr) candidates.push(userWebAddr);
  const recorded = readNgrokAgentConfigFile().web_addr;
  if (recorded) candidates.push(recorded);
  return [...new Set(candidates)];
}

/** Probe the known inspection addresses and return the live agents. */
async function discoverNgrokAgents(): Promise<NgrokAgentView[]> {
  const agents: NgrokAgentView[] = [];
  for (const addr of agentAddrCandidates()) {
    const tunnels = await queryNgrokTunnels(`http://${addr}/api/tunnels`);
    if (tunnels) agents.push({ apiAddr: addr, tunnels });
  }
  return agents;
}

/** Whether a tunnel targets the given local port, under any addr spelling. */
function tunnelTargetsPort(tunnel: NgrokTunnel, targetPort: number): boolean {
  const targetAddrs = [
    `localhost:${targetPort}`,
    `127.0.0.1:${targetPort}`,
    `http://localhost:${targetPort}`,
    `http://127.0.0.1:${targetPort}`,
  ];
  return targetAddrs.includes(tunnel.config?.addr ?? "");
}

/** Pick the tunnel for the target port (and domain, when set), HTTPS first. */
function pickMatchingTunnel(
  tunnels: NgrokTunnel[],
  targetPort: number,
  domain?: string,
): string | null {
  const matches = tunnels.filter(
    (t) =>
      tunnelTargetsPort(t, targetPort) &&
      (!domain || urlMatchesDomain(t.public_url, domain)),
  );
  const httpsTunnel = matches.find((t) => t.public_url.startsWith("https://"));
  if (httpsTunnel) return httpsTunnel.public_url;
  return matches.find((t) => t.public_url)?.public_url ?? null;
}

/** Render listed tunnels as `url -> addr` pairs for mismatch diagnostics. */
function describeTunnels(tunnels: NgrokTunnel[]): string {
  return tunnels
    .map((t) => `${t.public_url} -> ${t.config?.addr ?? "unknown target"}`)
    .join(", ");
}

/**
 * Find an already-running tunnel to adopt: an agent whose tunnels include
 * the target port (and the reserved domain, when one is requested). When an
 * agent tunnels the target port but under a different domain, that is
 * reported as a conflict — adopting it would silently drop the saved
 * reserved-domain intent.
 */
function findAdoptableTunnel(
  agents: NgrokAgentView[],
  targetPort: number,
  domain?: string,
): { url: string } | { conflict: string } | null {
  for (const agent of agents) {
    const portMatch = pickMatchingTunnel(agent.tunnels, targetPort);
    if (!portMatch) continue;
    if (domain && !urlMatchesDomain(portMatch, domain)) {
      return { conflict: portMatch };
    }
    return { url: portMatch };
  }
  return null;
}

/** Recovery copy for a saved domain whose reservation may have lapsed. */
function savedDomainRecoveryHint(domain: string): string {
  return `The saved ngrok domain '${domain}' (${ngrokConfigPath()}) may no longer be reserved. Run \`${cliCommand()} tunnel start --provider ngrok --clear-domain\` to drop it and tunnel without one.`;
}

const NGROK_TUNNEL_NAME = "cadet";

const NgrokTunnelDefSchema = z.looseObject({
  proto: z.string().optional(),
  addr: z.string().optional(),
  domain: z.string().optional(),
});

const NgrokConfigFileSchema = z.looseObject({
  version: z.string().optional(),
  tunnels: z.record(z.string(), NgrokTunnelDefSchema).optional(),
});

type NgrokConfigFile = z.infer<typeof NgrokConfigFileSchema>;
type NgrokTunnelDef = z.infer<typeof NgrokTunnelDefSchema>;

/**
 * The ngrok-format config file this CLI owns in the XDG config dir. It no
 * longer participates in spawning (plain `ngrok http` loads the user's
 * default config, keeping their authtoken in play); it is the source of
 * truth for the reserved domain at this layer — the workspace config no
 * longer records one.
 */
export function ngrokConfigPath(): string {
  return join(getConfigDir(getCurrentEnvironment()), "tunnels", "ngrok.yaml");
}

function readNgrokConfigFile(): NgrokConfigFile {
  const path = ngrokConfigPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = NgrokConfigFileSchema.safeParse(
      parseYaml(readFileSync(path, "utf-8")),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writeNgrokConfigFile(config: NgrokConfigFile): void {
  const path = ngrokConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(config));
}

/**
 * Persist a reserved ngrok domain in the XDG ngrok config; null clears it.
 *
 * The reserved domain is an ngrok reservation concept (cloudflare quick
 * tunnels and tailscale serve have no equivalent), which is why this lives in
 * the ngrok provider module rather than the shared ingress-config helpers.
 */
export function saveNgrokDomain(domain: string | null): void {
  const config = readNgrokConfigFile();
  const cadet: NgrokTunnelDef = {
    ...config.tunnels?.[NGROK_TUNNEL_NAME],
    proto: "http",
  };
  if (domain) {
    cadet.domain = domain;
  } else {
    delete cadet.domain;
  }
  const tunnels: Record<string, NgrokTunnelDef> = { ...config.tunnels };
  tunnels[NGROK_TUNNEL_NAME] = cadet;
  const next: NgrokConfigFile = { ...config, version: config.version ?? "2" };
  next.tunnels = tunnels;
  writeNgrokConfigFile(next);
}

/** Read the reserved ngrok domain from the XDG ngrok config, if saved. */
export function loadNgrokDomain(): string | null {
  const domain = readNgrokConfigFile().tunnels?.[NGROK_TUNNEL_NAME]?.domain;
  return domain?.trim() ? domain : null;
}

const NgrokAgentConfigFileSchema = z.looseObject({
  web_addr: z.string().optional(),
});

type NgrokAgentConfigFile = z.infer<typeof NgrokAgentConfigFileSchema>;

/**
 * The config file recording the inspection address (`web_addr`) of an agent
 * this CLI started beyond the first. Distinct from `ngrok.yaml`, which stays
 * out of spawning entirely — this one is ONLY fed to layered `--config`
 * spawns, where the user's default config is loaded first so their authtoken
 * stays in play and this file's `web_addr` wins on top of it.
 */
export function ngrokAgentConfigPath(): string {
  return join(
    getConfigDir(getCurrentEnvironment()),
    "tunnels",
    "ngrok-agent.yaml",
  );
}

function readNgrokAgentConfigFile(): NgrokAgentConfigFile {
  const path = ngrokAgentConfigPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = NgrokAgentConfigFileSchema.safeParse(
      parseYaml(readFileSync(path, "utf-8")),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Persist the inspection address for the next secondary-agent spawn. */
function writeNgrokAgentConfig(webAddr: string): string {
  const path = ngrokAgentConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml({ version: "2", web_addr: webAddr }));
  return path;
}

/**
 * Resolve the user's default ngrok config path with `ngrok config check`.
 * Null when it can't be determined — the layered secondary spawn then runs
 * without it, and an authentication failure is recovered by the usual
 * paste-in flow (which writes the default config the next attempt layers).
 */
function resolveNgrokDefaultConfigPath(): string | null {
  try {
    const output = execFileSync("ngrok", ["config", "check"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return (
      output.match(/Valid configuration file at (.+)/)?.[1]?.trim() ?? null
    );
  } catch {
    return null;
  }
}

/**
 * The `web_addr` from the user's default ngrok config, when they moved the
 * inspection interface off the default port — an agent there would otherwise
 * be invisible to discovery.
 */
function readUserDefaultNgrokWebAddr(): string | null {
  const configPath = resolveNgrokDefaultConfigPath();
  if (!configPath || !existsSync(configPath)) return null;
  try {
    const parsed = NgrokAgentConfigFileSchema.safeParse(
      parseYaml(readFileSync(configPath, "utf-8")),
    );
    const webAddr = parsed.success ? parsed.data.web_addr : undefined;
    // `web_addr: false` disables the interface; only a host:port answers.
    return webAddr && webAddr.includes(":") ? webAddr : null;
  } catch {
    return null;
  }
}

/**
 * Pick an inspection address for a second agent: the first candidate in the
 * 4041-4049 band that no discovered agent already answers on and that this
 * process can bind. Throws when the band is exhausted.
 */
async function pickFreeAgentAddr(agents: NgrokAgentView[]): Promise<string> {
  const taken = new Set(agents.map((a) => a.apiAddr));
  for (const addr of NGROK_SECONDARY_ADDR_CANDIDATES) {
    if (taken.has(addr)) continue;
    if (await isAddrBindable(addr)) return addr;
  }
  throw new Error(
    `no free ngrok inspection port in 4041-4049; stop an ngrok agent or free one of those ports and re-run.`,
  );
}

/** Whether this process can bind the given `host:port` on loopback. */
function isAddrBindable(addr: string): Promise<boolean> {
  const port = Number(addr.split(":").pop());
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** How a second agent (for an edge port no live agent tunnels) is started. */
interface SecondaryAgentPlan {
  webAddr: string;
  defaultConfigPath?: string;
  /** Where this run polls for the tunnel URL the new agent publishes. */
  apiUrl: string;
}

/**
 * Prepare a second ngrok agent: pick and record an inspection address, and
 * resolve the user's default config so the layered spawn keeps the authtoken
 * in play. Pure preparation — the caller spawns and reports.
 */
async function planSecondaryAgent(
  agents: NgrokAgentView[],
): Promise<SecondaryAgentPlan> {
  const webAddr = await pickFreeAgentAddr(agents);
  writeNgrokAgentConfig(webAddr);
  const defaultConfigPath = resolveNgrokDefaultConfigPath() ?? undefined;
  return {
    webAddr,
    defaultConfigPath,
    apiUrl: `http://${webAddr}/api/tunnels`,
  };
}

/**
 * Check whether a PID belongs to an ngrok process via its command line, so a
 * recorded pid is verified before it is signaled (PID reuse guard).
 */
export function isNgrokProcess(pid: number): boolean {
  try {
    return /ngrok/i.test(readProcessCommandLine(pid));
  } catch {
    return false;
  }
}

/**
 * Whether a root-lockfile tunnel record names a leftover ngrok agent this
 * run should stop before spawning its own: the record must be this CLI's
 * ngrok entry and the pid must still verify as an ngrok process (PID reuse
 * guard). A live agent that no live record names — one the user started
 * themselves — is left alone.
 */
export function staleTrackedNgrokAgent(
  record: TunnelProcessRecord | undefined,
  matchesPid: (pid: number) => boolean = isNgrokProcess,
): TunnelProcessRecord | null {
  if (!record || record.provider !== "ngrok") return null;
  if (!matchesPid(record.pid)) return null;
  return record;
}

/**
 * The pid listening on the given TCP port, via `lsof` (macOS/Linux).
 * Returns null when nothing is found or lsof is unavailable (e.g. win32).
 * Used to identify untracked ngrok holders: their inspection API names the
 * tunnel, but no lockfile record names their pid.
 */
export function pidListeningOnPort(port: number): number | null {
  try {
    const output = execFileSync(
      "lsof",
      ["-iTCP:" + port, "-sTCP:LISTEN", "-t"],
      {
        encoding: "utf-8",
        timeout: 3_000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    ).trim();
    // lsof -t may return multiple PIDs (one per line); take the first.
    const pid = Number(output.split("\n")[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Stop the leftover tracked ngrok agent after the user confirmed it. The
 * caller selects the record (staleTrackedNgrokAgent) and asks first — this
 * only runs once a yes came back. Returns the record on success, or null
 * when the stop did not go through (pid unverifiable, or the stop failed —
 * the fresh agent then surfaces ngrok's own refusal again).
 */
async function stopConfirmedNgrokAgent(
  stale: TunnelProcessRecord,
  assistantId: string | undefined,
  workspaceDir: string | undefined,
): Promise<TunnelProcessRecord | null> {
  try {
    const stopped = await stopOwnedTunnelAgent(
      { record: stale, assistantId, workspaceDir },
      isNgrokProcess,
      "ngrok",
    );
    if (!stopped) return null;
  } catch {
    return null;
  }
  // The recorded entry names the agent just stopped; a fresh spawn stamps a
  // new one.
  clearRootProcess("tunnel", stale.pid);
  return stale;
}

/**
 * The pid of the tracked ngrok agent holding the tunnel, for a caller OUTSIDE
 * the spawn loop — the detached tunnel process has no TTY, so the foreground
 * `cadet tunnel` command is where a confirm-first stop can ask. Returns null
 * when the lockfile names no live holder; externally started agents are never
 * touched.
 */
export async function ngrokHolderPid(
  matchesPid: (pid: number) => boolean = isNgrokProcess,
): Promise<number | null> {
  return (
    staleTrackedNgrokAgent(readRootProcesses().tunnel, matchesPid)?.pid ?? null
  );
}

/**
 * Stop the holder pid once the user confirmed it: verify it still names an
 * ngrok process (PID reuse guard), signal it, and drop the lockfile record
 * when it is the one being stopped. The caller asks first — this only runs
 * after a yes came back.
 */
export async function stopNgrokHolderPid(
  pid: number,
  matchesPid: (pid: number) => boolean = isNgrokProcess,
): Promise<boolean> {
  try {
    if (!matchesPid(pid)) return false;
    if (!(await stopProcess(pid, "tunnel ngrok agent"))) return false;
  } catch {
    return false;
  }
  const record = readRootProcesses().tunnel;
  if (record?.pid === pid) clearRootProcess("tunnel", pid);
  return true;
}

/**
 * Matches the adoption line the tunnel workflows print when they find an
 * already-running tunnel, so the detached-tunnel supervisor can detect
 * adoption without this module's implementation details leaking into the
 * command layer.
 */
export const ADOPTED_TUNNEL_RE = /Found existing ngrok tunnel: (\S+)/;

/** Whether a tunnel public URL's host equals the given reserved domain. */
function urlMatchesDomain(publicUrl: string, domain: string): boolean {
  try {
    return (
      new URL(publicUrl).hostname.toLowerCase() === domain.trim().toLowerCase()
    );
  } catch {
    return false;
  }
}

/** The argv for an ngrok agent forwarding the edge port, domain when set. */
export function buildNgrokSpawnArgs(
  targetPort: number,
  domain?: string,
  secondaryAgent?: { webAddr: string; defaultConfigPath?: string },
): string[] {
  const args = ["http", `127.0.0.1:${targetPort}`, "--log=stdout"];
  if (domain) {
    args.push(`--domain=${domain}`);
  }
  if (secondaryAgent) {
    // ngrok's `web_addr` cannot be set on the command line, so the second
    // agent layers config files: the user's default first (authtoken stays
    // in play — a bare --config would replace it), ours last (web_addr wins).
    if (secondaryAgent.defaultConfigPath) {
      args.push(`--config=${secondaryAgent.defaultConfigPath}`);
    }
    args.push(`--config=${ngrokAgentConfigPath()}`);
  }
  return args;
}

/**
 * Start an ngrok process tunneling HTTP traffic to the given local port.
 *
 * Plain `ngrok http` is spawned deliberately: ngrok only loads the user's
 * default config — where `ngrok config add-authtoken` writes — when no
 * `--config` is passed, so this is what keeps the authtoken in play. The
 * explicit `127.0.0.1:` host avoids a bare port, which ngrok expands to
 * `localhost`, whose ::1 answer resolves first on macOS and races the edge's
 * IPv4 bind.
 *
 * When `logFilePath` is provided, stdout/stderr are redirected to that file
 * instead of being piped. This avoids keeping pipe handles open in the
 * parent process — which would either prevent the CLI from exiting (if
 * handles are left open) or send SIGPIPE to ngrok (if destroyed).
 *
 * When `domain` is set, the spawned tunnel binds that reserved ngrok domain.
 *
 * Returns the spawned child process.
 */
export function startNgrokProcess(
  targetPort: number,
  logFilePath?: string,
  domain?: string,
  secondaryAgent?: { webAddr: string; defaultConfigPath?: string },
): ChildProcess {
  let stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe"];
  let fd: number | undefined;
  if (logFilePath) {
    const dir = dirname(logFilePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    fd = openSync(logFilePath, "a");
    stdio = ["ignore", fd, fd];
  }

  const child = spawn(
    "ngrok",
    buildNgrokSpawnArgs(targetPort, domain, secondaryAgent),
    {
      detached: true,
      stdio,
      windowsHide: true,
    },
  );

  // The child process inherits a duplicate of the fd via dup2, so the
  // parent's copy is no longer needed. Close it to avoid leaking the
  // file descriptor for the lifetime of the parent process.
  if (fd !== undefined) {
    closeSync(fd);
  }

  return child;
}

/**
 * Poll the ngrok local API until a tunnel appears for the target port (and
 * reserved domain, when one is requested), preferring HTTPS.
 * `apiUrl` targets a specific agent's inspection API — a second agent answers
 * on its own port, and the default only reaches the first agent on a machine.
 * Returns the public URL, or throws if the timeout is exceeded.
 */
export async function waitForNgrokUrl(
  targetPort: number,
  domain?: string,
  timeoutMs: number = NGROK_POLL_TIMEOUT_MS,
  apiUrl: string = NGROK_API_URL,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tunnels = await queryNgrokTunnels(apiUrl);
    if (tunnels && tunnels.length > 0) {
      const url = pickMatchingTunnel(tunnels, targetPort, domain);
      if (url) return url;
    }
    await new Promise((r) => setTimeout(r, NGROK_POLL_INTERVAL_MS));
  }
  throw new Error(
    `ngrok tunnel did not become available within ${timeoutMs / 1000}s. Check ngrok logs for errors.`,
  );
}

/**
 * Check whether an already-loaded workspace config has webhook-based
 * integrations (e.g. Telegram, Twilio) that require a public ingress URL.
 */
const TelegramIntegrationSchema = z.object({
  botUsername: z.unknown().optional(),
});

const TwilioIntegrationSchema = z.object({
  accountSid: z.unknown().optional(),
  phoneNumber: z.unknown().optional(),
});

export function hasWebhookIntegrations(
  config: Record<string, unknown>,
): boolean {
  const telegram = TelegramIntegrationSchema.safeParse(config.telegram);
  if (telegram.success && telegram.data.botUsername) return true;
  const twilio = TwilioIntegrationSchema.safeParse(config.twilio);
  if (twilio.success && (twilio.data.accountSid || twilio.data.phoneNumber)) {
    return true;
  }
  return false;
}

/**
 * Check whether the workspace at `workspaceDir` configures any webhook-based
 * integrations that require a public ingress URL. False when the config cannot
 * be read, so an unreadable workspace never blocks a caller.
 */
export function hasWebhookIntegrationsConfigured(
  workspaceDir: string,
): boolean {
  try {
    return hasWebhookIntegrations(loadRawConfig(workspaceDir));
  } catch {
    return false;
  }
}

/**
 * Check whether a non-ngrok ingress URL is already configured (e.g. custom
 * domain or cloud deployment), meaning ngrok is not needed.
 */
function hasNonNgrokIngressUrl(workspaceDir: string): boolean {
  try {
    const config = loadRawConfig(workspaceDir);
    const parsed = IngressConfigSchema.safeParse(config.ingress);
    const publicBaseUrl = parsed.success
      ? parsed.data.publicBaseUrl
      : undefined;
    if (!publicBaseUrl) return false;
    return !publicBaseUrl.includes("ngrok");
  } catch {
    return false;
  }
}

/**
 * Auto-start an ngrok tunnel if webhook integrations are configured and no
 * non-ngrok ingress URL is present. Designed to be called during daemon/gateway
 * startup. Non-fatal: if ngrok is unavailable or fails, startup continues.
 *
 * `assistantId` records what the tunnel fronts. Without it, an automatic start
 * would leave `ingress.assistantId` absent or stale from an earlier run.
 *
 * Returns the spawned ngrok child process (for PID tracking) or null.
 */
export async function maybeStartNgrokTunnel(
  targetPort: number,
  workspaceDir: string,
  assistantId?: string,
): Promise<ChildProcess | null> {
  // Managed/containerized deployments route webhooks through the cloud's
  // callback proxy. ngrok is not needed and would not be reachable from the
  // platform anyway — skip it entirely.
  const isContainerized =
    process.env.IS_CONTAINERIZED === "true" ||
    process.env.IS_CONTAINERIZED === "1";
  if (isContainerized) return null;
  if (!hasWebhookIntegrationsConfigured(workspaceDir)) return null;
  if (hasNonNgrokIngressUrl(workspaceDir)) return null;

  const version = getNgrokVersion();
  if (!version) return null;

  const savedDomain = loadNgrokDomain() ?? undefined;

  // Reuse an existing tunnel if one is already running
  const agents = await discoverNgrokAgents();
  const adoptable = findAdoptableTunnel(agents, targetPort, savedDomain);
  if (adoptable && "conflict" in adoptable) {
    // Spawning a second agent would tunnel the same edge under a different
    // domain, and saving the mismatched URL would clobber the
    // reserved-domain intent. Leave the tunnel running but refuse to bless
    // it in config.
    console.warn(
      `   ⚠ Existing ngrok tunnel ${adoptable.conflict} does not match the reserved domain '${savedDomain}'. Ignoring it. Stop the running ngrok agent and run \`${cliCommand()} tunnel start --provider ngrok --domain ${savedDomain}\` to bind the reserved domain.`,
    );
    return null;
  }
  if (adoptable) {
    const existingUrl = adoptable.url;
    console.log(`   Found existing ngrok tunnel: ${existingUrl}`);
    saveIngressUrl(workspaceDir, existingUrl, assistantId, "ngrok");
    await notifyGatewayOfPublicUrl(existingUrl, assistantId);
    // The adopted tunnel belongs to some other agent we do not own a pid for,
    // so any recorded tunnel process entry would be stale from here on.
    clearRootProcess("tunnel");
    return null;
  }

  // A live agent that tunnels a different local port is not a blocker: ngrok
  // supports concurrent agents, so start one more for this edge. When that
  // fresh agent is refused because the free plan's single dev domain is
  // already online, the spawn failure surfaces it — this daemon context has
  // no user attached to confirm stopping the other agent.
  const secondaryAgent =
    agents.length > 0 ? await planSecondaryAgent(agents) : undefined;

  console.log(`   Starting ngrok tunnel for webhook integrations...`);

  // Spawn ngrok with stdout/stderr redirected to a log file instead of pipes.
  // This avoids two problems that occur with piped stdio:
  //   1. If pipe handles are left open, the CLI process hangs after hatch/wake.
  //   2. If pipe handles are destroyed, SIGPIPE kills ngrok on its next write.
  // Writing to a log file sidesteps both issues — the file descriptor is
  // inherited by the detached ngrok process and remains valid after CLI exit.
  const ngrokLogPath = join(workspaceDir, "data", "logs", "ngrok.log");
  const ngrokProcess = startNgrokProcess(
    targetPort,
    ngrokLogPath,
    savedDomain,
    secondaryAgent,
  );
  ngrokProcess.unref();

  try {
    const publicUrl = await waitForNgrokUrl(
      targetPort,
      savedDomain,
      NGROK_POLL_TIMEOUT_MS,
      secondaryAgent?.apiUrl,
    );
    saveIngressUrl(workspaceDir, publicUrl, assistantId, "ngrok");
    await notifyGatewayOfPublicUrl(publicUrl, assistantId);
    if (ngrokProcess.pid) {
      stampRootProcess("tunnel", {
        pid: ngrokProcess.pid,
        provider: "ngrok",
        startedAt: new Date().toISOString(),
        publicUrl,
      });
    }
    console.log(`   Tunnel established: ${publicUrl}`);

    return ngrokProcess;
  } catch {
    console.warn(
      `   ⚠ Could not start ngrok tunnel. Webhook integrations may not work until you run \`${cliCommand()} tunnel start --provider ngrok\`.`,
    );
    if (savedDomain) {
      console.warn(`   ⚠ ${savedDomainRecoveryHint(savedDomain)}`);
    }
    if (!ngrokProcess.killed) ngrokProcess.kill("SIGTERM");
    clearRootProcess("tunnel");
    return null;
  }
}

export interface RunNgrokTunnelOptions {
  /** Local edge port to forward. Defaults to the global GATEWAY_PORT. */
  port?: number;
  /** Workspace directory for config read/write. Defaults to ~/.cadet/workspace. */
  workspaceDir?: string;
  /** Lockfile entry to mirror the ingress URL onto (`ingressUrl`). */
  assistantId?: string;
  /**
   * Reserved ngrok domain to bind. Persisted so wake restores reuse it.
   * When omitted, a previously saved domain is reused without being rewritten.
   */
  domain?: string;
}

/**
 * Run the ngrok tunnel workflow: check installation, find or start a tunnel,
 * and save the public URL to config. Hands the URL back so the tunnel level
 * can notify the gateway of it; `waitForExit` settles when the run ends
 * (process exit, signal, or detach).
 */
export async function runNgrokTunnel(
  opts: RunNgrokTunnelOptions = {},
): Promise<ProviderTunnelResult> {
  const version = await ensureBinaryInstalled({
    binary: "ngrok",
    purpose: "the ngrok tunnel",
    packages: {
      brew: ["brew", "install", "ngrok/ngrok/ngrok"],
      snap: ["sudo", "snap", "install", "ngrok"],
      choco: ["choco", "install", "-y", "ngrok"],
      winget: [
        "winget",
        "install",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "ngrok.ngrok",
      ],
    },
    manualHint: "See https://ngrok.com/download for how to install",
    probe: getNgrokVersion,
  });
  if (!version) {
    process.exit(1);
  }

  console.log(`Using ${version}`);

  const workspaceDir = opts.workspaceDir ?? getDefaultWorkspaceDir();
  const port = opts.port ?? GATEWAY_PORT;

  // The saved domain is standing intent: a run without --domain reuses it,
  // and only an explicit --domain rewrites it.
  const domain = opts.domain ?? loadNgrokDomain() ?? undefined;
  if (domain && !opts.domain) {
    console.log(`Using saved ngrok domain: ${domain}`);
  }

  // Check for an existing ngrok tunnel pointing at the local edge
  const agents = await discoverNgrokAgents();
  const adoptable = findAdoptableTunnel(agents, port, domain);
  if (adoptable && "conflict" in adoptable) {
    console.error(
      `Error: an ngrok tunnel is already running on port ${port} at ${adoptable.conflict}, which does not match the ${opts.domain ? "requested" : "saved"} domain '${domain}'.`,
    );
    console.error(
      "Stop the existing ngrok agent first, then re-run this command to bind the reserved domain.",
    );
    process.exit(1);
  }
  if (adoptable) {
    const existingUrl = adoptable.url;
    console.log(`Found existing ngrok tunnel: ${existingUrl}`);
    saveIngressUrl(workspaceDir, existingUrl, opts.assistantId, "ngrok");
    // Not our child process: a recorded entry would be stale or foreign.
    clearRootProcess("tunnel");
    if (opts.domain) {
      saveNgrokDomain(opts.domain);
    }
    console.log("Ingress URL saved to config.");
    console.log("");
    console.log(
      `An ngrok agent from an earlier run is still up serving 127.0.0.1:${port} (${existingUrl}) — this run adopts it instead of starting a new agent.`,
    );
    console.log(
      "Adopted agents do not appear in `cadet ps` because this run does not own the process.",
    );
    console.log("Press Ctrl+C to detach (tunnel stays active).");

    // Block until SIGINT/SIGTERM
    const waitForExit = new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
      process.on("SIGTERM", () => resolve());
    });
    return { publicUrl: existingUrl, waitForExit };
  }

  // A live agent tunneling a different local port is not a blocker: ngrok
  // supports concurrent agents, so start one more for this edge.
  const secondary =
    agents.length > 0 ? await planSecondaryAgent(agents) : undefined;
  if (secondary) {
    console.log(
      `Another ngrok agent is already running (${describeTunnels(
        agents.flatMap((a) => a.tunnels),
      )}) — starting a second agent for this tunnel on inspection port ${secondary.webAddr.split(":").pop()}.`,
    );
  }

  console.log(`Starting ngrok tunnel to localhost:${port}...`);

  let publicUrl: string | undefined;
  // Points at the live agent across auth retries; signals and cleanup act on
  // whichever attempt is current.
  let currentNgrok: ChildProcess | null = null;
  let authAttempts = 0;
  // Confirm-and-stop rounds spent on the endpoint-online collision.
  let staleAttempts = 0;

  const cleanup = () => {
    if (currentNgrok && !currentNgrok.killed) {
      currentNgrok.kill("SIGTERM");
    }
    clearRootProcess("tunnel");
    if (publicUrl) {
      console.log("\nClearing ingress URL from config...");
      clearIngressUrl(workspaceDir);
    }
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  while (publicUrl === undefined) {
    const ngrokProcess = startNgrokProcess(port, undefined, domain, secondary);
    currentNgrok = ngrokProcess;

    // Captured per attempt so an authentication failure can be told apart
    // from other startup failures and recovered with a pasted-in token.
    const ngrokOutput: string[] = [];

    ngrokProcess.on("error", (err: Error) => {
      console.error(`ngrok process error: ${err.message}`);
      process.exit(1);
    });

    // Pipe ngrok stdout/stderr to console for visibility
    ngrokProcess.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        ngrokOutput.push(line);
        console.log(`[ngrok] ${line}`);
      }
    });
    ngrokProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        ngrokOutput.push(line);
        console.error(`[ngrok] ${line}`);
      }
    });

    // An agent that exits during startup rejects this instead of leaving
    // waitForNgrokUrl to poll a dead API for its full timeout.
    const exitFailure = new Promise<never>((_, reject) => {
      ngrokProcess.on("exit", (code: number | null) => {
        if (code !== null && code !== 0) {
          reject(new NgrokStartupError(code, ngrokOutput.join("\n")));
        }
      });
    });

    let url: string;
    try {
      url = await Promise.race([
        waitForNgrokUrl(port, domain, NGROK_POLL_TIMEOUT_MS, secondary?.apiUrl),
        exitFailure,
      ]);
    } catch (err) {
      if (
        err instanceof NgrokStartupError &&
        isNgrokEndpointOnlineError(err.output)
      ) {
        const endpoint = ngrokOnlineEndpoint(err.output);
        // The free plan's single dev domain is held by another running
        // agent. Ask before stopping it. A tracked agent comes from the
        // lockfile record; an untracked one (started before this CLI
        // tracked tunnel processes, or adopted and cleared) is identified
        // through its own inspection API plus the verified ngrok process
        // behind that port. A process that cannot be identified is never
        // touched.
        const stale = staleTrackedNgrokAgent(readRootProcesses().tunnel);
        const stalePid = stale?.pid ?? null;
        const interactive = "isTTY" in process.stdin && process.stdin.isTTY;
        if (
          stalePid !== null &&
          interactive &&
          staleAttempts < MAX_STALE_STOPS
        ) {
          staleAttempts++;
          console.error(
            `\nngrok refused the tunnel: ${endpoint ?? "the ngrok endpoint"} is already online.`,
          );
          console.error(
            `An ngrok agent from an earlier run (pid ${stalePid}) is holding your free ngrok domain.`,
          );
          const answer = await readLineText(
            "Stop the other ngrok tunnel and start a new one pointing at this installation? [Y/n] ",
          );
          if (confirmStopAnswer(answer)) {
            const stopped = await stopConfirmedNgrokAgent(
              stale!,
              opts.assistantId,
              workspaceDir,
            );
            if (stopped) {
              console.log(
                "Stopped the old ngrok agent. Retrying the tunnel...",
              );
              continue;
            }
            console.error(
              `Could not stop the old ngrok agent (pid ${stalePid}). Stop it yourself and re-run this command.`,
            );
          } else {
            console.error(
              "Keeping the other ngrok agent. Stop it yourself (its terminal, or `pkill ngrok`) and re-run this command.",
            );
          }
        } else {
          console.error(
            `\nngrok rejected the tunnel: ${endpoint ?? "its endpoint"} is already online.`,
          );
          console.error(
            "Your free ngrok domain is held by another running ngrok agent. Stop that agent (its terminal, or `pkill ngrok`) and re-run, pass a different reserved domain with --domain, or upgrade the ngrok plan.",
          );
        }
        process.exit(1);
      }
      if (
        err instanceof NgrokStartupError &&
        isNgrokSessionLimitError(err.output)
      ) {
        console.error(
          "\nngrok rejected the tunnel: this account is at its limit of concurrent agent sessions.",
        );
        console.error(
          "Stop another running ngrok agent (see: https://dashboard.ngrok.com/agents) or upgrade the ngrok plan, then re-run this command.",
        );
        process.exit(1);
      }
      if (err instanceof NgrokStartupError && isNgrokAuthError(err.output)) {
        if (authAttempts >= MAX_AUTH_RETRIES) {
          console.error("\nngrok still rejects the tunnel as unauthenticated.");
          console.error(
            "Authenticate manually: ngrok config add-authtoken <your-token>",
          );
          console.error(
            "  Get your token at: https://dashboard.ngrok.com/get-started/your-authtoken",
          );
          process.exit(1);
        }
        console.log("");
        console.log("⚠ ngrok rejected the tunnel: it isn't authenticated.");
        console.log(
          "  Get your authtoken at: https://dashboard.ngrok.com/get-started/your-authtoken",
        );
        const token = (
          await readLineText(
            "Paste your ngrok authtoken to continue (Enter to cancel): ",
          )
        ).trim();
        if (!token) {
          console.log("No authtoken entered.");
          process.exit(1);
        }
        authAttempts++;
        if (saveNgrokAuthToken(token)) {
          console.log("✅ ngrok authtoken saved. Retrying the tunnel...");
        }
        continue;
      }
      cleanup();
      if (domain && !opts.domain) {
        console.error(savedDomainRecoveryHint(domain));
      }
      throw err;
    }
    publicUrl = url;

    console.log("");
    console.log(`Tunnel established: ${publicUrl}`);
    console.log(`Forwarding to:     localhost:${port}`);

    // The domain is standing intent, not tunnel state: cleanup clears the
    // ingress URL but leaves the domain saved for wake/daemon restores.
    saveIngressUrl(workspaceDir, publicUrl, opts.assistantId, "ngrok");
    if (ngrokProcess.pid) {
      stampRootProcess("tunnel", {
        pid: ngrokProcess.pid,
        provider: "ngrok",
        startedAt: new Date().toISOString(),
        publicUrl,
      });
    }
    if (opts.domain) {
      saveNgrokDomain(opts.domain);
    }
    console.log("Ingress URL saved to config.");
    console.log("");
    console.log("Press Ctrl+C to stop the tunnel and clear the ingress URL.");

    // Keep running until the ngrok process exits or we receive a signal
    const waitForExit = new Promise<void>((resolve) => {
      ngrokProcess.on("exit", () => resolve());
    });
    return { publicUrl, waitForExit };
  }
  // Unreachable: the loop only exits via return, process.exit, or a throw.
  throw new Error("ngrok tunnel did not start.");
}

export const NGROK_PROVIDER: TunnelProvider = {
  run: runNgrokTunnel,
  stop: (opts) => stopOwnedTunnelAgent(opts, isNgrokProcess, "ngrok"),
  /**
   * The default provider's start piece: the same gates (containerized
   * deploys, webhook integrations, a saved foreign URL) and detached-spawn
   * ownership — the ChildProcess is what the root lockfile's pid tracking
   * records; it saves the URL and notifies the gateway itself, so the spawn
   * returns nothing to await here.
   */
  start: async ({ port, workspaceDir, assistantId }: TunnelStartOptions) => {
    await maybeStartNgrokTunnel(port, workspaceDir, assistantId);
    return null;
  },
};
