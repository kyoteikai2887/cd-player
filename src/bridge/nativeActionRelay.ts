import type { ActionResult, Surface, UIAction } from '../contracts/player.ts';

export type NativeActionStage = 'received' | 'handled' | 'published';
/** Diagnostics must never delay dispatch, publication or the acknowledged result. */
export async function relayNativeAction(options: {
  surface: Surface; action: UIAction; deadlineMs: number; clockOffset: number;
  now(): number;
  dispatch(action: UIAction, budgetMs: number): Promise<ActionResult>;
  publication(): Promise<unknown>;
  report(stage: NativeActionStage): Promise<unknown>;
  resolve(result: ActionResult): Promise<unknown>;
}) {
  const report = (stage: NativeActionStage) => {
    try { void options.report(stage).catch(() => {}); } catch { /* Logging is optional. */ }
  };
  report('received');
  let result: ActionResult;
  try {
    result = await options.dispatch(options.action, Math.min(4000, options.deadlineMs - options.now() - options.clockOffset - 100));
  } catch {
    result = { ok: false, code: 'unknown', message: '播放操作未完成。' };
  }
  report('handled');
  // The native caller must see the committed snapshot before receiving success/conflict.
  await options.publication();
  report('published');
  await options.resolve(result);
}
