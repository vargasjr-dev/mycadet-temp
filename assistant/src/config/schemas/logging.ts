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
  })
  .describe("Log file storage and retention settings");

const MODULE_LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "silent"];

export const LogsConfigSchema = z
  .object({
    moduleLevels: z
      .record(z.string(), z.enum(MODULE_LOG_LEVELS as [string, ...string[]]))
      .default({})
      .describe(
        "Per-module log-level overrides applied live (no restart): keys are "
          + "logger module tags (e.g. \"http-request\", \"workspace-migrations\"), "
          + "values are levels. `assistant logs set --kind <module> --level "
          + "<level>` writes here.",
      ),
  })
  .describe("Runtime log-level configuration");

export type LogsConfig = z.infer<typeof LogsConfigSchema>;
export type AuditLogConfig = z.infer<typeof AuditLogConfigSchema>;
export type LogFileConfig = z.infer<typeof LogFileConfigSchema>;
