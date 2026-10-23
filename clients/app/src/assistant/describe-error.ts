/**
 * Renders an unknown thrown value as a string a log line can carry. Error
 * objects serialize as `{}` through the webview console pipeline (message and
 * stack are non-enumerable), so they are pulled out explicitly; anything else
 * gets its natural string form.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}
