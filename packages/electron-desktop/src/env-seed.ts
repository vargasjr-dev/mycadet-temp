// Must run before anything reads the environment at runtime: seeds
// process.env.CADET_ENVIRONMENT from the build define so the shared
// resolver (which reads the env) agrees with what the shell was built for.
declare const __CADET_ENVIRONMENT__: string;

if (
  typeof __CADET_ENVIRONMENT__ === "string" &&
  !process.env.CADET_ENVIRONMENT
) {
  process.env.CADET_ENVIRONMENT = __CADET_ENVIRONMENT__;
}
