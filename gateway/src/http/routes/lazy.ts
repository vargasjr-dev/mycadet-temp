/**
 * Module-scoped late binding for route modules whose handlers need
 * server-startup state (config, caches, clients).
 *
 * A route module must stay import-safe without side effects — the OpenAPI
 * generation script imports every ROUTES array but never wires deps. So the
 * handler-free module state is filled in once by the server's
 * `initGatewayRoutes` fan-out and read lazily (and loudly) by handlers.
 */
export function lazyRef<T>(label: string): {
  set: (value: T) => void;
  get: () => T;
} {
  let value: T | undefined;
  return {
    set(next) {
      value = next;
    },
    get() {
      if (value === undefined) {
        throw new Error(`${label} used before initialization`);
      }
      return value;
    },
  };
}
