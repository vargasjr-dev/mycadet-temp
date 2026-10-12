export function isWebsocketUpgradeRequest(req: Request) {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}
