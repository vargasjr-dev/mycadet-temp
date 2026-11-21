/**
 * The preload bridge's contributor registry: preload features contribute
 * named bridges into the `CadetBridge` object the renderer consumes. Unlike
 * the main process — where features import each other directly — the
 * preload's contributors are assembled before any consumer exists, so the
 * two-phase contribute/build registry is the honest shape there.
 */
export class BridgeCapabilityRegistry<Bridge extends object> {
  readonly #bridge: Partial<Bridge>;

  constructor(base: Partial<Bridge>) {
    this.#bridge = { ...base };
  }

  contribute<Key extends keyof Bridge>(key: Key, value: Bridge[Key]): void {
    if (Object.prototype.hasOwnProperty.call(this.#bridge, key)) {
      throw new Error(`Bridge capability already registered: ${String(key)}`);
    }
    this.#bridge[key] = value;
  }

  build(): Partial<Bridge> {
    return { ...this.#bridge };
  }
}
