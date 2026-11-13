import { z } from "zod";

export const AuditLogConfigSchema = z
  .object({
    retentionDays: z
      .number({ error: "auditLog.retentionDays must be a number" })
      .int("auditLog.retentionDays must be an integer")
      .nonnegative("auditLog.retentionDays must be a non-negative integer")
      .default(0)
      .describe("Number of days to retain audit log entries (0 = disabled)"),
  })
  .describe("Audit log configuration for tracking security-relevant events");

/** Severity names accepted by `logFile.levels`. Shared with util/logger.ts. */
export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "silent",
] as const;

/**
 * The logger module tags that can be leveled from config — an allowlist, so
 * a typo'd kind fails config validation instead of silently doing nothing.
 * Exported for the `assistant logs` CLI's kind validation. Extend alongside
 * new getLogger() tags.
 */
export const LOG_MODULES = [
  "http-request",
  "tool-registry",
  "graph-capability-seed",
  "workspace-migrations",
  "db-init",
  "home-greeting",
  "suggested-prompts",
] as const;

/** Partial map of module tag → level (unset modules run at the root level). */
const LogLevelsConfigSchema = z.partialRecord(
  z.enum(LOG_MODULES),
  z.enum(LOG_LEVELS),
);

export const LogFileConfigSchema = z
  .object({
    dir: z
      .string({ error: "logFile.dir must be a string" })
      .optional()
      .describe("Directory path for log file storage"),
    retentionDays: z
      .number({ error: "logFile.retentionDays must be a number" })
      .int("logFile.retentionDays must be an integer")
      .positive("logFile.retentionDays must be a positive integer")
      .default(30)
      .describe("Number of days to retain log files before automatic deletion"),
    levels: LogLevelsConfigSchema.default({}).describe(
      "Per-module log levels, applied live (no restart). " +
        "`assistant logs set --kind http --level info` writes here.",
    ),
  })
  .describe("Log file storage, retention, and runtime log-level settings");

export type AuditLogConfig = z.infer<typeof AuditLogConfigSchema>;
export type LogFileConfig = z.infer<typeof LogFileConfigSchema>;
