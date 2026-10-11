/**
 * Raised by the local platform-identity flow once the cloud registration
 * exists but the local side of the bootstrap (credential injection, lockfile
 * metadata) did not complete. Carries the registered platform id so callers
 * that only need the registration, such as naming a teleport successor, can
 * still use it while the retrying bootstrap finishes the rest.
 */
export class CloudIdentityInjectionError extends Error {
  readonly cloudAssistantId: string;

  constructor(cloudAssistantId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "CloudIdentityInjectionError";
    this.cloudAssistantId = cloudAssistantId;
  }
}
