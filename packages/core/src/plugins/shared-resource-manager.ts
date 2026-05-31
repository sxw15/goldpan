export interface SharedResourceManagerOptions<T> {
  launcher: () => Promise<T>;
  destroyer: (resource: T) => Promise<void>;
  cooldownMs?: number;
}

export class SharedResourceManager<T> {
  private readonly launcher: () => Promise<T>;
  private readonly destroyer: (resource: T) => Promise<void>;
  private readonly cooldownMs: number;

  private resource: T | null = null;
  private launchPromise: Promise<T> | null = null;
  private cooldownUntil = 0;
  /** Incremented on every destroy; stale launches check this to avoid reviving the resource. */
  private generation = 0;

  constructor(options: SharedResourceManagerOptions<T>) {
    this.launcher = options.launcher;
    this.destroyer = options.destroyer;
    this.cooldownMs = options.cooldownMs ?? 30_000;
  }

  async acquire(): Promise<T> {
    if (this.resource) return this.resource;
    if (this.launchPromise) return this.launchPromise;

    const now = Date.now();
    if (now < this.cooldownUntil) {
      const remainMs = this.cooldownUntil - now;
      throw new Error(`Resource in cooldown — available after ${remainMs}ms`);
    }

    const gen = this.generation;
    this.launchPromise = this.launcher().then(
      async (r) => {
        this.launchPromise = null;
        if (gen !== this.generation) {
          await this.destroyer(r).catch(() => {});
          throw new Error('Resource manager was destroyed during launch');
        }
        this.resource = r;
        return r;
      },
      (err) => {
        this.launchPromise = null;
        if (gen === this.generation) {
          this.cooldownUntil = Date.now() + this.cooldownMs;
        }
        throw err;
      },
    );
    return this.launchPromise;
  }

  async destroyWithCooldown(): Promise<void> {
    await this.destroyInternal();
    this.cooldownUntil = Date.now() + this.cooldownMs;
  }

  async destroy(): Promise<void> {
    await this.destroyInternal();
  }

  get isAvailable(): boolean {
    return this.resource !== null;
  }

  private async destroyInternal(): Promise<void> {
    this.generation++;
    const pendingLaunch = this.launchPromise;
    const r = this.resource;
    this.resource = null;
    this.launchPromise = null;

    if (pendingLaunch) {
      await pendingLaunch.catch(() => {});
    }

    if (r) {
      await this.destroyer(r);
    }
  }
}
