import { build } from "vite";

// Both entry formats share vite.config.ts and the exported app implementation.
for (const target of ["package", "standalone"]) {
  process.env.APP_BUILD_TARGET = target;
  await build();
}
