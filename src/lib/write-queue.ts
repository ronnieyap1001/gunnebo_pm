/**
 * Per-key serial queue for writes from the browser. One write per project is in flight at a time, in order, so
 * project mirrors (cells/progress) never race within a tab and each write sees the previous write's result.
 */
type Task<T> = () => Promise<T>;

const tails = new Map<string, Promise<unknown>>();
const pending = new Map<string, number>();
const listeners = new Set<(key: string, count: number) => void>();

export function enqueue<T>(key: string, task: Task<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.finally(() => {
    const n = (pending.get(key) ?? 1) - 1;
    if (n <= 0) {
      pending.delete(key);
      if (tails.get(key) === tail) tails.delete(key);
    } else {
      pending.set(key, n);
    }
    notify(key);
  });
  tails.set(key, tail);
  pending.set(key, (pending.get(key) ?? 0) + 1);
  notify(key);
  return run;
}

/** Number of queued or in-flight writes for a key (for a "Saving…" indicator). */
export function pendingCount(key: string): number {
  return pending.get(key) ?? 0;
}

export function onQueueChange(fn: (key: string, count: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(key: string) {
  const count = pendingCount(key);
  for (const fn of listeners) fn(key, count);
}

/** A fresh id for one user action (passed to the server as opId). */
export function newOpId(): string {
  return crypto.randomUUID();
}
