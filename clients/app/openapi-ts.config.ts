import { defineConfig } from "@hey-api/openapi-ts";

/**
 * The app's daemon wire types. The transform reads `assistant/openapi.yaml`
 * (via web's script — the daemon contract has one owner) into
 * `../web/openapi-schemas/daemon.json`, and this config generates the
 * type-only surface the app's gateway client is typed against. No generated
 * client runs app-side — invokes go through `@app/gateway/daemon`.
 */
export default defineConfig([
  {
    input: "../web/openapi-schemas/daemon.json",
    output: "src/generated/daemon",
    plugins: ["@hey-api/client-fetch"],
  },
]);
