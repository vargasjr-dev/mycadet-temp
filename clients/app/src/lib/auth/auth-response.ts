import { z } from "zod";

export const AuthFlowSchema = z.object({
  id: z.string(),
  is_pending: z.boolean().optional(),
});
export const AccountUserSchema = z.object({
  id: z.string().optional(),
  display: z.string().optional(),
  email: z.string().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});
export const SessionSchema = z.object({ user: AccountUserSchema });
export const ProviderSignupSchema = z.object({ user: AccountUserSchema });
const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  param: z.string().optional(),
});
const ErrorResponseSchema = z.object({
  errors: z.array(ErrorSchema).optional(),
  data: z.object({ flows: z.array(AuthFlowSchema).optional() }).optional(),
});

export type AllauthResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status?: number;
      errors: z.infer<typeof ErrorSchema>[];
      flows?: z.infer<typeof AuthFlowSchema>[];
    };

export function authErrorResult(
  value: unknown,
  status?: number,
): AllauthResult<never> {
  const parsed = ErrorResponseSchema.safeParse(value);
  if (!parsed.success) return { ok: false, status, errors: [] };
  if (parsed.data.errors)
    return { ok: false, status, errors: parsed.data.errors };
  const flows = parsed.data.data?.flows;
  return { ok: false, status, errors: [], ...(flows ? { flows } : {}) };
}
