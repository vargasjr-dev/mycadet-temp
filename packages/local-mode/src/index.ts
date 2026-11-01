/**
 * @mycadet/local-mode - shared host library for serving the local-assistant
 * surface (lockfile reads, guardian-token issuance, gateway proxying, and the
 * hatch/retire/wake lifecycle ops) over a loopback HTTP boundary. Consumed by the
 * CLI `client` server and the web app's dev-server middleware so the local
 * endpoint behaviour is defined exactly once instead of one host reaching into
 * another's source tree. `@mycadet/environments`,
 * `@mycadet/service-contracts`, and the source-only
 * `@mycadet/avatar-manifest` are its only workspace dependencies.
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
  DAEMON_STOP_TIMEOUT_MS,
  HOST_WRAPPER_HEADROOM_MS,
  HOST_WRAPPER_LONG_HEADROOM_MS,
} from "./lifecycle-budgets";
export {
  resolveLocalConfigFromEnv,
  resolveLockfilePath,
  resolveConfigDir,
  resolveDataDir,
  resolveLogDir,
  resolveAssistantsDir,
  resolveInstanceDir,
  guardianTokenPath,
  assistantBearerTokenPath,
  basetenTokenPath,
  deleteGuardianBootstrapSecret,
} from "./config";
export type { LocalEndpointConfig } from "./config";
export {
  cliCommand,
  defaultEnvironmentFilePath,
  ownVersion,
  readDefaultEnvironment,
  resolveEnvironmentName,
} from "./environment";
export {
  assertSafePathSegment,
  environmentDirectoryName,
  joinLocalPath,
  resolveConfigHome,
  resolveDataHome,
} from "./paths";
export {
  readLockfile,
  saveLockfileAssistant,
  isActiveAssistant,
} from "./lockfile";
export { servedConfigFromLockfile } from "./served-config";
export type { LockfileResult, WriteResult } from "./lockfile";
export { withLockfileLock } from "./lockfile-lock";
export type { LockfileLockResult } from "./lockfile-lock";
export {
  GATEWAY_PORT,
  getGatewayUrl,
  isAppleContainerEntry,
  isDockerEntry,
  isLocalEntry,
  LockfileAssistantSchema,
  MachineMemoryPolicySchema,
  MachinePolicySchema,
  parseLockfile,
} from "./lockfile-contract";
export type {
  Lockfile,
  LockfileAssistant,
  LocalAssistant,
  DockerAssistant,
  AppleContainerAssistant,
  CloudAssistant,
  CustomAssistant,
  BasetenAssistant,
  LockfileWriteResult,
  MachinePolicy,
  MachineMemoryPolicy,
  MachineApplicability,
} from "./lockfile-contract";
export type { LockfileAssistantPatch } from "./lockfile";
export {
  configureCliPaths,
  resolveCliInvocation,
  type CliPaths,
} from "./cli-invocation";
export { runHatch } from "./hatch";
export type { HatchResult } from "./hatch";
export { matchOperatorRequest } from "./operations/routes";
export type { OperatorRoute, OperatorMatch } from "./operations/routes";
export { retireAssistant } from "./operations/retire";
export type { RetireResult } from "./operations/retire";
export { sleepAssistant, type SleepOptions } from "./operations/sleep";
export type { SleepResult, SleepServiceStop } from "./operations/sleep";
export {
  machineGet,
  machineResetKey,
  machineSetKey,
  formatMachineBytes,
  parseMachineBytes,
  type MachineGetResult,
  type MachineMutationResult,
} from "./operations/machine";
export { drainAssistant, parseWaitDuration } from "./remotes/local/drain";
export type { DrainOutcome, DrainOptions } from "./remotes/local/drain";
export { sleepDocker } from "./remotes/docker/sleep";
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
export type { AssistantLookupResult } from "./operations/lookup";
export {
  getLocalInstanceDir,
  getDaemonPidPath,
} from "./remotes/local/instance";
export { retireLocal, getRetireArchiveCommand } from "./remotes/local/retire";
export type { RetireLocalResult } from "./remotes/local/retire";
export {
  validateAssistantName,
  getRetiredDir,
  resolveRetiredFilePath,
  getArchivePath,
  getMetadataPath,
} from "./remotes/local/archive";
export {
  dockerResourceNames,
  removeContainer,
  retireDocker,
} from "./remotes/docker/retire";
export { retireAppleContainer } from "./remotes/apple-container/retire";
export {
  stopContainerAppServer,
  stopIngressNginx,
  getIngressPaths,
  ingressStatePath,
  readIngressState,
  getIngressPid,
  isIngressRunning,
  isPidAlive,
} from "./ingress";
export type { IngressPaths, IngressState } from "./ingress";
export { exec, buildExecErrorMessage } from "./exec";
export {
  isCadetCommandLine,
  parseTasklistCsv,
  windowsCommandLineLookupArgs,
  readProcessCommandLine,
  readPosixCommandLine,
  isCadetWindowsProcess,
  isCadetProcess,
  isProcessAlive,
  removeFiles,
  stopProcess,
  stopProcessByPidFile,
} from "./process";
export type { TasklistProcess, ProcessAliveResult } from "./process";
export { readWindowsProcesses } from "./process";
export { loopbackSafeFetch, isLoopbackUrl } from "./loopback-fetch";
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
export type { LifecycleReporter } from "./lifecycle-reporter";
export { unpairAssistant } from "./unpair";
export {
  pairAssistant,
  checkPairedAssistantName,
  pairingStart,
  pairingPoll,
  pairingCancel,
} from "./pair";
export type {
  PairedAssistantCredentials,
  PairOptions,
  PairResult,
  PairRefusal,
  PairingFailure,
  PairingFailureReason,
  PairingStarted,
  PairingStartResult,
  PairingPollOptions,
  PairingPollResult,
} from "./pair";
export { runWake } from "./wake";
export type { WakeOptions, WakeResult } from "./wake";
export { runDevicesList, runDevicesRevoke } from "./devices";
export type {
  DeviceRecord,
  DevicesListResult,
  DevicesRevokeResult,
} from "./devices";
export { runUpgrade, isValidReleaseVersion } from "./upgrade";
export type { UpgradeOptions, UpgradeResult } from "./upgrade";
export { getLocalAssistantStatus } from "./status";
export { readLockfileAssistantAvatar } from "./avatar";
export type {
  LocalAssistantRuntimeState,
  LocalAssistantStatusResult,
} from "./status";
export {
  getGuardianAccessToken,
  isConfidentialRefreshUrl,
  formatGuardianRefreshCliFailure,
  parseGuardianRefreshCliFailure,
  GUARDIAN_REFRESH_ERROR_PREFIX,
  saveGuardianToken,
  saveBasetenSandboxToken,
  readBasetenSandboxToken,
} from "./guardian-token";
export type { TokenResult, GuardianTokenData } from "./guardian-token";
export {
  authorizePairedForwardHeaders,
  parseAssistantGatewayUrl,
  readGatewayTargets,
  resolveGatewayProxyTarget,
  sanitizePairedForwardHeaders,
  FLATTENED_FIRST_SEGMENTS,
} from "./gateway-proxy";
export {
  loopbackGatewayBearer,
  clearLoopbackGatewayBearerCache,
} from "./gateway-bearer";
export type { GuardianTokenLease } from "./gateway-bearer";
export type {
  GatewayTarget,
  GatewayParseResult,
  GatewayEntryTarget,
  GatewayProxyDecision,
  PairedForwardAuthorizationResult,
  PairedGuardianTokenProvider,
} from "./gateway-proxy";
