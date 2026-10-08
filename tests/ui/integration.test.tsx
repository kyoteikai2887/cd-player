import React from 'react';
import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { App } from '../../src/app/App.tsx';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { createMockSession } from '../../src/mock/createMockBridge.ts';

afterEach(cleanup);
test('switching mini/full keeps main mounted and preserves its search text', async () => {
  const session = createMockSession({ autoTick: false });
  const main = session.connect('main'), mini = session.connect('mini');
  try {
    const { container } = render(<App main={main} mini={mini} />);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索音乐' }), { target: { value: '蒼い' } });
    fireEvent.click(screen.getByRole('button', { name: '迷你模式' }));
    await screen.findByRole('button', { name: '展开' });
    expect(container.querySelector('[data-surface="main"]')?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    const query = await screen.findByRole('searchbox', { name: '搜索音乐' });
    expect((query as HTMLInputElement).value).toBe('蒼い');
  } finally { session.destroy(); }
});
test('action failure renders inline without duplicating notices; cancelled is quiet', async () => {
  const session = createMockSession({ autoTick: false }), bridge = session.connect('main');
  try {
    const { rerender } = render(<PlayerUI snapshot={bridge.getSnapshot()} surface="main"
      onAction={async () => ({ ok: false, code: 'unavailable', message: 'test timeout' })} />);
    fireEvent.click(screen.getByRole('button', { name: '导入文件夹' }));
    expect((await screen.findAllByRole('alert')).length).toBe(1);
    expect(within(screen.getByRole('alert')).getByText('test timeout')).toBeTruthy();
    rerender(<PlayerUI snapshot={bridge.getSnapshot()} surface="main" onAction={async () => ({ ok: true, status: 'cancelled' })} />);
    fireEvent.click(screen.getByRole('button', { name: '导入文件夹' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  } finally { session.destroy(); }
});
