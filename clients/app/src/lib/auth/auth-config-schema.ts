import { z } from "zod";

export const AuthConfigurationSchema = z.object({
  account: z.object({ is_open_for_signup: z.boolean() }),
});
export type AuthConfiguration = z.infer<typeof AuthConfigurationSchema>;
