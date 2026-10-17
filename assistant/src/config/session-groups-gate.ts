let recoveryHealthy = true;

/** Recovery is a process prerequisite, independent of rollout targeting. */
export function setModeSessionRecoveryHealthy(healthy: boolean): void {
  recoveryHealthy = healthy;
}

export function isModeSessionRecoveryHealthy(): boolean {
  return recoveryHealthy;
}
