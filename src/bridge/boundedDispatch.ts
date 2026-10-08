import type { ActionResult, UIAction } from "../contracts/player.ts";

export interface DispatchContext {
  signal: AbortSignal;
  isActive(): boolean;
}
export const ACTION_TIMEOUT_MS = 5000;

/** Transport handlers must check isActive before committing after any await. */
export function createBoundedDispatcher(
  handler: (
    action: UIAction,
    context: DispatchContext,
  ) => Promise<ActionResult> | ActionResult,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid dispatch timeout");
  let disposed = false;
  const pending = new Set<AbortController>();
  const unavailable: ActionResult = {
    ok: false,
    code: "unavailable",
    message: "播放核心未及时响应，请重试。",
  };
  function dispatch(
    action: UIAction,
    budgetMs = timeoutMs,
  ): Promise<ActionResult> {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > timeoutMs)
      return Promise.resolve(unavailable);
    if (disposed) return Promise.resolve(unavailable);
    const controller = new AbortController();
    pending.add(controller);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: ActionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(controller);
        controller.signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => finish(unavailable);
      const timer = setTimeout(() => controller.abort(), budgetMs);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const context = {
        signal: controller.signal,
        isActive: () => !disposed && !controller.signal.aborted && !settled,
      };
      Promise.resolve()
        .then(() =>
          context.isActive() ? handler(action, context) : unavailable,
        )
        .then(finish, () =>
          finish({ ok: false, code: "unknown", message: "操作失败，请重试。" }),
        );
    });
  }
  return {
    dispatch,
    destroy() {
      disposed = true;
      for (const controller of pending) controller.abort();
    },
  };
}
