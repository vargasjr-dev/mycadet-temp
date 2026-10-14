import { z } from "zod";

// Only tiers accepted by the cloud's custom upgrade endpoint.
const SelectionSchema = z.object({
  machineTier: z.enum(["medium", "large", "xl"]).nullable(),
  storageTier: z.enum(["xs", "s", "m", "l"]),
  creditTier: z
    .enum([
      "credits_10",
      "credits_25",
      "credits_50",
      "credits_100",
      "credits_200",
    ])
    .nullable(),
});
export type CustomCheckoutSelection = z.infer<typeof SelectionSchema>;

export function parseCustomCheckoutSelection(
  searchParams: URLSearchParams,
): CustomCheckoutSelection | null {
  const parsed = SelectionSchema.safeParse({
    machineTier: searchParams.get("machine_tier"),
    storageTier: searchParams.get("storage_tier"),
    creditTier: searchParams.get("credit_tier"),
  });
  return parsed.success ? parsed.data : null;
}
