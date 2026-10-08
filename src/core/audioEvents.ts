/** State changes wake the owner once per turn, without a reentrant playback tick. */
export function createAudioEvents() {
  type Subscription = { listener: () => void };
  const listeners = new Set<Subscription>();
  const pending = new Set<Subscription>();
  let queued = false,
    disposed = false;
  return {
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      const subscription = { listener };
      listeners.add(subscription);
      return () => {
        listeners.delete(subscription);
        pending.delete(subscription);
      };
    },
    notify() {
      if (disposed || listeners.size === 0) return;
      for (const subscription of listeners) pending.add(subscription);
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const batch = [...pending];
        pending.clear();
        if (disposed) return;
        for (const subscription of batch)
          if (listeners.has(subscription)) subscription.listener();
      });
    },
    dispose() {
      disposed = true;
      listeners.clear();
      pending.clear();
    },
  };
}
