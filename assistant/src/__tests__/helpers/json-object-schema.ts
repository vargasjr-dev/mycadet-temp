import { z } from "zod";

export const jsonObjectSchema = z.record(z.string(), z.unknown());
