/**
 * The assistant's status dials — healthz and the pressure pair — at the
 * daemon sdk's scoped paths. The daemon sdk is a legal import; the legacy
 * `assistant/api.ts` compatibility module this replaces was not (it mixed
 * these with the cloud sdk's dials).
 */

import type { ZodType } from "zod";

import {
  type DiskPressureStatusResponse,
  DiskPressureStatusResponseSchema,
  type ResourcePressureStatusResponse,
  ResourcePressureStatusResponseSchema,
} from "@mycadet/assistant-api";

import {
  diskpressureAcknowledgePost,
  diskpressureStatusGet,
  healthzGet,
  resourcepressureStatusGet,
} from "@/generated/daemon/sdk.gen";
import type { HealthzGetResponse } from "@/generated/daemon/types.gen";
import { assertHasResponse, toErrorObject } from "@/utils/api-errors";

export type ParsedResponseResult<TData> =
  | { ok: true; status: number; data: TData }
  | { ok: false; status: number; error: Record<string, unknown> };

export type GetHealthzResult =
  | { ok: true; status: number; data: HealthzGetResponse }
  | { ok: false; status: number; error: Record<string, unknown> };

export type GetAssistantDiskPressureStatusResult =
  ParsedResponseResult<DiskPressureStatusResponse>;

export type AcknowledgeAssistantDiskPressureResult =
  ParsedResponseResult<DiskPressureStatusResponse>;

export type GetAssistantResourcePressureStatusResult =
  ParsedResponseResult<ResourcePressureStatusResponse>;

/**
 * Normalize a `throwOnError: false` SDK result whose success body must
 * match `schema` into the `{ ok, status, data | error }` shape.
 */
function parseWrappedResponse<TData>(
  {
    data,
    error,
    response,
  }: { data: unknown; error: unknown; response?: Response },
  schema: ZodType<TData>,
  failureMessage: string,
): ParsedResponseResult<TData> {
  assertHasResponse(response, error, failureMessage);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: toErrorObject(error, response),
    };
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      status: response.status,
      error: toErrorObject(parsed.error.message, response),
    };
  }

  return {
    ok: true,
    status: response.status,
    data: parsed.data,
  };
}

export async function getAssistantHealthz(
  assistantId: string,
): Promise<GetHealthzResult> {
  const { data, error, response } = await healthzGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to get assistant healthz.");

  if (response.ok && data) {
    return {
      ok: true,
      status: response.status,
      data,
    };
  }

  return {
    ok: false,
    status: response.status,
    error: toErrorObject(error, response),
  };
}

export async function getAssistantDiskPressureStatus(
  assistantId: string,
): Promise<GetAssistantDiskPressureStatusResult> {
  return parseWrappedResponse(
    await diskpressureStatusGet({
      path: { assistant_id: assistantId },
      throwOnError: false,
    }),
    DiskPressureStatusResponseSchema,
    "Failed to get assistant disk pressure status.",
  );
}

export async function getAssistantResourcePressureStatus(
  assistantId: string,
): Promise<GetAssistantResourcePressureStatusResult> {
  return parseWrappedResponse(
    await resourcepressureStatusGet({
      path: { assistant_id: assistantId },
      throwOnError: false,
    }),
    ResourcePressureStatusResponseSchema,
    "Failed to get assistant resource pressure status.",
  );
}

export async function acknowledgeAssistantDiskPressure(
  assistantId: string,
): Promise<AcknowledgeAssistantDiskPressureResult> {
  return parseWrappedResponse(
    await diskpressureAcknowledgePost({
      path: { assistant_id: assistantId },
      throwOnError: false,
    }),
    DiskPressureStatusResponseSchema,
    "Failed to acknowledge assistant disk pressure.",
  );
}
