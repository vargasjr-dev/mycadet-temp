import { z } from "zod";

/** The native host returns credentials across an IPC boundary. */
export const DesktopSessionResponseSchema = z.object({
  sessionToken: z.string().min(1),
});
