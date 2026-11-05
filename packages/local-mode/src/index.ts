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
} from "./config";
export { stageBasetenBuildContext } from "./remotes/baseten/context";
export { execBasetenSandbox } from "./remotes/baseten/exec";
export { localExecDirForService } from "./remotes/local/exec";
export {
  assistantBackupFilenamePattern,
  CLI_BACKUP_KINDS,
  type CliBackupKind,
  createBackup,
  formatSize,
  getBackupsDir,
  listAssistantBackupTimes,
  pruneOldBackups,
  restoreBackup,
} from "./backup-ops";
export {
  createRootBackup,
  DockerRootStorage,
  initializeRootArchive,
  LocalRootStorage,
  packRoot,
  restoreRootBackup,
  stageRootArchive,
  validateRootArchive,
  withRootOperationLock,
  type RootStorage,
  STATE_ROOTS,
} from "./root-backup";
export { type ManagedProcessEntry } from "./daemon-readiness";
export {
  compareVersions,
  isVersionCompatible,
  parseVersion,
  versionsEqual,
} from "./version-compat";
export {
  fetchLatestVersion,
  fetchReleases,
  type ReleaseListItem,
} from "./cloud-releases";
export {
  evaluateUpgradePoll,
  resolveUpgradeTarget,
  type UpgradePollState,
  type UpgradeTargetResolution,
} from "./upgrade-preflight";
export { fetchGatewayPs } from "./daemon-readiness";
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
export { withLockfileLock } from "./lockfile-lock";
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
export {
  configureCliPaths,
  resolveCliInvocation,
  type CliPaths,
} from "./cli-invocation";
export {
  matchOperatorRequest,
  forwardOperatorRequest,
  OPERATOR_ROUTES,
} from "./operations/routes";
export type {
  OperatorRoute,
  OperatorMatch,
  OperatorRequest,
} from "./operations/routes";
export { retireAssistant } from "./operations/retire";
export { sleepAssistant, type SleepOptions } from "./operations/sleep";
export {
  hatchAssistant,
  type HatchAssistantParams,
  type HatchAssistantResult,
} from "./operations/hatch";
export { allocateLocalPlacement } from "./remotes/local/hatch";
export {
  buildHatchConfigValues,
  writeInitialConfig,
} from "./remotes/local/hatch-config";
export { wakeAssistant } from "./operations/wake";
export {
  restartAssistant,
  type RestartReport,
  type RestartAssistantResult,
} from "./operations/restart";
export {
  backupAssistant,
  type BackupAssistantResult,
} from "./operations/backup";
export {
  createCloudBackup,
  listCloudBackups,
  type CreateCloudBackupOptions,
} from "./remotes/cloud/backup";
export {
  AVATAR_DEVICE_ENV_VAR,
  DOCKER_STATEFUL_SET_SPEC,
  buildServiceRunArgs,
  getBuilderManagedEnvKeys,
  resolveAvatarDevicePath,
  stopContainers,
  type DockerStatefulSetSpec,
  type ServiceName,
} from "./remotes/docker/statefulset";
export {
  startContainers,
  wakeDocker,
  type WakeDockerOptions,
} from "./remotes/docker/wake";
export {
  PROVIDER_ENV_VAR_NAMES,
  SEARCH_PROVIDER_ENV_VAR_NAMES,
} from "./provider-env-vars";
export {
  ensureDockerDaemonRunning,
  startColimaAndAwaitDaemon,
  ensureLocalBinOnPath,
  LOCAL_BIN_DIR,
  isNoSuchContainerError,
} from "./remotes/docker/common";
export {
  dockerhubImages,
  resolveImageRefs,
  resolveOwnImageRefs,
  ensureDockerInstalled,
  pullImage,
} from "./remotes/docker/hatch";

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
  ensureSelfHostedLocalRegistration,
  reprovisionAssistantApiKey,
  resolveAssistantApiKeyForInjection,
  registerLocalAssistantWithCloud,
  fetchCurrentUser,
  fetchAssistantIngressUrl,
  injectCredentialsIntoAssistant,
  readGatewayCredential,
  verifyGatewayCloudCredential,
} from "./cloud-registration";
export type {
  EnsureRegistrationResponse,
  ReprovisionApiKeyResponse,
  GatewayCredentialResult,
  CredentialInjectionParams,
  AssistantApiKeySource,
  ResolveAssistantApiKeyArgs,
  ResolvedAssistantApiKey,
  PlatformUser,
} from "./cloud-registration";
export type {
  EnsureProviderApiKeyOptions,
  EnsureProviderApiKeyResult,
  GatewayApiKeyReadResult,
  HatchProviderApiKeyOptions,
  LlmProviderId,
  ProviderApiKeySource,
  ProviderSecretFetch,
} from "./provider-credentials";
export {
  ensureLocalRuntime,
  getLocalRuntimeInstallDir,
  type LocalRuntimeInstall,
  gatewayCliInvocation,
  resolveCesSocketPath,
  setStartupLogging,
  findPidListeningOnPort,
  discoverPublicUrl,
  isAssistantWatchModeAvailable,
  isGatewayWatchModeAvailable,
} from "./remotes/local/common";
export {
  healConflictedLocalPorts,
  type PortHealMove,
  type PortHealResult,
  type PortHealDeps,
} from "./remotes/local/port-heal";
export {
  DEFAULT_PORTS,
  getDefaultPorts,
  findOpenPort,
  findAvailablePort,
  probePort,
  ASSISTANT_INTERNAL_PORT,
  GATEWAY_INTERNAL_PORT,
} from "./ports";
export {
  buildDaemonUrl,
  httpHealthCheck,
  waitForDaemonReady,
  classifyReadyzResponse,
  probeDaemonReadiness,
  probeDaemonReadinessWithRetry,
  waitForDaemonMigrationsReady,
  checkHealth,
  type DaemonReadiness,
  type GatewayHealth,
  type HttpProbeEndpoint,
} from "./daemon-readiness";
export {
  openLogFile,
  resetLogFile,
  archiveLogFile,
  closeLogFile,
  writeToLogFile,
  pipeToLogFile,
  openRuntimeLogFile,
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
export {
  getLocalInstanceDir,
  getDaemonPidPath,
} from "./remotes/local/instance";
export { retireLocal } from "./remotes/local/retire";
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
  stopProcessGracefully,
  executableName,
  pathListDelimiter,
  isProcessHealthy,
  resolveProcessState,
} from "./process";
export type {
  TasklistProcess,
  ProcessAliveResult,
  ProcessHealthResult,
  ProcessState,
} from "./process";
export { loopbackSafeFetch, isLoopbackUrl } from "./loopback-fetch";
export {
  pairDevice,
  type PairDeviceIdentity,
  type PairOperationResult,
} from "./operations/pair";
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
export { runDevicesList, runDevicesRevoke } from "./devices";
export type {
  DeviceRecord,
  DevicesListResult,
  DevicesRevokeResult,
} from "./devices";
export { stripVersionPrefix } from "./version";
export {
  upgradeAssistant,
  type UpgradeAssistantParams,
  type UpgradeAssistantResult,
} from "./operations/upgrade";
export {
  attemptFailedStateRestore,
  broadcastUpgradeEvent,
  buildCompleteEvent,
  buildProgressEvent,
  buildReplayEnv,
  buildReplayState,
  buildStartingEvent,
  buildUpgradeCommitMessage,
  captureContainerEnv,
  captureReplayState,
  captureUpgradeFailureLogs,
  commitWorkspaceViaGateway,
  performDockerRollback,
  rollbackMigrations,
  UPGRADE_PROGRESS,
  waitForReady,
  type PerformDockerRollbackOptions,
} from "./upgrade-lifecycle";
export {
  upgradeLocal,
  targetVersionFromCli,
  resolveLatestStableTag,
} from "./remotes/local/upgrade";
export {
  teleportAssistant,
  type TeleportAssistantResult,
} from "./operations/teleport";
export {
  restoreAssistant,
  type RestoreAssistantResult,
} from "./operations/restore";
export {
  cloudPollJobStatus,
  cloudRequestSignedUrl,
  parseUnifiedJobStatus,
  cloudImportBundleFromGcs,
  cloudImportPreflightFromGcs,
  cloudUploadToSignedUrl,
  VersionMismatchError,
  type BundleCompatibility,
  type UnifiedJobStatus,
} from "./remotes/cloud/migrations";
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
