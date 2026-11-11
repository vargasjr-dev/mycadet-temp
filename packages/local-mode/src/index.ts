/**
 * @mycadet/local-mode - shared assistant-agnostic operations for assistant operators
 */
export {
  stripSensitiveFields,
  isLoopbackAddr,
  headerHostIsLoopback,
  originIsAllowed,
  hasSameOriginCredentialProof,
  resolveDevCliInvocation,
} from "./util";
export type { CliInvocation } from "./util";

export {
  resolveLocalConfigFromEnv,
  resolveLockfilePath,
  resolveConfigDir,
  resolveDataDir,
  resolveLogDir,
  resolveAssistantsDir,
  guardianTokenPath,
} from "./config";
export { stageBasetenBuildContext } from "./remotes/baseten/context";
export { execBasetenSandbox } from "./remotes/baseten/exec";
export { localExecDirForService } from "./remotes/local/exec";
export {
  resolveLocalCommandInvocation,
  type LocalCommandResolution,
} from "./remotes/local/common";
export { createBackup, formatSize } from "./backup-ops";

export { type ManagedProcessEntry } from "./daemon-readiness";
export { compareVersions } from "./version-compat";
export {
  fetchLatestVersion,
  fetchReleases,
  type ReleaseListItem,
} from "./cloud-releases";

export { fetchGatewayPs } from "./daemon-readiness";
export { cliCommand, resolveEnvironmentName } from "./environment";

export { readLockfile, saveLockfileAssistant } from "./lockfile";
export {
  servedAssistantFromLockfile,
  servedConfigFromLockfile,
} from "./served-config";
export { withLockfileLock } from "./lockfile-lock";
export {
  GATEWAY_PORT,
  getGatewayUrl,
  isAppleContainerEntry,
  isDockerEntry,
  isLocalEntry,
  LockfileAssistantSchema,
  parseLockfile,
} from "./lockfile-contract";
export type {
  Lockfile,
  LockfileAssistant,
  LocalAssistant,
  AppleContainerAssistant,
  CloudAssistant,
  LockfileWriteResult,
} from "./lockfile-contract";
export { configureCliPaths, resolveCliInvocation } from "./cli-invocation";
export {
  matchOperatorRequest,
  forwardOperatorRequest,
} from "./operations/routes";

export { retireAssistant } from "./operations/retire";
export { sleepAssistant, type SleepOptions } from "./operations/sleep";
export { hatchAssistant, type HatchAssistantResult } from "./operations/hatch";
export { allocateLocalPlacement } from "./remotes/local/hatch";

export { wakeAssistant } from "./operations/wake";
export { restartAssistant } from "./operations/restart";
export { backupAssistant } from "./operations/backup";

export { type ServiceName } from "./remotes/docker/statefulset";

export { SEARCH_PROVIDER_ENV_VAR_NAMES } from "./provider-env-vars";

export {
  computeDeviceId,
  getOrCreatePersistedDeviceId,
  GuardianLeasePermanentError,
  leaseGuardianToken,
  parseGuardianTokenFields,
} from "./guardian-token";
export {
  configureHatchProviderApiKey,
  ensureProviderApiKey,
  formatProviderName,
  injectGatewayApiKey,
  isSupportedLlmProvider,
  promptSecret,
  readGatewayApiKey,
} from "./provider-credentials";
export { LLM_PROVIDER_ENV_VAR_NAMES } from "./provider-env-vars";
export {
  registerLocalAssistantWithCloud,
  fetchCurrentUser,
} from "./cloud-registration";

export type {
  LlmProviderId,
  ProviderSecretFetch,
} from "./provider-credentials";

export {
  DEFAULT_PORTS,
  getDefaultPorts,
  findAvailablePort,
  probePort,
  ASSISTANT_INTERNAL_PORT,
  GATEWAY_INTERNAL_PORT,
} from "./ports";
export {
  waitForDaemonReady,
  checkHealth,
  type GatewayHealth,
} from "./daemon-readiness";
export {
  openLogFile,
  resetLogFile,
  closeLogFile,
  writeToLogFile,
} from "./xdg-log";
export type { SleepResult } from "./operations/sleep";
export {
  machineGet,
  machineResetKey,
  machineSetKey,
  type MachineMutationResult,
} from "./operations/machine";
export { parseWaitDuration } from "./remotes/local/drain";
export {
  loadAllAssistants,
  lookupAssistantByIdentifier,
  formatAssistantLookupError,
  getAssistantDisplayName,
  removeLockfileAssistant,
  getActiveAssistant,
  extractHostFromEntry,
  clearAppProcessRecord,
} from "./operations/lookup";

export { retireLocal } from "./remotes/local/retire";
export {
  validateAssistantName,
  getRetiredDir,
  getMetadataPath,
} from "./remotes/local/archive";
export { dockerResourceNames, retireDocker } from "./remotes/docker/retire";
export { pullImage } from "./remotes/docker/hatch";
export { exec, execOutput, execWithStdin, buildExecErrorMessage } from "./exec";
export {
  isCadetCommandLine,
  parseTasklistCsv,
  windowsCommandLineLookupArgs,
  readProcessCommandLine,
  isCadetWindowsProcess,
  isProcessAlive,
  stopProcess,
  stopProcessByPidFile,
  executableName,
  pathListDelimiter,
} from "./process";

export { loopbackSafeFetch, isLoopbackUrl } from "./loopback-fetch";
export {
  pairDevice,
  type PairDeviceIdentity,
  type PairOperationResult,
} from "./operations/pair";
export { pairLocal } from "./remotes/local/pair";
export { pairDocker } from "./remotes/docker/pair";
export {
  cloudTokenPath,
  readCloudToken,
  resolveCloudUrl as getCloudUrl,
  authHeadersForKnownOrganization,
  cloudAuthHeaders,
  invalidateOrgIdCache,
  fetchOrganizationId,
} from "./cloud-auth";
export { consoleLifecycleReporter } from "./lifecycle-reporter";
export { unpairAssistant } from "./unpair";
export {
  checkPairedAssistantName,
  pairingStart,
  pairingPoll,
  pairingCancel,
} from "./pair";
export type { PairingFailureReason } from "./pair";
export { runDevicesList, runDevicesRevoke } from "./devices";
export type { DeviceRecord } from "./devices";
export { stripVersionPrefix } from "./version";
export { upgradeAssistant } from "./operations/upgrade";
export { broadcastUpgradeEvent, buildCompleteEvent } from "./upgrade-lifecycle";
export { resolveLatestStableTag } from "./remotes/local/upgrade";
export { teleportAssistant } from "./operations/teleport";
export { restoreAssistant } from "./operations/restore";
export {
  cloudPollJobStatus,
  cloudRequestSignedUrl,
  VersionMismatchError,
} from "./remotes/cloud/migrations";
export {
  getGuardianAccessToken,
  isConfidentialRefreshUrl,
  saveGuardianToken,
  loadGuardianToken,
} from "./guardian-token";
export type { TokenResult, GuardianTokenData } from "./guardian-token";
