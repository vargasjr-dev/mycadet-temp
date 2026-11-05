export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) {
    return "0";
  }
  return Math.round(count).toLocaleString();
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) {
    return "$0.00";
  }
  return `$${usd.toFixed(2)}`;
}
