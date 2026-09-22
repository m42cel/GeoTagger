/**
 * Runs `worker` over `items` with at most `concurrency` in flight.
 *
 * Concurrency is bounded and configurable, defaulting to 2 — appropriate for a
 * low-power ARM CPU where more parallel decodes only lengthen the queue (SPEC §10.1).
 */
export async function runPool<T>(
  items: Iterable<T>,
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  const iterator = items[Symbol.iterator]();
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      if (shouldStop?.()) return;
      const next = iterator.next();
      if (next.done) return;
      await worker(next.value);
    }
  });
  await Promise.all(lanes);
}
