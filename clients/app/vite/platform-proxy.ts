import type http from "node:http";
import { hasSameOriginCredentialProof } from "@mycadet/local-mode";

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A dev-host token is forwarded only on browser-proven loopback requests. */
export function injectPlatformToken(
  apiMode: boolean,
  readToken: () => string | null,
) {
  return (proxy: {
    on(
      event: "proxyReq",
      callback: (
        outgoing: {
          setHeader(name: string, value: string): void;
          removeHeader(name: string): void;
        },
        incoming: Pick<http.IncomingMessage, "headers">,
      ) => void,
    ): unknown;
  }): void => {
    proxy.on("proxyReq", (outgoing, incoming) => {
      if (
        !hasSameOriginCredentialProof(
          header(incoming.headers.host),
          header(incoming.headers.origin),
          header(incoming.headers["sec-fetch-site"]),
        )
      ) {
        return;
      }
      const token = readToken();
      if (apiMode) {
        outgoing.removeHeader("Cookie");
        if (token) {
          outgoing.setHeader("X-Session-Token", token);
        }
      } else if (token) {
        outgoing.setHeader(
          "Cookie",
          `sessionid=${token}; __Secure-sessionid=${token}`,
        );
      }
    });
  };
}
