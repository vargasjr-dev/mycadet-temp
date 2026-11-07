export function remoteGatewayPublicPathPrefix(
  location = window.location,
): string {
  const match = /\/assistant(?:\/|$)/.exec(location.pathname);
  return match && match.index > 0
    ? location.pathname.slice(0, match.index).replace(/\/+$/, "")
    : "";
}
