/** Only an authoritative rejection may invalidate an offline account snapshot. */
export function isAccountSessionRejected(result: {
  ok: boolean;
  status?: number;
}): boolean {
  return (
    !result.ok &&
    result.status !== undefined &&
    [401, 403, 410].includes(result.status)
  );
}
