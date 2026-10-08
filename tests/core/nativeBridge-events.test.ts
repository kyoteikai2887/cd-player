import assert from 'node:assert/strict';
import test from 'node:test';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { createNativeBridge } from '../../src/bridge/nativeBridge.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';

test('native bridges keep window visibility and per-window sequence streams separate', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as unknown as Window & typeof globalThis;
  const session = createMockSession({ autoTick: false });
  await session.connect('main').dispatch({ type: 'setWindowMode', mode: 'mini' });
  const listeners = new Map<number, { handler: number; target: { kind: string; label?: string } }>();
  let requesting: 'main' | 'mini' = 'main', serial = 0;
  mockIPC((command, args) => {
    if (command === 'clock_sample') return performance.now();
    if (command === 'request_snapshot') return { sequence: 1, full: true, snapshot: session.connect(requesting).getSnapshot() };
    if (command === 'plugin:event|listen') {
      const id = ++serial;
      listeners.set(id, { handler: args!.handler as number, target: args!.target as { kind: string; label?: string } });
      return id;
    }
    if (command === 'plugin:event|unlisten') { listeners.delete(args!.eventId as number); return; }
    throw Error('Unexpected command: ' + command);
  });
  const emit = (label: string, sequence: number, surfaceVisible: boolean) => {
    for (const { target, handler } of listeners.values()) {
      if (target.kind !== 'Any' && target.label !== label) continue;
      const internals = window.__TAURI_INTERNALS__ as unknown as { runCallback(id: number, data: unknown): void };
      internals.runCallback(handler, { event: 'cd-snapshot', payload: { sequence, snapshot: {
        host: { ...session.connect(label as 'main' | 'mini').getSnapshot().host, surfaceVisible },
      } } });
    }
  };
  let main, mini;
  try {
    main = await createNativeBridge('main'); requesting = 'mini'; mini = await createNativeBridge('mini');
    emit('main', 1000, false); emit('mini', 2, true);
    assert.equal(mini.getSnapshot().host.surfaceVisible, true);
    assert.equal(main.getSnapshot().host.surfaceVisible, false);
    emit('mini', 3, false); emit('main', 1001, true);
    assert.equal(mini.getSnapshot().host.surfaceVisible, false);
    assert.equal(main.getSnapshot().host.surfaceVisible, true);
    emit('mini', 4, true);
    assert.equal(mini.getSnapshot().host.surfaceVisible, true);
    assert.deepEqual([...listeners.values()].map(l => l.target), [
      { kind: 'WebviewWindow', label: 'main' }, { kind: 'WebviewWindow', label: 'mini' },
    ]);
  } finally {
    main?.destroy(); mini?.destroy(); session.destroy(); clearMocks();
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window'); else globalThis.window = originalWindow;
  }
});
