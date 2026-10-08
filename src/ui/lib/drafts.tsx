import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ActionResult, Surface, UIAction } from '../../contracts/player.ts';

/**
 * Unsaved-work registry for one surface (CONTRACT_BEHAVIOR §5).
 *
 * Every editing form registers its own flag under a stable key. The surface is dirty while any
 * flag is set, and only *transitions* of that aggregate are reported with reportUnsavedChanges,
 * so one form closing never clears another form's unsaved work. Hiding the surface keeps the
 * forms mounted, so their drafts and flags survive.
 */
interface DirtyApi {
  set(key: string, dirty: boolean): void;
  /** Keys that are currently dirty (for "save all" style prompts and tests). */
  keys: readonly string[];
  stash: DraftStash;
}

/**
 * A draft whose editor went away without the user choosing (the core switched the editing target,
 * or closed the editor from elsewhere). It is kept, still counts as unsaved work, and is offered
 * back to the user; reopening the same target restores it.
 */
export interface StashedDraft {
  key: string;
  /** What the draft is about, for the prompt ("蒼い窓辺" lyrics). */
  label: string;
  kind: 'lyrics' | 'metadata';
  value: unknown;
  reopen(): void;
}
export interface DraftStash {
  entries: readonly StashedDraft[];
  /** Pure read (safe during render). */
  peek(key: string): StashedDraft | undefined;
  put(entry: StashedDraft): void;
  drop(key: string): void;
  /**
   * Drafts the user agreed to give up for an action that ends their subject (removing an album).
   * While marked, an editor closed by that action does not set its draft aside (the mark is used
   * up then). Nothing is dropped here: on success the caller drops the entries, on failure it
   * releases the marks, so a failed action loses nothing.
   */
  discard(keys: readonly string[]): void;
  release(keys: readonly string[]): void;
}
const DirtyContext = createContext<DirtyApi | null>(null);

export function DirtyProvider({ surface, onAction, children }: {
  surface: Surface; onAction: (action: UIAction) => Promise<ActionResult>; children: ReactNode;
}) {
  const [flags, setFlags] = useState<ReadonlyMap<string, true>>(() => new Map());
  const set = useCallback((key: string, dirty: boolean) => {
    setFlags(prev => {
      if (dirty === prev.has(key)) return prev;
      const next = new Map(prev);
      if (dirty) next.set(key, true); else next.delete(key);
      return next;
    });
  }, []);
  const stashRef = useRef(new Map<string, StashedDraft>());
  const discarded = useRef(new Set<string>());
  const [entries, setEntries] = useState<readonly StashedDraft[]>([]);
  const stash = useMemo<DraftStash>(() => ({
    entries,
    peek: key => stashRef.current.get(key),
    put(entry) {
      if (discarded.current.delete(entry.key)) return;
      stashRef.current.set(entry.key, entry); setEntries([...stashRef.current.values()]);
    },
    drop(key) { if (stashRef.current.delete(key)) setEntries([...stashRef.current.values()]); },
    discard(keys) { for (const key of keys) discarded.current.add(key); },
    release(keys) { for (const key of keys) discarded.current.delete(key); },
  }), [entries]);
  const any = flags.size > 0 || entries.length > 0;
  const reported = useRef(false);
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  useEffect(() => {
    if (any === reported.current) return;
    reported.current = any;
    // Quiet by design: a failed report must not surface as an editor error.
    void onActionRef.current({ type: 'reportUnsavedChanges', surface, dirty: any }).catch(() => undefined);
  }, [any, surface]);
  const api = useMemo<DirtyApi>(() => ({ set, keys: [...flags.keys(), ...entries.map(e => e.key)], stash }), [set, flags, entries, stash]);
  return <DirtyContext.Provider value={api}>{children}</DirtyContext.Provider>;
}

/** Registers `dirty` under `key` while the calling component is mounted. */
export function useDirtyFlag(key: string, dirty: boolean) {
  const api = useContext(DirtyContext);
  const set = api?.set;
  useEffect(() => { set?.(key, dirty); }, [set, key, dirty]);
  useEffect(() => () => { set?.(key, false); }, [set, key]);
}

export function useDirtyKeys(): readonly string[] {
  return useContext(DirtyContext)?.keys ?? [];
}

const noStash: DraftStash = { entries: [], peek: () => undefined, put: () => undefined, drop: () => undefined, discard: () => undefined, release: () => undefined };
export function useDraftStash(): DraftStash {
  return useContext(DirtyContext)?.stash ?? noStash;
}
