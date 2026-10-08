import type { Surface } from '../contracts/player.ts';

/** Process-owned guard; hiding a surface never clears its dirty flag. */
export function createExitGuard() {
  const dirty = new Set<Surface>();
  let revision = 0;
  let request: Promise<boolean> | null = null;
  return {
    report(surface: Surface, value: boolean) {
      if (dirty.has(surface) === value) return;
      value ? dirty.add(surface) : dirty.delete(surface); revision++;
    },
    hasUnsavedChanges: () => dirty.size > 0,
    requestExit(confirmDiscard: () => Promise<boolean>): Promise<boolean> {
      if (request) return request;
      const baseline = revision;
      request = (async () => {
        if (!dirty.size) return true;
        try { return await confirmDiscard() && revision === baseline; } catch { return false; }
      })().finally(() => { request = null; });
      return request;
    },
  };
}
