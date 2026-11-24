import { SEEDS } from "@mycadet/shared/seeds";

export const APEX_DOMAIN = new URL(SEEDS.production.baseUrl).hostname;
export const APEX_ORIGIN = `https://${APEX_DOMAIN}`;
