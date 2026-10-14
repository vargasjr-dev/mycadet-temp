let active = 0;

/** Resume probes stay suspended through the host exchange and account reconciliation. */
export function beginOAuthFlow(): () => void {
  active++;
  let finished = false;
  return () => {
    if (!finished) {
      finished = true;
      active--;
    }
  };
}

export function isOAuthFlowInFlight(): boolean {
  return active > 0;
}
