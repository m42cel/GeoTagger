/**
 * Caps concurrent work to `count` at a time — the per-provider concurrency limit of
 * SPEC §7.1. A pool worker (`scan/pool.ts`) runs over a known list; tile requests
 * arrive one at a time from the browser as it pans, so this is a standing gate
 * requests queue up behind instead.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(count: number) {
    this.available = Math.max(1, count);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }
}
