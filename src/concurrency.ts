// Bounded parallel map. Results keep input order. Not exported from the
// package entry point.

/**
 * Like `Promise.all(items.map(fn))` but with at most `limit` calls running at
 * once. A limit below 1 (or NaN) runs serially. The first rejection rejects the
 * result and stops starting new work; calls already running finish.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
