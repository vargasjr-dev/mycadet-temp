import type {
  RemoteWebPairingTokenApprovedResponse,
  RemoteWebPairingTokenPendingResponse,
} from "@mycadet/service-contracts/remote-web-pairing";

export type RemoteWebPairingTokenResult =
  | RemoteWebPairingTokenPendingResponse
  | RemoteWebPairingTokenApprovedResponse;

export class RemoteWebPairingError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "RemoteWebPairingError";
    this.status = status;
    this.code = code;
  }
}

export function remoteGatewayPublicPathPrefix(
  location = window.location,
): string {
  const match = /\/assistant(?:\/|$)/.exec(location.pathname);
  return match && match.index > 0
    ? location.pathname.slice(0, match.index).replace(/\/+$/, "")
    : "";
}
