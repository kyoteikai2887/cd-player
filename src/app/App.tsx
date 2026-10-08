import { useSyncExternalStore } from 'react';
import type { PlayerBridge, Surface } from '../contracts/player.ts';
import { PlayerUI } from '../ui/PlayerUI.tsx';
import './host.css';

function MountedSurface({ bridge, surface }: { bridge: PlayerBridge; surface: Surface }) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  return <div className="app-surface" hidden={!snapshot.host.surfaceVisible} data-surface={surface}>
    <PlayerUI snapshot={snapshot} surface={surface} onAction={bridge.dispatch} />
  </div>;
}
/** Both views stay mounted when hidden; this browser harness is not native windows. */
export function App({ main, mini, mode = 'demo' }: { main: PlayerBridge; mini: PlayerBridge; mode?: 'demo' | 'local' }) {
  const mainState = useSyncExternalStore(main.subscribe, main.getSnapshot);
  const miniState = useSyncExternalStore(mini.subscribe, mini.getSnapshot);
  const hidden = !mainState.host.surfaceVisible && !miniState.host.surfaceVisible;
  return <div data-playback-mode={mode}>
    <MountedSurface bridge={main} surface="main" /><MountedSurface bridge={mini} surface="mini" />
    {hidden && <div className="app-restore">
      <p>播放器已收起。</p>
      <button type="button" onClick={() => main.dispatch({ type: 'setWindowMode', mode: 'full' })}>重新打开播放器</button>
      {mode === 'local' && <small>保持此页面打开可继续播放；关闭页面会停止声音。</small>}
    </div>}
  </div>;
}
