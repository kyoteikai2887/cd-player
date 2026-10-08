import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ActionResult, UIAction } from '../../contracts/player.ts';

/**
 * Action runner shared by a surface.
 * - No optimistic state: the snapshot stays the source of truth.
 * - "In progress" shows only after 150 ms, on the control that started it.
 * - ok:false is shown inline in the slot that started it (the core sends no Notice for it).
 * - cancelled is quiet and clears the slot.
 */
export type Slot = 'library' | 'album' | 'transport' | 'lyrics' | 'queue' | 'settings' | 'mini' | 'metadata' | 'editor' | 'metaEdit' | 'remove' | 'review';

export interface RunOptions { slot: Slot; key?: string }
export interface ActionsApi {
  run(action: UIAction, options: RunOptions): Promise<ActionResult>;
  isPending(key: string): boolean;
  error(slot: Slot): string | null;
  /** Shows a message in a slot without running an action (an outcome reported elsewhere). */
  show(slot: Slot, message: string): void;
  clear(slot: Slot): void;
}

const fallbackFailure: ActionResult = { ok: false, code: 'unknown', message: '操作没有完成，请重试。' };
const ActionsContext = createContext<ActionsApi | null>(null);

export function ActionsProvider({ onAction, children }: { onAction: (action: UIAction) => Promise<ActionResult>; children: ReactNode }) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Partial<Record<Slot, string>>>({});
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const inflight = useRef(new Map<string, number>());

  const run = useCallback(async (action: UIAction, { slot, key = action.type }: RunOptions): Promise<ActionResult> => {
    const token = (inflight.current.get(key) ?? 0) + 1;
    inflight.current.set(key, token);
    setErrors(prev => (prev[slot] ? { ...prev, [slot]: undefined } : prev));
    const timer = setTimeout(() => {
      if (inflight.current.get(key) === token) setPending(prev => new Set(prev).add(key));
    }, 150);
    let result: ActionResult;
    try { result = await onActionRef.current(action); } catch { result = fallbackFailure; }
    clearTimeout(timer);
    if (inflight.current.get(key) === token) {
      inflight.current.delete(key);
      setPending(prev => { if (!prev.has(key)) return prev; const next = new Set(prev); next.delete(key); return next; });
    }
    if (!result.ok) setErrors(prev => ({ ...prev, [slot]: result.message }));
    return result;
  }, []);

  const api = useMemo<ActionsApi>(() => ({
    run,
    isPending: key => pending.has(key),
    error: slot => errors[slot] ?? null,
    show: (slot, message) => setErrors(prev => ({ ...prev, [slot]: message })),
    clear: slot => setErrors(prev => (prev[slot] ? { ...prev, [slot]: undefined } : prev)),
  }), [run, pending, errors]);

  return <ActionsContext.Provider value={api}>{children}</ActionsContext.Provider>;
}

export function useActions(): ActionsApi {
  const api = useContext(ActionsContext);
  if (!api) throw new Error('useActions must be used inside ActionsProvider');
  return api;
}

/** Inline, dismissible error for one slot. Clears itself after `ttl` ms. */
export function InlineError({ slot, ttl = 9000, className }: { slot: Slot; ttl?: number; className?: string }) {
  const { error, clear } = useActions();
  const message = error(slot);
  useEffect(() => {
    if (!message || !ttl) return;
    const timer = setTimeout(() => clear(slot), ttl);
    return () => clearTimeout(timer);
  }, [message, ttl, slot, clear]);
  if (!message) return null;
  return (
    <p role="alert" className={'cdp-inline-error ' + (className ?? '')}>
      <span>{message}</span>
      <button type="button" aria-label="关闭提示" title="关闭提示" onClick={() => clear(slot)}>×</button>
    </p>
  );
}
