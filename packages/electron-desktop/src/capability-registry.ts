/**
 * The preload bridge's contributor registry: preload features contribute
 * named bridges into the `CadetBridge` object the renderer consumes. Unlike
 * the main process — where features import each other directly — the
 * preload's contributors are assembled before any consumer exists, so the
 * two-phase contribute/build registry is the honest shape there.
 *
 * A surface may also be extended by a second feature: the shared helper
 * feature claims the platform-independent helper (ping, state, dictation)
 * and a platform feature extends the same `helper` key with its own hotkey
 * flavor. {@link extend} merges one level deep; two features defining the
 * same method is a composition bug and still throws.
 */
export class BridgeCapabilityRegistry<Bridge extends object> {
  readonly #bridge: Partial<Bridge>;

  constructor(base: Partial<Bridge>) {
    this.#bridge = { ...base };
  }

  /** First claim on a surface — the complete value for that key. */
  contribute<Key extends keyof Bridge>(key: Key, value: Bridge[Key]): void {
    if (Object.prototype.hasOwnProperty.call(this.#bridge, key)) {
      throw new Error(`Bridge capability already registered: ${String(key)}`);
    }
    this.#bridge[key] = value;
  }

  /** Add methods to a surface another feature already claimed. */
  extend<Key extends keyof Bridge>(
    key: Key,
    value: Partial<Bridge[Key]>,
  ): void {
    const existing = this.#bridge[key];
    if (!isPlainObject(existing)) {
      throw new Error(
        `Bridge capability to extend not yet registered: ${String(key)}`,
      );
    }
    const additions: Record<string, unknown> = {};
    for (const [method, impl] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(existing, method)) {
        throw new Error(
          `Bridge capability method already registered: ${String(key)}.${method}`,
        );
      }
      additions[method] = impl;
    }
    Object.assign(existing, additions);
  }

  build(): Partial<Bridge> {
    return { ...this.#bridge };
  }

  /** Whether a feature already claimed this surface. */
  has(key: keyof Bridge): boolean {
    return Object.prototype.hasOwnProperty.call(this.#bridge, key);
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
