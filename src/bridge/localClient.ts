import type { UIAction, TaskInfo, MetadataReview, LyricsReview, LyricsPendingImport } from '../contracts/player.ts';
import type { LocalView } from '../local/model.ts';
import type { LocalTask } from '../local/server.ts';

export interface LocalReply {
  ok: boolean;
  code?: string;
  message?: string;
  view?: LocalView;
  taskId?: string;
  task?: TaskInfo;
  status?: string;
  metadataReview?: MetadataReview;
  lyricsReview?: LyricsReview;
  pendingImport?: LyricsPendingImport;
}
export interface LocalClient {
  initial: LocalView;
  write(action: UIAction, signal: AbortSignal): Promise<LocalReply>;
  start(action: UIAction, signal: AbortSignal): Promise<LocalReply>;
  task(id: string, signal: AbortSignal): Promise<LocalTask>;
}
export async function createLocalClient(): Promise<LocalClient> {
  const response = await fetch('/api/bootstrap', { cache: 'no-store' });
  if (!response.ok)
    throw new Error('本地核心无法连接，请使用本地播放启动入口。');
  const bootstrap = (await response.json()) as {
    token: string;
    view: LocalView;
  };
  const post = async (
    url: string,
    action: UIAction,
    signal: AbortSignal,
  ): Promise<LocalReply> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cd-token': bootstrap.token,
      },
      body: JSON.stringify(action),
      signal,
    });
    return response.json();
  };
  return {
    initial: bootstrap.view,
    write: (action, signal) => post('/api/action', action, signal),
    start: (action, signal) => post('/api/task', action, signal),
    async task(id, signal) {
      const response = await fetch('/api/task/' + encodeURIComponent(id), {
        signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('后台任务状态无法读取。');
      return response.json();
    },
  };
}
