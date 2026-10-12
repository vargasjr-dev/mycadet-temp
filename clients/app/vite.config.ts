import path from "node:path";
import { defineConfig, type ConfigEnv, type UserConfig } from "vite";
import webConfig from "../web/vite.config";

const APP_SRC = path.resolve(import.meta.dirname, "src");
const WEB_SRC = path.resolve(import.meta.dirname, "../web/src");

const webFactory = webConfig as unknown as (env: ConfigEnv) => UserConfig;

// The desktop renderer builds web's full config (base, dev proxy, chunk
// groups) and composes the account routes into the tree on top.
export default defineConfig((env) => {
  const web = webFactory(env);
  return {
    ...web,
    // App composes its own account routes and tray dialog.
    define: { ...web.define, __INCLUDES_ACCOUNT__: "false" },
    server: { ...web.server, port: Number(process.env.PORT || "3001") },
    publicDir: "../web/public",
    resolve: {
      ...web.resolve,
      alias: [
        { find: /^@app\//, replacement: APP_SRC + "/" },
        { find: /^@web\//, replacement: WEB_SRC + "/" },
        { find: /^@\//, replacement: WEB_SRC + "/" },
      ],
    },
  };
});
