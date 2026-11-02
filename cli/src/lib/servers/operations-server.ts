import { forwardOperatorRequest } from "@mycadet/local-mode";

/**
 * The edge's operation server: the process behind nginx's operator
 * locations. nginx cannot run the local-mode operations, so the app server
 * re-invokes the CLI (via `OPERATIONS_SERVE_FLAG`) as a detached child bound
 * to the edge's unix socket, and the generated locations proxy the public
 * operator paths to it — every answer is the operation RUN AT REQUEST TIME,
 * never a config-time bake.
 *
 * The handler is the package's shared `forwardOperatorRequest` — the same
 * seam the Electron `app://` handler and the Vite dev middleware ride — so
 * a pass (no route owns the path) answers 404 and an operation failure
 * answers the same JSON shape the other hosts surface.
 */
export async function serveOperatorRequests(socketPath: string): Promise<void> {
  Bun.serve({
    unix: socketPath,
    async fetch(request): Promise<Response> {
      try {
        const operated = await forwardOperatorRequest(request);
        if (operated) {
          return operated;
        }
        return new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      } catch {
        return new Response(
          JSON.stringify({ detail: "Operator request failed" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
    },
  });
  // The edge owns this process's lifetime: stopIngressNginx stops it by the
  // pid recorded in the ingress state. The never-resolving promise just
  // documents that this function serves until killed.
  await new Promise<never>(() => {});
}
