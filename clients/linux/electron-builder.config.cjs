// @ts-check

const env = process.env.CADET_ENVIRONMENT || "local";
const bucketEnv = env === "production" ? "prod" : env;
const targetArch =
  process.env.ELECTRON_TARGET_ARCH ||
  (process.arch === "arm64" ? "arm64" : "x64");

const productName =
  env === "production"
    ? "Cadet"
    : `Cadet ${env.charAt(0).toUpperCase() + env.slice(1)}`;

const appId =
  env === "production" ? "ai.mycadet.electron" : `ai.mycadet.electron-${env}`;

const schemes = env === "production" ? ["cadet"] : [`cadet-${env}`];

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId,
  productName,
  publish: {
    provider: "generic",
    url: `https://storage.googleapis.com/mycadet-${bucketEnv}-releases/linux-electron/${targetArch}/`,
  },
  directories: {
    output: "dist",
  },
  extraResources: [
    { from: "resources/bun", to: "bun" },
    { from: "resources/web-dist", to: "web-dist" },
    { from: "resources/app-dist", to: "app-dist" },
    { from: "resources/cli-lockfile", to: "cli-lockfile" },
    { from: "build/icon.png", to: "icon.png" },
  ],
  afterPack: "./scripts/afterPack.cjs",
  linux: {
    icon: "build/icon.png",
    category: "Utility",
    target: [
      {
        target: "AppImage",
        arch: [targetArch],
      },
    ],
    maintainer: "Cadet AI",
    vendor: "Cadet AI",
    executableName: "cadet-linux",
  },
  protocols: [
    {
      name: "Cadet Deep Links",
      schemes,
    },
  ],
  fileAssociations: [
    {
      ext: "cadet",
      name: "Cadet Bundle",
    },
  ],
};
