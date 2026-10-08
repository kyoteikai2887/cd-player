import { memo, useState } from 'react';
import type { Album, UISnapshot } from '../../contracts/player.ts';
import { Cover } from '../components/Cover.tsx';
import { Icon } from '../components/Icon.tsx';
import { IconTabs } from '../components/IconTabs.tsx';
import type { IconTab } from '../components/IconTabs.tsx';
import { WithObi } from '../components/Obi.tsx';
import { PlayButton, RepeatButton, SeekBar, ShuffleButton, SkipButton, VolumeControl } from '../components/Transport.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import { formatClock } from '../lib/clock.ts';
import { groupByDisc } from '../lib/library.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { langHint, versionBadge } from '../lib/text.ts';
import { LyricsPanel, LyricsTools } from './LyricsPanel.tsx';
import { QueueList } from './QueueList.tsx';
import styles from './NowPlaying.module.css';

type Tab = 'lyrics' | 'album' | 'queue';
const TAB_LABEL: Record<Tab, string> = { lyrics: '歌词', album: '本专辑', queue: '播放队列' };
const TABS: IconTab<Tab>[] = [
  { key: 'lyrics', icon: 'lyrics', label: TAB_LABEL.lyrics },
  { key: 'album', icon: 'disc', label: TAB_LABEL.album },
  { key: 'queue', icon: 'list', label: TAB_LABEL.queue },
];

interface NowPlayingProps {
  snapshot: UISnapshot;
  initialTab?: Tab;
  onBack(): void;
  onOpenAlbum(albumId: string): void;
}

/** Immersive layer: the sleeve and transport on the left, typeset lyrics on the right. */
export function NowPlaying({ snapshot, initialTab, onBack, onOpenAlbum }: NowPlayingProps) {
  const { currentTrack, currentAlbum, settings, online } = useSurface();
  const { run } = useActions();
  const prefs = settings.ui.main ?? {};
  const [tab, setTab] = useState<Tab>(initialTab ?? (['lyrics', 'album', 'queue'].includes(prefs.nowPlayingTab as string) ? prefs.nowPlayingTab as Tab : 'lyrics'));
  const [preview, setPreview] = useState<number | null>(null);
  const choose = (next: Tab) => {
    setTab(next);
    void run({ type: 'updateSettings', patch: { ui: { main: { nowPlayingTab: next } } } }, { slot: 'settings', key: 'persist-ui' });
  };
  const lang = langHint(currentTrack?.title, currentTrack?.language, currentAlbum?.language);
  const badge = currentTrack ? versionBadge(currentTrack.versionKind, currentTrack.versionLabel) : null;

  return (
    <section className={styles.layer} aria-label="正在播放">
      <div className={styles.ambient} aria-hidden="true"
        style={currentAlbum?.cover?.dominantColor ? { ['--glow' as string]: currentAlbum.cover.dominantColor } : undefined} />
      <header className={styles.top}>
        <button type="button" className="cdp-icon-btn cdp-icon-btn--glass" onClick={onBack} aria-label="返回" title="返回"><Icon name="back" /></button>
        <div className={styles.topTrail}>
          <button type="button" className="cdp-icon-btn cdp-icon-btn--glass" disabled={!online} aria-label="迷你模式" title="迷你模式"
            onClick={() => run({ type: 'setWindowMode', mode: 'mini' }, { slot: 'transport' })}>
            <Icon name="mini" />
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.left}>
          {currentTrack && currentAlbum ? (
            <>
              <Artwork album={currentAlbum} />
              <div className={styles.meta}>
                <h1 className={`${styles.trackTitle} display`} lang={lang}>{currentTrack.title}</h1>
                <p className={styles.trackCredit} lang={langHint(currentTrack.artistCredit, null, currentAlbum.language)}>
                  {currentTrack.artistCredit}
                  {badge && <span className="cdp-badge">{badge}</span>}
                </p>
                <button type="button" className={styles.albumLink} onClick={() => onOpenAlbum(currentAlbum.id)}>
                  <span lang={langHint(currentAlbum.title, null, currentAlbum.language)}>{currentAlbum.title}</span>
                  {currentAlbum.discs.length > 1 && <span className={styles.position}>Disc {currentTrack.discNumber}</span>}
                  <span className={styles.position}>第 {currentTrack.trackNumber} 首</span>
                  <Icon name="chevronRight" size={14} />
                </button>
              </div>
              <div className={styles.transport}>
                <SeekBar preview={preview} onPreview={setPreview} />
                <div className={styles.buttons}>
                  <ShuffleButton />
                  <SkipButton dir="prev" />
                  <PlayButton />
                  <SkipButton dir="next" />
                  <RepeatButton />
                </div>
                <div className={styles.volumeRow}><VolumeControl /></div>
                <InlineError slot="transport" />
                <PlaybackState />
              </div>
            </>
          ) : <IdleState />}
        </div>

        <div className={styles.right}>
          <div className={styles.tabs}>
            <IconTabs mode="tabs" label="正在播放内容" items={TABS} value={tab} onChange={choose} />
            {tab === 'lyrics' && <LyricsTools snapshot={snapshot} />}
          </div>
          <div className={styles.panel} role="tabpanel" aria-label={TAB_LABEL[tab]}>
            {tab === 'lyrics' && <LyricsPanel snapshot={snapshot} preview={preview} />}
            {tab === 'album' && currentAlbum && <AlbumTab album={currentAlbum} />}
            {tab === 'album' && !currentAlbum && <p className={styles.panelEmpty}>还没有正在播放的专辑。</p>}
            {tab === 'queue' && <QueueList />}
          </div>
        </div>
      </div>
    </section>
  );
}

