import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { UISnapshot } from '../../contracts/player.ts';
import { Cover } from '../components/Cover.tsx';
import { Frost, useFrostStyle } from '../components/Frost.tsx';
import { Icon } from '../components/Icon.tsx';
import { PlayButton, SkipButton } from '../components/Transport.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import { useBoot } from '../lib/env.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { useActiveLyric, useProgressFrames } from '../lib/useClock.ts';
import { langHint } from '../lib/text.ts';
import styles from './MiniSurface.module.css';

const DRAG_THRESHOLD = 4;

/**
 * Desktop widget. Card content 360×92 (with lyric strip 360×140). When the native window is
 * transparent the card sits inside a 12px margin for its shadow; otherwise it fills the client area.
 */
export function MiniSurface({ snapshot }: { snapshot: UISnapshot }) {
  const { host, settings, currentTrack, currentAlbum, visible, online } = useSurface();
  const { run } = useActions();
  const boot = useBoot();
  const showLyrics = settings.miniShowLyrics && snapshot.lyrics?.kind === 'synced' && snapshot.lyrics.trackId === currentTrack?.id;
  // A native material (Acrylic/Mica) fills the whole client area, so the card then fills it too:
  // no transparent margin, the host's corners and shadow (R2.1 proposal, CONTRACT_REQUESTS R2.1-1).
  const frame = host.shell === 'browser' ? 'preview'
    : host.backdrop !== 'none' ? 'material'
    : host.capabilities.transparentWindow ? 'transparent' : 'opaque';
  // How see-through the card may be depends on what the window shows behind it (see the CSS).
  const material = frame === 'preview' ? 'css' : frame === 'material' ? 'native' : 'solid';
  // R2.2: without a native material behind it, the card is frost in the playing album's colours
  // (a small stage on the desktop); over Acrylic it stays a light tint so the material shows.
  const frosted = material !== 'native';
  const frost = useFrostStyle('mini');

  // Entrance only when this surface becomes visible (false → true); never on every render.
  const [entering, setEntering] = useState(false);
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setEntering(true);
      const timer = setTimeout(() => setEntering(false), 400);
      wasVisible.current = visible;
      return () => clearTimeout(timer);
    }
    wasVisible.current = visible;
  }, [visible]);

  // Native drag starts only after the pointer moves >4px with the primary button held,
  // so clicks and double-clicks on the card still work. Buttons and the progress line are excluded.
  const drag = useRef<{ x: number; y: number; sent: boolean } | null>(null);
  const onPointerDown = (event: ReactPointerEvent) => {
    // Every press starts over: a press released outside the window must not leave a drag armed.
    drag.current = null;
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, [data-no-drag]')) return;
    drag.current = { x: event.clientX, y: event.clientY, sent: false };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const start = drag.current;
    if (!start || start.sent) return;
    if (!(event.buttons & 1)) { drag.current = null; return; }
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= DRAG_THRESHOLD) return;
    start.sent = true;
    if (host.capabilities.windowDragging) void run({ type: 'beginWindowDrag' }, { slot: 'mini', key: 'drag' });
  };
  const endDrag = () => { drag.current = null; };

  const lang = langHint(currentTrack?.title, currentTrack?.language, currentAlbum?.language);
  return (
    <div className={styles.window} data-frame={frame} data-radius={host.nativeCornerRadius}>
      <div className={styles.card} data-material={material} data-frost={frosted ? 'true' : 'false'} style={frosted ? frost : undefined}
        data-lyrics={showLyrics ? 'true' : 'false'} data-entering={entering ? 'true' : 'false'}
        data-show-controls={boot.miniShowControls ? 'true' : 'false'}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
        onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button')) void run({ type: 'setWindowMode', mode: 'full' }, { slot: 'mini' }); }}>
        {frosted && <Frost cover={currentAlbum?.cover ?? null} />}
        <div className={styles.main}>
          {currentAlbum ? (
            <Cover albumId={currentAlbum.id} title={currentAlbum.title} cover={currentAlbum.cover} className={styles.art} showTitleOnPlaceholder={false} />
          ) : <span className={styles.artEmpty}><Icon name="disc" size={24} /></span>}
          <div className={styles.text}>
            <p className={styles.title} lang={lang} title={currentTrack?.title}>{currentTrack?.title ?? '还没有在播放'}</p>
            <p className={styles.sub} lang={langHint(currentTrack?.artistCredit, null, currentAlbum?.language)} title={currentTrack?.artistCredit}>
              {currentTrack ? currentTrack.artistCredit : '展开窗口选一张专辑'}
            </p>
          </div>
          <div className={styles.controls}>
            <SkipButton dir="prev" size="sm" slot="mini" />
            <PlayButton size="xs" slot="mini" />
            <SkipButton dir="next" size="sm" slot="mini" />
          </div>
        </div>
        {showLyrics && snapshot.lyrics && <MiniLyric snapshot={snapshot} />}
        <MiniProgress />
        <div className={`${styles.chrome} glass-flat`} role="toolbar" aria-label="迷你窗口">
          <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label={settings.miniAlwaysOnTop ? '取消置顶' : '置顶'}
            aria-pressed={settings.miniAlwaysOnTop} title={settings.miniAlwaysOnTop ? '已置顶' : '置顶'} disabled={!online}
            onClick={() => run({ type: 'updateSettings', patch: { miniAlwaysOnTop: !settings.miniAlwaysOnTop } }, { slot: 'mini' })}>
            <Icon name="pin" size={15} />
          </button>
          <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label="展开" title="展开到完整窗口"
            onClick={() => run({ type: 'setWindowMode', mode: 'full' }, { slot: 'mini' })}>
            <Icon name="expand" size={15} />
          </button>
          <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label="收起到托盘" title="收起到托盘，继续播放"
            onClick={() => run({ type: 'hideToTray' }, { slot: 'mini' })}>
            <Icon name="close" size={15} />
          </button>
        </div>
        <InlineError slot="mini" className={styles.error} ttl={5000} />
      </div>
    </div>
  );
}

function MiniProgress() {
  const player = usePlayer();
  const { visible } = useSurface();
  const ref = useRef<HTMLElement>(null);
  useProgressFrames(fraction => { if (ref.current) ref.current.style.transform = `scaleX(${fraction})`; }, player, visible, null);
  return <div className={styles.progress} aria-hidden="true" data-no-drag><i ref={ref} /></div>;
}

/** One synced line (plus its translation in bilingual mode), crossfading at each boundary. */
function MiniLyric({ snapshot }: { snapshot: UISnapshot }) {
  const player = usePlayer();
  const { visible, settings, currentAlbum } = useSurface();
  const lyrics = snapshot.lyrics!;
  const index = useActiveLyric(lyrics.lines, lyrics.offsetMs, player, visible, null);
  const line = index >= 0 ? lyrics.lines[index] : null;
  return (
    <div className={styles.lyric} aria-live="off">
      <div key={line?.id ?? 'none'} className={styles.lyricLine}>
        {line ? (
          <>
            <p className={styles.lyricOriginal} lang={langHint(line.original, lyrics.language, currentAlbum?.language)}>{line.original.split('\n')[0]}</p>
            {settings.lyricsMode === 'bilingual' && line.translation && (
              <p className={styles.lyricTranslation} lang={lyrics.translationLanguage ?? undefined}>{line.translation.split('\n')[0]}</p>
            )}
          </>
        ) : <p className={styles.lyricIdle}>♪</p>}
      </div>
    </div>
  );
}
