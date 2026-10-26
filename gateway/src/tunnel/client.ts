import type { OutgoingHttpHeaders } from "node:http";

import { normalizeHttpPublicBaseUrl } from "@mycadet/service-contracts/ingress";

import type { GatewayConfig } from "../config.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { mutateConfigFile } from "../config-file-utils.js";
import { getLogger } from "../logger.js";
import {
  ensureCloudIdentityIds,
  peekCloudAssistantId,
} from "../cloud-identity.js";
import { ExponentialBackoff } from "../util/exponential-backoff.js";
import { listWebhookIngressRoutes } from "../db/webhook-ingress-route-store.js";
import {
  TUNNEL_ALLOWED_PATHS_HEADER,
  buildTunnelAllowedPathsHeaderValue,
} from "./allowed-paths.js";
import { bridgeTunnelHttpRequest } from "./http-bridge.js";
import { closeWebSocket } from "./bridge-utils.js";
import {
  TUNNEL_FRAME_TYPES,
  TUNNEL_TUNNEL_SUBPROTOCOL,
  parseTunnelFrame,
  type TunnelFrame,
  type TunnelHttpRequestFrame,
  type TunnelRegisteredFrame,
} from "./protocol.js";
import {
  encodeBinaryWebSocketFrame,
  TUNNEL_BINARY_WEBSOCKET_HEADER,
} from "./binary-websocket.js";
import { TunnelWebSocketBridge } from "./websocket-bridge.js";
import { getIsCloud } from "../cloud-url.js";

const log = getLogger("tunnel-client");

const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.5;
const TUNNEL_POLICY_CLOSE_CODE = 4008;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_READ_TIMEOUT_MS = 60_000;
// Tunnel's production load balancer terminates every tunnel connection at
// exactly 3600s (BackendConfig timeoutSec), killing any proxied call
// mid-stream. Refresh the tunnel ourselves before that deadline (but only
// while nothing is proxied through it) so the LB's clock resets without
// ever chopping an established call.
const TUNNEL_REFRESH_AFTER_MS = 3_300_000;
const TUNNEL_REFRESH_BUSY_RETRY_MS = 30_000;
// A lifecycle that registers several webhook routes in a row should cost one
// reconnect, not one per route, so rule refreshes coalesce over this window.
const RULES_REFRESH_DEBOUNCE_MS = 5_000;

export type WebSocketConstructorWithOptions = {
  new (
    url: string | URL,
    options?: {
      protocols?: string | string[];
      headers?: OutgoingHttpHeaders;
    },
  ): WebSocket;
};

export type TunnelClientOptions = {
  tunnelBaseUrl: string;
  gatewayLoopbackBaseUrl: string;
  credentials: CredentialCache;
  configFile: ConfigFileCache;
  webSocketConstructor?: WebSocketConstructorWithOptions;
  httpBridge?: typeof bridgeTunnelHttpRequest;
  webSocketBridgeFactory?: (
    gatewayLoopbackBaseUrl: string,
    sendFrame: (frame: TunnelFrame) => void,
    onIdle?: () => void,
  ) => TunnelWebSocketBridge;
  reconnect?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    random?: () => number;
  };
  heartbeat?: {
    intervalMs?: number;
    readTimeoutMs?: number;
  };
  refresh?: {
    afterMs?: number;
    busyRetryMs?: number;
  };
  timerApi?: TimerApi;
};

