/** Shared pieces for suites that open WebSockets against `RuntimeHttpServer`. */

/**
 * Identity headers standing for the gateway's own service principal —
 * what the gateway's WS dials assert now that the daemon resolves
 * identity from forwarded headers instead of verifying tokens.
 */
export const gatewayIdentityHeaders: Record<string, string> = {
  "x-cadet-subject": "svc:gateway:self",
  "x-cadet-principal-type": "svc_gateway",
  "x-cadet-scope-profile": "gateway_ingress_v1",
};

/** Identity headers standing for a gateway-admitted guardian actor. */
export const actorIdentityHeaders: Record<string, string> = {
  "x-cadet-subject": "actor:self:user-123",
  "x-cadet-principal-type": "actor",
  "x-cadet-scope-profile": "actor_client_v1",
};

/** Headers of a WebSocket upgrade sent through plain `fetch`. */
export const upgradeHeaders = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version": "13",
};

export function waitForClose(
  ws: WebSocket,
  timeoutMs = 2000,
): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket close"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      resolve(event);
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket close failed"));
    };
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });
}

/** Turn real HTTP auth on for a test; the returned function restores the env. */
export function requireHttpAuth(): () => void {
  const saved = process.env.DISABLE_HTTP_AUTH;
  delete process.env.DISABLE_HTTP_AUTH;
  return () => {
    if (saved === undefined) {
      delete process.env.DISABLE_HTTP_AUTH;
    } else {
      process.env.DISABLE_HTTP_AUTH = saved;
    }
  };
}
