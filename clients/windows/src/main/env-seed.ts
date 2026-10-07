// Must be the first import in index.ts so that process.env.CADET_ENVIRONMENT
// is seeded before any other module reads it at module scope.
declare const __CADET_ENVIRONMENT__: string;

process.env.CADET_DESKTOP_APP = "1";

if (
  typeof __CADET_ENVIRONMENT__ === "string" &&
  !process.env.CADET_ENVIRONMENT
) {
  process.env.CADET_ENVIRONMENT = __CADET_ENVIRONMENT__;
}
