import { memo, useMemo } from 'react';
import type { Album } from '../../contracts/player.ts';
import { Cover } from '../components/Cover.tsx';
import { Frost, useFrostStyle } from '../components/Frost.tsx';
import { DiscArt } from '../components/DiscArt.tsx';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { PlayButton } from '../components/Transport.tsx';
import { useActions } from '../lib/actions.tsx';
import { albumDuration, groupByDisc } from '../lib/library.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { langHint } from '../lib/text.ts';
import { showMemorialPlates } from '../lib/memorial.ts';
import styles from './Spotlight.module.css';

/** 1:29:12 or 52:04 — the running time printed on a CD's back insert. */
export function formatRunningTime(ms: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The album that takes the stage: the one in the player, otherwise the newest arrival. */
export function spotlightAlbum(albums: readonly Album[], currentAlbum: Album | null): { album: Album; inPlayer: boolean } | null {
  if (currentAlbum) return { album: currentAlbum, inPlayer: true };
  if (!albums.length) return null;
  return { album: albums.reduce((a, b) => (b.addedAt > a.addedAt ? b : a)), inPlayer: false };
}

/**
 * The stage at the top of the shelf (Claude, R2.1). The album in the player sits here with its
 * disc out of the case and turning; with nothing loaded, the newest arrival takes its place.
 * Its own cover, blurred and enlarged, colours the light behind it, so the shelf takes on the
 * colour of whatever is playing. Words are kept to the content; actions are icons.
 *
 * R2.2: the text sits on a frosted field (lib/frost.ts) whose strength and text tones are derived
 * against an all-black and an all-white cover, so the state, credit and facts read on any album;
 * the left of the stage, behind the case and the disc, keeps the cover's full colour.
 */
export const Spotlight = memo(function Spotlight({ onOpenAlbum, onOpenNowPlaying }: {
  onOpenAlbum(albumId: string): void; onOpenNowPlaying(): void;
}) {
  const { library, index, currentAlbum, currentTrack, online, settings } = useSurface();
  const { run } = useActions();
  const frost = useFrostStyle('stage');
  const pick = useMemo(() => spotlightAlbum(library.albums, currentAlbum), [library.albums, currentAlbum]);
  if (!pick) return null;
  const { album, inPlayer } = pick;
  const lang = langHint(album.title, null, album.language);
  const discs = groupByDisc(album, index);
  const facts: { icon: IconName; value: string; label: string; num?: boolean }[] = [
    ...(discs.length > 1 ? [{ icon: 'disc' as const, value: String(discs.length), label: '张碟', num: true }] : []),
    { icon: 'note', value: String(album.trackIds.length), label: '首曲目', num: true },
    { icon: 'clock', value: formatRunningTime(albumDuration(album, index)), label: '总时长', num: true },
    ...(album.releaseYear ? [{ icon: 'calendar' as const, value: String(album.releaseYear), label: '年发行', num: true }] : []),
    ...(album.catalogNumber ? [{ icon: 'tag' as const, value: album.catalogNumber, label: '品番', num: true }] : []),
  ];
  return (
    <section className={styles.stage} style={frost} data-in-player={inPlayer ? 'true' : 'false'} aria-label={inPlayer ? '播放器里的专辑' : '最新加入的专辑'}>
      <Frost cover={album.cover} />
      {showMemorialPlates(settings) && <span className={styles.etch} aria-hidden="true" data-memorial="etch" />}
      <div className={styles.art}>
        <StageDisc album={album} inPlayer={inPlayer} />
        <button type="button" className={styles.case} onClick={() => onOpenAlbum(album.id)} aria-label={`打开专辑：${album.title}`} title="打开专辑">
          <Cover albumId={album.id} title={album.title} lang={lang} cover={album.cover} variant="full" className={styles.cover} />
        </button>
      </div>
      <div className={styles.info}>
        <p className={styles.eyebrow}>
          {inPlayer ? <PlayerState /> : <span className={styles.state}><Icon name="sparkle" size={15} /><span>新入架</span></span>}
          {album.workTitle && <span className={styles.work} lang={langHint(album.workTitle, null, album.language)}>{album.workTitle}</span>}
        </p>
        <h2 className={styles.title} lang={lang}>{album.title}</h2>
        <p className={styles.credit} lang={langHint(album.albumArtistCredit, null, album.language)}>{album.albumArtistCredit}</p>
        {inPlayer && currentTrack && (
          <button type="button" className={styles.track} onClick={onOpenNowPlaying} title="打开正在播放">
            <Icon name="note" size={15} />
            <span className={styles.trackTitle} lang={langHint(currentTrack.title, currentTrack.language, album.language)}>{currentTrack.title}</span>
            <span className={`${styles.trackNo} num`} title={`第 ${currentTrack.trackNumber} 首`}>
              {discs.length > 1 ? `${currentTrack.discNumber}-` : ''}{currentTrack.trackNumber}/{album.trackIds.length}
            </span>
          </button>
        )}
        <ul className={styles.facts} aria-label="专辑信息">
          {facts.map(fact => (
            <li key={fact.icon} title={fact.label}>
              <Icon name={fact.icon} size={15} />
              <span className={fact.num ? 'num' : undefined}>{fact.value}</span>
              <span className="sr-only">{fact.label}</span>
            </li>
          ))}
        </ul>
        <div className={styles.actions}>
          {inPlayer ? <PlayButton size="md" /> : (
            <button type="button" className="cdp-play" aria-label={`播放 ${album.title}`} title="播放" disabled={!online}
              onClick={() => run({ type: 'playAlbum', albumId: album.id, shuffle: false }, { slot: 'library', key: 'stage-play' })}>
              <Icon name="play" size={22} />
            </button>
          )}
          <button type="button" className="cdp-icon-btn cdp-icon-btn--lg cdp-icon-btn--glass" aria-label="随机播放这张专辑" title="随机播放" disabled={!online}
            onClick={() => run({ type: 'playAlbum', albumId: album.id, shuffle: true }, { slot: 'library', key: 'stage-shuffle' })}>
            <Icon name="shuffle" />
          </button>
          <button type="button" className="cdp-icon-btn cdp-icon-btn--lg cdp-icon-btn--glass" aria-label="打开专辑" title="打开专辑"
            onClick={() => onOpenAlbum(album.id)}>
            <Icon name="open" />
          </button>
          {inPlayer && (
            <button type="button" className="cdp-icon-btn cdp-icon-btn--lg cdp-icon-btn--glass" aria-label="打开正在播放" title="歌词与队列"
              onClick={onOpenNowPlaying}>
              <Icon name="lyrics" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
});

/** Playback state in a glyph and one word; the only part of the stage that follows the player. */
function PlayerState() {
  const player = usePlayer();
  const playing = player.status === 'playing' || player.status === 'buffering';
  return (
    <span className={styles.state} data-playing={playing ? 'true' : 'false'}>
      <span className="cdp-eq" data-paused={playing ? 'false' : 'true'} aria-hidden="true"><i /><i /><i /></span>
      <span>{playing ? '正在播放' : '已暂停'}</span>
    </span>
  );
}

function StageDisc({ album, inPlayer }: { album: Album; inPlayer: boolean }) {
  const player = usePlayer();
  const { visible } = useSurface();
  return <DiscArt albumId={album.id} title={album.title} cover={album.cover} className={styles.disc}
    spinning={inPlayer && visible && player.status === 'playing'} />;
}
