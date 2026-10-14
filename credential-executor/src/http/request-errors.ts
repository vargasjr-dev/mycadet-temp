import { randomUUID } from "node:crypto";

type RequestLogger = {
  error(context: Record<string, unknown>, message: string): void;
};

/** Keep exception diagnostics in CES logs and expose only a correlation id. */
export async function withCesHttpErrorLogging(
  request: Request,
  handle: () => Promise<Response>,
  logger: RequestLogger,
): Promise<Response> {
  try {
    return await handle();
  } catch (err) {
    const requestId = randomUUID();
    logger.error(
      {
        err,
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
      },
      "CES HTTP request failed",
    );
    return Response.json(
      { error: "Internal server error", request_id: requestId },
      {
        status: 500,
        headers: { "x-ces-error-id": requestId },
      },
    );
  }
}