const Artwork = memo(function Artwork({ album }: { album: Album }) {
  const { settings } = useSurface();
  const lang = langHint(album.title, null, album.language);
  return (
    <div className={styles.art} data-disc={settings.showDiscAnimation ? 'true' : 'false'}>
      {settings.showDiscAnimation && <SpinningDisc />}
      <WithObi className={styles.sleeve} title={album.workTitle ?? null} catalog={album.catalogNumber}
        lang={langHint(album.workTitle, null, album.language)}>
        <Cover albumId={album.id} title={album.title} lang={lang} cover={album.cover} variant="full" decorative={false}
          style={{ viewTransitionName: 'cdp-hero' }} />
      </WithObi>
    </div>
  );
});

/** Optional (default off): a disc slides out from the case and turns only while playing. */
function SpinningDisc() {
  const player = usePlayer();
  return <div className={styles.disc} data-spinning={player.status === 'playing' ? 'true' : 'false'} aria-hidden="true"><i /></div>;
}

function PlaybackState() {
  const player = usePlayer();
  if (player.status === 'error' && player.error) {
    return <p className={styles.playError} role="status"><Icon name="warning" size={16} /> {player.error.message}</p>;
  }
  return null;
}

function IdleState() {
  return (
    <div className={styles.idle}>
      <span className={styles.idleDisc} aria-hidden="true" />
      <p className={styles.idleTitle}>还没有在播放</p>
      <p className={styles.idleBody}>回到收藏，选一张专辑开始。</p>
    </div>
  );
}

function AlbumTab({ album }: { album: Album }) {
  const { index, currentTrack, online } = useSurface();
  const { run } = useActions();
  const discs = groupByDisc(album, index);
  return (
    <div className={styles.listScroll}>
      {discs.map(disc => (
        <div key={disc.number}>
          {discs.length > 1 && <p className={styles.listDisc}>Disc {disc.number}{disc.title ? `  ${disc.title}` : ''}</p>}
          <ol className={styles.list}>
            {disc.tracks.map(track => {
              const badge = versionBadge(track.versionKind, track.versionLabel);
              return (
                <li key={track.id}>
                  <button type="button" className={styles.listRow} data-current={track.id === currentTrack?.id ? 'true' : 'false'}
                    disabled={!online || !track.available}
                    onClick={() => run({ type: 'playAlbum', albumId: album.id, startTrackId: track.id }, { slot: 'queue' })}>
                    <span className={`${styles.listNum} num`}>{track.trackNumber}</span>
                    <span className={styles.listTitle} lang={langHint(track.title, track.language, album.language)}>
                      {track.title}{badge && <span className="cdp-badge">{badge}</span>}
                    </span>
                    <span className={`${styles.listTime} num`}>{formatClock(track.durationMs)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      <InlineError slot="queue" />
    </div>
  );
}

