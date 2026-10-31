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
  })
  .describe("Log file storage settings");

export type AuditLogConfig = z.infer<typeof AuditLogConfigSchema>;
export type LogFileConfig = z.infer<typeof LogFileConfigSchema>;
