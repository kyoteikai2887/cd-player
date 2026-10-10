/** Main renderer/backend liveness is independent of audio samples and UI changes. */
export function startNativeHeartbeat(options: {
  probe(signal: AbortSignal): Promise<void>;
  report(ready: boolean): Promise<unknown>;
  intervalMs?: number;
  timeoutMs?: number;
}) {
  const intervalMs = options.intervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 1500;
  let disposed = false;
  let active = false;
  let wakePending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: AbortController | undefined;
  async function bounded(work: (signal: AbortSignal) => Promise<unknown>) {
    const controller = new AbortController();
    current = controller;
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error("Core heartbeat interrupted"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try { await Promise.race([work(controller.signal), aborted]); }
    finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", rejectAbort);
      current = undefined;
    }
  }
  async function beat() {
    if (disposed || active) return;
    active = true;
    wakePending = false;
    try {
      let ready = false;
      try { await bounded(options.probe); ready = true; }
      catch { /* Even a probe ignoring AbortSignal must stop blocking recovery. */ }
      if (disposed || wakePending) return;
      // Use a separate deadline for native IPC: a lost report reply must not
      // strand future checks, and a probe timeout must still publish false.
      try { await bounded(() => options.report(ready)); }
      catch { /* The host watchdog independently detects a missing IPC response. */ }
    } finally {
      active = false;
      if (!disposed) timer = setTimeout(() => void beat(), wakePending ? 0 : intervalMs);
    }
  }
  const stop = () => {
    disposed = true;
    clearTimeout(timer);
    current?.abort();
  };
  // Visibility/focus after sleep starts a new check without changing audio state.
  stop.wake = () => {
    if (disposed) return;
    clearTimeout(timer);
    if (active) { wakePending = true; current?.abort(); }
    else void beat();
  };
  void beat();
  return stop;
}
