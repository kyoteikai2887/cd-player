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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: AbortController | undefined;
  async function beat() {
    if (disposed) return;
    const controller = new AbortController();
    current = controller;
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error("Core heartbeat interrupted"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    let ready = false;
    try {
      // A broken probe may ignore AbortSignal; it must still stop blocking recovery.
      await Promise.race([options.probe(controller.signal), aborted]);
      ready = true;
    } catch {
      ready = false;
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", rejectAbort);
      current = undefined;
    }
    if (disposed) return;
    try {
      await options.report(ready);
    } catch {
      // The host watchdog independently detects a missing renderer/IPC response.
    }
    if (!disposed) timer = setTimeout(() => void beat(), intervalMs);
  }
  void beat();
  return () => {
    disposed = true;
    clearTimeout(timer);
    current?.abort();
  };
}