export type TimerApi = {
  setTimeout: (fn: () => void, delayMs: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

export class TunnelClient {
  private readonly webSocketConstructor: WebSocketConstructorWithOptions;
  private readonly httpBridge: typeof bridgeTunnelHttpRequest;
  private readonly webSocketBridge: TunnelWebSocketBridge;
  private readonly backoff: ExponentialBackoff;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatReadTimeoutMs: number;
  private readonly refreshAfterMs: number;
  private readonly refreshBusyRetryMs: number;
  private readonly timerApi: TimerApi;
  private ws: WebSocket | null = null;
  private running = false;
  private connecting = false;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private readTimeoutTimer: unknown = null;
  private refreshTimer: unknown = null;
  private rulesRefreshTimer: unknown = null;
  // Set when the refresh deadline passed while the tunnel was busy: the
  // refresh then fires as soon as the tunnel drains (last bridged
  // connection or in-flight HTTP request completes) instead of waiting for
  // the next busy-retry poll, which could leave a stale tunnel accepting
  // new streams right before the LB chops it.
  private refreshDue = false;
  private inFlightHttpRequests = 0;
  private peerHeartbeatConfirmed = false;
  private publishedPublicBaseUrl: string | undefined;
  private credentialRefreshPending = false;
  private unsubscribeConfigInvalidation: (() => void) | undefined;
  // Last observed value of `ingress.enabled === false`, so a config change can
  // detect a disabled → enabled transition and wake a waiting reconnect.
  private lastPublicIngressDisabled = false;

  constructor(private readonly options: TunnelClientOptions) {
    this.webSocketConstructor =
      options.webSocketConstructor ??
      (WebSocket as unknown as WebSocketConstructorWithOptions);
    this.httpBridge = options.httpBridge ?? bridgeTunnelHttpRequest;
    this.webSocketBridge = (
      options.webSocketBridgeFactory ?? defaultWebSocketBridgeFactory
    )(
      options.gatewayLoopbackBaseUrl,
      (frame) => this.sendFrame(frame),
      () => this.handleTunnelIdle(),
    );
    this.backoff = new ExponentialBackoff({
      baseDelayMs: options.reconnect?.baseDelayMs ?? BASE_RECONNECT_DELAY_MS,
      maxDelayMs: options.reconnect?.maxDelayMs ?? MAX_RECONNECT_DELAY_MS,
      jitter: {
        mode: "additive",
        ratio: options.reconnect?.jitterRatio ?? RECONNECT_JITTER_RATIO,
      },
      random: options.reconnect?.random,
    });
    this.heartbeatIntervalMs =
      options.heartbeat?.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatReadTimeoutMs =
      options.heartbeat?.readTimeoutMs ?? HEARTBEAT_READ_TIMEOUT_MS;
    this.refreshAfterMs = options.refresh?.afterMs ?? TUNNEL_REFRESH_AFTER_MS;
    this.refreshBusyRetryMs =
      options.refresh?.busyRetryMs ?? TUNNEL_REFRESH_BUSY_RETRY_MS;
    this.timerApi = options.timerApi ?? defaultTimerApi;
  }

  getStatus(): { connected: boolean; publicUrl: string | null } {
    const connected =
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN &&
      this.publishedPublicBaseUrl !== undefined;
    return {
      connected,
      publicUrl: this.publishedPublicBaseUrl ?? null,
    };
  }

  refreshCredentials(reason = "credentials changed"): void {
    if (!this.running) return;

    this.backoff.reset();
    if (this.reconnectTimer) {
      this.timerApi.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const ws = this.ws;
    if (ws) {
      log.info({ reason }, "Restarting Tunnel with refreshed credentials");
      this.disconnectActiveWebSocket(ws, 1000, "credentials changed");
      return;
    }

    if (this.connecting) {
      this.credentialRefreshPending = true;
      log.info(
        { reason },
        "Queued Tunnel credential refresh behind active connect",
      );
      return;
    }

    this.connectForCredentialRefresh(reason);
  }

  /**
   * Reconnect so Tunnel sees the current path rules. Only a live tunnel needs
   * this: the next connect reads the registry itself, so a client that is
   * stopped or disconnected already picks the change up. Deferred while the
   * tunnel is busy, the same way the load-balancer refresh is. The socket to
   * refresh is resolved when the debounce fires rather than captured when it
   * is armed, so a reconnect during the debounce window still advertises the
   * rules that landed after it connected.
   */
  requestRulesRefresh(reason: string): void {
    if (!this.running || !this.ws || this.rulesRefreshTimer) {
      return;
    }
    this.rulesRefreshTimer = this.timerApi.setTimeout(() => {
      this.rulesRefreshTimer = null;
      const ws = this.ws;
      if (!this.running || !ws) {
        return;
      }
      if (this.isTunnelBusy()) {
        this.refreshDue = true;
        return;
      }
      log.info({ reason }, "Reconnecting Tunnel to advertise new rules");
      this.performTunnelRefresh(ws);
    }, RULES_REFRESH_DEBOUNCE_MS);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastPublicIngressDisabled = this.isPublicIngressDisabled();
    this.unsubscribeConfigInvalidation ??= this.options.configFile.onInvalidate(
      () => {
        this.handleConfigInvalidated();
      },
    );
    this.connect().catch((err) => {
      this.connecting = false;
      log.error({ err }, "Failed to start Tunnel client");
      this.scheduleReconnect();
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connecting = false;
    this.credentialRefreshPending = false;
    this.unsubscribeConfigInvalidation?.();
    this.unsubscribeConfigInvalidation = undefined;
    if (this.reconnectTimer) {
      this.timerApi.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    this.clearTunnelRefresh();
    if (this.rulesRefreshTimer) {
      this.timerApi.clearTimeout(this.rulesRefreshTimer);
      this.rulesRefreshTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.webSocketBridge.closeAll();
    await this.clearPublishedPublicBaseUrl();
    if (ws) {
      closeWebSocket(ws, 1000, "gateway shutdown");
    }
  }

  /**
   * A registry read failure must never block the tunnel: fall back to an
   * empty path list, which the header builder turns into legacy or
   * statics-only rules.
   */
  private readRegisteredWebhookPaths(): string[] {
    try {
      return listWebhookIngressRoutes().map((route) => route.path);
    } catch (err) {
      log.error(
        { err },
        "Failed to read webhook ingress routes for tunnel rules",
      );
      return [];
    }
  }

  private async connect(): Promise<void> {
    if (!this.running || this.connecting) {
      return;
    }
    this.connecting = true;

    if (this.isPublicIngressDisabled()) {
      this.connecting = false;
      await this.clearPublishedPublicBaseUrl();
      log.info("Tunnel waiting because public ingress is disabled");
      this.scheduleReconnect();
      return;
    }

    let apiKeyRaw: string | undefined;
    try {
      apiKeyRaw = await this.options.credentials.get(
        credentialKey("cadet", "assistant_api_key"),
      );
    } catch (err) {
      this.connecting = false;
      log.warn({ err }, "Failed to read Tunnel credentials");
      if (this.consumePendingCredentialRefresh("credentials read failed")) {
        return;
      }
      this.scheduleReconnect();
      return;
    }

    if (!this.running) {
      this.connecting = false;
      return;
    }

    const apiKey = apiKeyRaw?.trim();
    if (!apiKey) {
      this.connecting = false;
      if (this.consumePendingCredentialRefresh("assistant API key missing")) {
        return;
      }
      log.info("Tunnel waiting for assistant API key");
      this.scheduleReconnect();
      return;
    }
    await ensureCloudIdentityIds();
    const expectedAssistantId = peekCloudAssistantId();

    let registerUrl: string;
    try {
      registerUrl = buildRegisterWebSocketUrl(this.options.tunnelBaseUrl);
    } catch (err) {
      this.connecting = false;
      log.error({ err }, "Invalid Tunnel base URL");
      if (this.consumePendingCredentialRefresh("Tunnel base URL invalid")) {
        return;
      }
      this.scheduleReconnect();
      return;
    }

    try {
      const ws = new this.webSocketConstructor(registerUrl, {
        protocols: [TUNNEL_TUNNEL_SUBPROTOCOL],
        headers: {
          Authorization: `Api-Key ${apiKey}`,
          [TUNNEL_BINARY_WEBSOCKET_HEADER]: "1",
          // Declares the path allowlist Tunnel enforces for inbound proxied
          // traffic on this tunnel. Read per attempt so a reconnect picks up
          // webhook routes registered since the last one. See
          // ./allowed-paths.ts for the route inventory and the cloud-side
          // enforcement (ATL-402).
          [TUNNEL_ALLOWED_PATHS_HEADER]: buildTunnelAllowedPathsHeaderValue(
            () => this.readRegisteredWebhookPaths(),
          ),
        },
      });
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this.connecting = false;

      ws.addEventListener("open", () => {
        if (this.ws !== ws || !this.running) return;
        log.info("Tunnel connected");
        this.startHeartbeat(ws);
      });

      ws.addEventListener("message", (event) => {
        void this.handleMessage(event.data, ws, expectedAssistantId).catch(
          (err) => {
            log.error({ err }, "Failed to handle Tunnel frame");
          },
        );
      });

      ws.addEventListener("close", (event) => {
        this.handleClose(ws, event);
      });

      ws.addEventListener("error", (event) => {
        if (this.ws !== ws || !this.running) return;
        log.warn({ error: String(event) }, "Tunnel WebSocket error");
        if (ws.readyState === WebSocket.CONNECTING) {
          this.disconnectActiveWebSocket(ws);
        }
      });

      if (this.credentialRefreshPending) {
        this.credentialRefreshPending = false;
        log.info(
          "Restarting Tunnel because credentials changed during connect",
        );
        this.disconnectActiveWebSocket(ws, 1000, "credentials changed");
      }
    } catch (err) {
      this.ws = null;
      this.connecting = false;
      log.warn({ err }, "Failed to connect Tunnel");
      if (this.consumePendingCredentialRefresh("WebSocket connect failed")) {
        return;
      }
      this.scheduleReconnect();
    }
  }

  private connectForCredentialRefresh(reason: string): void {
    this.connect().catch((err) => {
      this.connecting = false;
      log.error({ err, reason }, "Tunnel credential refresh reconnect failed");
      this.scheduleReconnect();
    });
  }

  private consumePendingCredentialRefresh(reason: string): boolean {
    if (!this.credentialRefreshPending || !this.running) return false;

    this.credentialRefreshPending = false;
    log.info({ reason }, "Retrying Tunnel connect with refreshed credentials");
    this.connectForCredentialRefresh(reason);
    return true;
  }

  private async handleMessage(
    data: unknown,
    originWs: WebSocket,
    cloudAssistantId: string | undefined,
  ): Promise<void> {
    if (this.ws !== originWs || !this.running) return;

    const frame = parseTunnelFrame(data);
    if (!frame) {
      log.warn("Ignoring malformed Tunnel frame");
      return;
    }

    if (
      frame.type === TUNNEL_FRAME_TYPES.heartbeat &&
      !this.peerHeartbeatConfirmed
    ) {
      this.peerHeartbeatConfirmed = true;
      log.info("Tunnel peer confirmed heartbeat support");
    }
    if (this.peerHeartbeatConfirmed || this.readTimeoutTimer) {
      this.resetReadTimeout(originWs);
    }

    switch (frame.type) {
      case TUNNEL_FRAME_TYPES.registered:
        await this.handleRegisteredFrame(frame, originWs, cloudAssistantId);
        return;
      case TUNNEL_FRAME_TYPES.httpRequest:
        await this.handleHttpRequestFrame(frame, originWs);
        return;
      case "websocket_binary":
      case TUNNEL_FRAME_TYPES.websocketOpen:
      case TUNNEL_FRAME_TYPES.websocketMessage:
      case TUNNEL_FRAME_TYPES.websocketClose:
        this.webSocketBridge.handleFrame(frame);
        return;
      case TUNNEL_FRAME_TYPES.heartbeat:
        return;
      default:
        log.debug({ type: frame.type }, "Ignoring unsupported Tunnel frame");
    }
  }

  private async handleRegisteredFrame(
    frame: TunnelRegisteredFrame,
    originWs: WebSocket,
    cloudAssistantId: string | undefined,
  ): Promise<void> {
    if (cloudAssistantId && frame.assistant_id !== cloudAssistantId) {
      log.error(
        {
          expectedAssistantId: cloudAssistantId,
          receivedAssistantId: frame.assistant_id,
        },
        "Tunnel registered assistant ID mismatch",
      );
      this.disconnectActiveWebSocket(
        originWs,
        TUNNEL_POLICY_CLOSE_CODE,
        "assistant ID mismatch",
      );
      return;
    }

    const publicUrl = normalizeHttpPublicBaseUrl(frame.public_url);
    if (!publicUrl) {
      log.error(
        { publicUrl: frame.public_url },
        "Tunnel registered invalid public URL",
      );
      this.disconnectActiveWebSocket(
        originWs,
        TUNNEL_POLICY_CLOSE_CODE,
        "invalid public URL",
      );
      return;
    }

    if (this.isPublicIngressDisabled()) {
      log.info(
        { publicUrl },
        "Skipping Tunnel public URL publish because public ingress is disabled",
      );
      this.disconnectActiveWebSocket(originWs, 1000, "public ingress disabled");
      return;
    }

    await writeManagedPublicBaseUrl(publicUrl, this.options.configFile);
    this.publishedPublicBaseUrl = publicUrl;
    this.backoff.reset();
    log.info({ publicUrl }, "Tunnel registered");
    this.scheduleTunnelRefresh(originWs, this.refreshAfterMs);
  }

  private async handleHttpRequestFrame(
    frame: TunnelHttpRequestFrame,
    originWs: WebSocket,
  ): Promise<void> {
    this.inFlightHttpRequests++;
    try {
      const response = await this.httpBridge(
        frame,
        this.options.gatewayLoopbackBaseUrl,
      );
      if (this.ws !== originWs || !this.running) {
        return;
      }
      this.sendFrame(response);
    } finally {
      this.inFlightHttpRequests--;
      if (this.inFlightHttpRequests === 0) {
        this.handleTunnelIdle();
      }
    }
  }

  private handleClose(ws: WebSocket, event: CloseEvent): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.connecting = false;
    this.clearHeartbeat();
    this.clearTunnelRefresh();
    this.webSocketBridge.closeAll();
    log.info({ code: event.code, reason: event.reason }, "Tunnel disconnected");
    this.clearPublishedPublicBaseUrlThenReconnect();
  }

  private disconnectActiveWebSocket(
    ws: WebSocket,
    code?: number,
    reason?: string,
  ): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.connecting = false;
    this.clearHeartbeat();
    this.clearTunnelRefresh();
    this.webSocketBridge.closeAll();
    closeWebSocket(ws, code, reason);
    this.clearPublishedPublicBaseUrlThenReconnect();
  }

  /**
   * Restart the tunnel before tunnel's load balancer terminates it (see
   * TUNNEL_REFRESH_AFTER_MS), so proxied calls stop dying at the hourly
   * boundary. Only fires while nothing is proxied through the tunnel; while
   * busy it marks the refresh due, so the tunnel refreshes the moment it
   * drains, with a busy-retry poll as backstop. If the LB chops first, the
   * close handler clears the timer and the normal reconnect takes over.
   */
  private scheduleTunnelRefresh(ws: WebSocket, delayMs: number): void {
    if (this.refreshAfterMs <= 0) {
      return;
    }
    this.clearTunnelRefresh();
    this.refreshTimer = this.timerApi.setTimeout(() => {
      this.refreshTimer = null;
      if (this.ws !== ws || !this.running) {
        return;
      }
      if (this.isTunnelBusy()) {
        this.scheduleTunnelRefresh(ws, this.refreshBusyRetryMs);
        // Set after the reschedule: clearTunnelRefresh resets the flag.
        this.refreshDue = true;
        return;
      }
      this.performTunnelRefresh(ws);
    }, delayMs);
  }

  private clearTunnelRefresh(): void {
    this.refreshDue = false;
    if (this.refreshTimer) {
      this.timerApi.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private isTunnelBusy(): boolean {
    return (
      this.webSocketBridge.getConnectionCount() > 0 ||
      this.inFlightHttpRequests > 0
    );
  }

  /** Overdue-refresh path: the tunnel just drained (see refreshDue). */
  private handleTunnelIdle(): void {
    if (!this.refreshDue || !this.running) {
      return;
    }
    const ws = this.ws;
    if (!ws || this.isTunnelBusy()) {
      return;
    }
    this.performTunnelRefresh(ws);
  }

  private performTunnelRefresh(ws: WebSocket): void {
    log.info("Refreshing idle Tunnel before the load balancer timeout");
    this.backoff.reset();
    this.disconnectActiveWebSocket(ws, 1000, "proactive tunnel refresh");
  }

  private async clearPublishedPublicBaseUrl(): Promise<void> {
    const publicUrl = this.publishedPublicBaseUrl;
    if (!publicUrl) return;
    this.publishedPublicBaseUrl = undefined;
    try {
      await clearManagedPublicBaseUrl(this.options.configFile, publicUrl);
    } catch (err) {
      log.error({ err }, "Failed to clear Tunnel public URL");
    }
  }

  private clearPublishedPublicBaseUrlThenReconnect(): void {
    void this.clearPublishedPublicBaseUrl()
      .catch((err) => {
        log.error({ err }, "Failed to clear Tunnel public URL");
      })
      .finally(() => {
        this.scheduleReconnect();
      });
  }

  private sendFrame(frame: TunnelFrame): boolean {
    const ws = this.ws;
    if (!this.running || !ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      ws.send(
        frame.type === "websocket_binary"
          ? encodeBinaryWebSocketFrame(frame)
          : JSON.stringify(frame),
      );
      return true;
    } catch (err) {
      log.warn({ err }, "Tunnel WebSocket send failed; forcing reconnect");
      this.disconnectActiveWebSocket(ws, 1000, "websocket send failed");
      return false;
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    if (this.heartbeatIntervalMs > 0) this.scheduleHeartbeatSend(ws);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      this.timerApi.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.readTimeoutTimer) {
      this.timerApi.clearTimeout(this.readTimeoutTimer);
      this.readTimeoutTimer = null;
    }
    this.peerHeartbeatConfirmed = false;
  }

  private scheduleHeartbeatSend(ws: WebSocket): void {
    if (this.heartbeatTimer) {
      this.timerApi.clearTimeout(this.heartbeatTimer);
    }
    this.heartbeatTimer = this.timerApi.setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.ws !== ws || !this.running || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (!this.sendFrame({ type: TUNNEL_FRAME_TYPES.heartbeat })) {
        return;
      }
      this.resetReadTimeout(ws);
      this.scheduleHeartbeatSend(ws);
    }, this.heartbeatIntervalMs);
  }

  private resetReadTimeout(ws: WebSocket): void {
    if (this.heartbeatReadTimeoutMs <= 0) return;
    if (this.readTimeoutTimer) {
      this.timerApi.clearTimeout(this.readTimeoutTimer);
    }
    this.readTimeoutTimer = this.timerApi.setTimeout(() => {
      this.readTimeoutTimer = null;
      if (this.ws !== ws || !this.running) return;
      log.warn(
        { timeoutMs: this.heartbeatReadTimeoutMs },
        "Tunnel heartbeat read-timeout expired; forcing reconnect",
      );
      this.disconnectActiveWebSocket(ws, 1000, "heartbeat read timeout");
    }, this.heartbeatReadTimeoutMs);
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;

    const delay = this.backoff.nextDelayMs();

    this.reconnectTimer = this.timerApi.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.connecting = false;
        log.error({ err }, "Tunnel reconnect failed");
        this.scheduleReconnect();
      });
    }, delay);
  }

  private handleConfigInvalidated(): void {
    const disabled = this.isPublicIngressDisabled();
    const wasDisabled = this.lastPublicIngressDisabled;
    this.lastPublicIngressDisabled = disabled;

    const ws = this.ws;

    if (disabled) {
      if (ws) {
        log.info("Closing Tunnel because public ingress is disabled");
        this.disconnectActiveWebSocket(ws, 1000, "public ingress disabled");
      }
      return;
    }

    // Public ingress just transitioned disabled → enabled. If the client is
    // running but idling on a backoff timer (it was started while disabled, so
    // `connect()` kept re-scheduling), reconnect now instead of waiting out the
    // backoff — otherwise a link minted right after enabling ingress (which
    // also starts the tunnel) stays unreachable for up to the max backoff.
    if (wasDisabled && this.running && !ws && !this.connecting) {
      this.backoff.reset();
      if (this.reconnectTimer) {
        this.timerApi.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      void this.connect().catch((err) => {
        this.connecting = false;
        log.error({ err }, "Tunnel reconnect after ingress enable failed");
        this.scheduleReconnect();
      });
    }
  }

  private isPublicIngressDisabled(): boolean {
    return (
      this.options.configFile.getBoolean("ingress", "enabled", {
        force: true,
      }) === false
    );
  }
}

export function createTunnelClient(
  config: GatewayConfig,
  deps: {
    credentials: CredentialCache;
    configFile: ConfigFileCache;
  },
): TunnelClient | undefined {
  if (!config.tunnelBaseUrl) {
    const isCloud = getIsCloud();
    if (isCloud) {
      log.warn(
        "TUNNEL_BASE_URL is not configured on a cloud pod — the assistant tunnel will not be established and inbound webhook delivery will fail",
      );
    }
    return undefined;
  }
  return new TunnelClient({
    tunnelBaseUrl: config.tunnelBaseUrl,
    gatewayLoopbackBaseUrl: config.gatewayInternalBaseUrl,
    credentials: deps.credentials,
    configFile: deps.configFile,
  });
}

const defaultTimerApi: TimerApi = {
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function defaultWebSocketBridgeFactory(
  gatewayLoopbackBaseUrl: string,
  sendFrame: (frame: TunnelFrame) => void,
  onIdle?: () => void,
): TunnelWebSocketBridge {
  return new TunnelWebSocketBridge(gatewayLoopbackBaseUrl, sendFrame, onIdle);
}

async function mutateGatewayConfigFile(
  configFile: ConfigFileCache,
  malformedLogMessage: string,
  mutate: (data: Record<string, unknown>) => boolean,
): Promise<void> {
  const result = await mutateConfigFile(mutate, {
    shouldWrite: (changed) => changed,
    onWritten: () => {
      configFile.invalidate();
    },
  });
  if (!result.ok) {
    log.error({ detail: result.detail }, malformedLogMessage);
  }
}

const TUNNEL_MANAGED_BY = "tunnel";

export async function writeManagedPublicBaseUrl(
  publicUrl: string,
  configFile: ConfigFileCache,
): Promise<void> {
  return mutateGatewayConfigFile(
    configFile,
    "Cannot publish Tunnel public URL because config.json is malformed",
    (data) => {
      const ingress = getMutableIngress(data);
      if (
        ingress.publicBaseUrl === publicUrl &&
        ingress.publicBaseUrlManagedBy === TUNNEL_MANAGED_BY
      ) {
        return false;
      }

      ingress.publicBaseUrl = publicUrl;
      ingress.publicBaseUrlManagedBy = TUNNEL_MANAGED_BY;
      data.ingress = ingress;
      return true;
    },
  );
}

/**
 * Enable public ingress by setting `ingress.enabled = true` in the gateway
 * config file. No-op when it is already truthy (the mutate callback returns
 * `false`, so nothing is written).
 *
 * Flipping `enabled` from `false` → `true` triggers the gateway config
 * watcher, which lets the Tunnel reconnect loop (`connect()` re-checks
 * `isPublicIngressDisabled()` on each attempt) establish the tunnel and
 * publish the public URL.
 */
export async function enablePublicIngress(
  configFile: ConfigFileCache,
): Promise<void> {
  return mutateGatewayConfigFile(
    configFile,
    "Cannot enable public ingress because config.json is malformed",
    (data) => {
      const ingress = getMutableIngress(data);
      if (ingress.enabled === true) {
        return false;
      }
      ingress.enabled = true;
      data.ingress = ingress;
      return true;
    },
  );
}

export async function clearManagedPublicBaseUrl(
  configFile: ConfigFileCache,
  expectedPublicUrl?: string,
): Promise<void> {
  return mutateGatewayConfigFile(
    configFile,
    "Cannot clear Tunnel public URL because config.json is malformed",
    (data) => {
      if (
        !data.ingress ||
        typeof data.ingress !== "object" ||
        Array.isArray(data.ingress)
      ) {
        return false;
      }

      const ingress = { ...(data.ingress as Record<string, unknown>) };
      if (ingress.publicBaseUrlManagedBy !== TUNNEL_MANAGED_BY) {
        return false;
      }
      if (
        expectedPublicUrl !== undefined &&
        ingress.publicBaseUrl !== expectedPublicUrl
      ) {
        delete ingress.publicBaseUrlManagedBy;
        data.ingress = ingress;
        return true;
      }

      delete ingress.publicBaseUrl;
      delete ingress.publicBaseUrlManagedBy;
      data.ingress = ingress;
      return true;
    },
  );
}

function getMutableIngress(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return data.ingress &&
    typeof data.ingress === "object" &&
    !Array.isArray(data.ingress)
    ? { ...(data.ingress as Record<string, unknown>) }
    : {};
}

function buildRegisterWebSocketUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL("v1/register", normalizedBaseUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("TUNNEL_BASE_URL must use http, https, ws, or wss");
  }
  return url.toString();
}
