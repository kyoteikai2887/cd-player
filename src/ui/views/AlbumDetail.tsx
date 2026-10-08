import { memo, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Album, LyricsDocument, Track } from '../../contracts/player.ts';
import { Cover } from '../components/Cover.tsx';
import { Frost, useFrostStyle } from '../components/Frost.tsx';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { Menu } from '../components/Menu.tsx';
import { WithObi } from '../components/Obi.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import { formatClock } from '../lib/clock.ts';
import { albumDuration, groupByDisc } from '../lib/library.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { langHint, lyricsStatus, versionBadge } from '../lib/text.ts';
import { formatRunningTime } from './Spotlight.tsx';
import styles from './AlbumDetail.module.css';

const FIELD_LABEL: Record<string, string> = {
  title: '标题', albumArtists: '艺术家', albumArtistCredit: '署名', workTitle: '作品', releaseYear: '年份',
  catalogNumber: '品番', label: '厂牌', language: '语言', titleSort: '排序名', discs: '碟片', cover: '封面',
};

export const AlbumDetail = memo(function AlbumDetail({ album, onOpenNowPlaying, onEditMetadata, onRemove }: {
  album: Album; lyricsByCurrent: LyricsDocument | null; onOpenNowPlaying(): void;
  /** Opens the metadata editor on the album, or on one track. */
  onEditMetadata(trackId?: string): void;
  /** Asks to remove the album from the collection (a confirmation follows). */
  onRemove(): void;
}) {
  const { index, online, currentTrack } = useSurface();
  const { run, isPending } = useActions();
  const discs = useMemo(() => groupByDisc(album, index), [album, index]);
  const total = useMemo(() => albumDuration(album, index), [album, index]);
  const trackCount = album.trackIds.length;
  const lang = langHint(album.title, null, album.language);
  const unavailable = discs.some(d => d.tracks.some(t => !t.available));
  const multiDisc = discs.length > 1 || discs.some(d => d.title);
  const isCurrentAlbum = currentTrack?.albumId === album.id;
  const edited = album.userEditedFields.map(f => FIELD_LABEL[f] ?? f);
  const frost = useFrostStyle('header');

  return (
    <article className={styles.scroller} data-scroller="album" aria-label={album.title}>
      <Frost cover={album.cover} className={styles.light} style={frost} />
      <div className={styles.inner}>
        {/* The header reads on the cover's light whatever its colours (lib/frost.ts). */}
        <header className={styles.hero} style={frost}>
          <WithObi className={styles.art} title={album.workTitle ?? null} catalog={album.catalogNumber}
            lang={langHint(album.workTitle, null, album.language)}>
            <Cover albumId={album.id} title={album.title} lang={lang} cover={album.cover} variant="full" decorative={false}
              style={{ viewTransitionName: 'cdp-hero' }} />
          </WithObi>
          <div className={styles.info}>
            {album.workTitle && <p className={styles.work} lang={langHint(album.workTitle, null, album.language)}>{album.workTitle}</p>}
            <h1 className={`${styles.title} display`} lang={lang}>{album.title}</h1>
            <p className={styles.credit} lang={langHint(album.albumArtistCredit, null, album.language)}>{album.albumArtistCredit}</p>
            {/* Facts as icon + value; the term stays available as the tooltip and to assistive tech. */}
            <dl className={styles.facts}>
              {album.releaseYear && <Fact icon="calendar" term="发行"><span className="num">{album.releaseYear}</span></Fact>}
              {album.catalogNumber && <Fact icon="tag" term="品番"><span className="num">{album.catalogNumber}</span></Fact>}
              {album.label && <Fact icon="record" term="厂牌"><span lang={langHint(album.label)}>{album.label}</span></Fact>}
              {discs.length > 1 && <Fact icon="disc" term="碟片"><span className="num">{discs.length}</span></Fact>}
              <Fact icon="note" term="曲目"><span className="num">{trackCount}</span></Fact>
              <Fact icon="clock" term="总时长"><span className="num">{formatRunningTime(total)}</span></Fact>
            </dl>
            <div className={styles.actions}>
              <button type="button" className="cdp-play" aria-label="播放" title="播放" disabled={!online}
                onClick={() => run({ type: 'playAlbum', albumId: album.id, shuffle: false }, { slot: 'album', key: 'album-play' })}>
                {isPending('album-play') ? <span className="cdp-spinner" /> : <Icon name="play" size={22} />}
              </button>
              <button type="button" className="cdp-icon-btn cdp-icon-btn--lg cdp-icon-btn--glass" aria-label="随机播放" title="随机播放" disabled={!online}
                onClick={() => run({ type: 'playAlbum', albumId: album.id, shuffle: true }, { slot: 'album', key: 'album-shuffle' })}>
                <Icon name="shuffle" />
              </button>
              <Menu label="更多专辑操作" buttonClassName="cdp-icon-btn cdp-icon-btn--lg cdp-icon-btn--glass" align="start" items={[
                { label: '查找专辑资料', icon: 'search', disabled: !online,
                  onSelect: () => void run({ type: 'lookupMetadata', albumId: album.id }, { slot: 'album' }) },
                { label: '更换封面…', icon: 'image', disabled: !online,
                  onSelect: () => void run({ type: 'pickCoverImage', albumId: album.id, baseRevision: album.revision }, { slot: 'album' }) },
                { kind: 'separator' },
                { label: '编辑专辑资料…', icon: 'edit', onSelect: () => onEditMetadata() },
                { kind: 'separator' },
                { label: '从收藏移除…', icon: 'shelfRemove', disabled: !online, onSelect: onRemove,
                  hint: '只从收藏里移除，音乐文件保留在原处' },
              ]} />
              {isCurrentAlbum && (
                <button type="button" className={`cdp-icon-btn cdp-icon-btn--lg cdp-icon-btn--glass ${styles.nowButton}`} aria-label="打开正在播放" title="正在播放此专辑：歌词与队列"
                  onClick={onOpenNowPlaying}>
                  <NowGlyph />
                </button>
              )}
            </div>
            <InlineError slot="album" />
            <div className={styles.status}>
              {album.metadataStatus !== 'matched' && (
                <span className="cdp-badge cdp-badge--warn">{album.metadataStatus === 'unmatched' ? '资料未匹配' : '资料不完整'}</span>
              )}
              {edited.length > 0 && (
                <span className={styles.statusText} title={`手动修改过：${edited.join('、')}。自动查找资料不会覆盖这些项`}>
                  <Icon name="lock" size={13} /> <span className="num">{edited.length}</span><span className="sr-only">项手动修改，自动查找资料不会覆盖</span>
                </span>
              )}
              {album.rip && <RipSummary rip={album.rip} />}
            </div>
          </div>
        </header>

        <section className={styles.tracks} aria-label="曲目">
          {discs.map(disc => (
            <div key={disc.number} className={styles.disc}>
              {multiDisc && (
                <h2 className={styles.discTitle}>
                  <Icon name="disc" size={16} />
                  <span>Disc {disc.number}</span>
                  {disc.title && <span className={styles.discName} lang={langHint(disc.title, null, album.language)}>{disc.title}</span>}
                </h2>
              )}
              <ol className={styles.list}>
                {disc.tracks.map(track => <TrackRow key={track.id} album={album} track={track} onEditMetadata={onEditMetadata} />)}
              </ol>
            </div>
          ))}
          {unavailable && (
            <p className={styles.unavailableNote}>
              <Icon name="warning" size={16} /> 有曲目的文件暂时找不到，可能是移动了位置或外接硬盘未连接。
              <button type="button" className="cdp-btn cdp-btn--text" disabled={!online}
                onClick={() => run({ type: 'rescanLibrary' }, { slot: 'album', key: 'rescan' })}>重新扫描</button>
            </p>
          )}
        </section>
      </div>
    </article>
  );
});

function Fact({ icon, term, children }: { icon: IconName; term: string; children: ReactNode }) {
  return (
    <div title={term}>
      <dt><Icon name={icon} size={15} /><span className="sr-only">{term}</span></dt>
      <dd>{children}</dd>
    </div>
  );
}

function RipSummary({ rip }: { rip: NonNullable<Album['rip']> }) {
  const ar = { verified: 'AccurateRip 已核验', partial: 'AccurateRip 部分核验', notVerified: 'AccurateRip 未通过', unknown: 'AccurateRip 未核验' }[rip.accurateRip];
  return (
    <span className={styles.rip}>
      <span data-on={rip.hasLog}><Icon name={rip.hasLog ? 'check' : 'close'} size={13} />抓轨日志</span>
      <span data-on={rip.hasCue}><Icon name={rip.hasCue ? 'check' : 'close'} size={13} />CUE</span>
      <span data-on={rip.accurateRip === 'verified'}>{ar}</span>
    </span>
  );
}

const LYRIC_ICON: Record<string, IconName> = { rich: 'lyrics', plain: 'lyrics', quiet: 'note', none: 'lyrics' };

const TrackRow = memo(function TrackRow({ album, track, onEditMetadata }: { album: Album; track: Track; onEditMetadata(trackId?: string): void }) {
  const { online, currentTrack } = useSurface();
  const { run } = useActions();
  const isCurrent = currentTrack?.id === track.id;
  const badge = versionBadge(track.versionKind, track.versionLabel);
  const showCredit = track.artistCredit && track.artistCredit !== album.albumArtistCredit;
  const status = lyricsStatus(track.lyricsSummary?.kind, track.lyricsSummary?.translation);
  const lang = langHint(track.title, track.language, album.language);
  const kindIcon: IconName = track.lyricsSummary?.kind === 'spoken' ? 'mic' : LYRIC_ICON[status.tone];
  return (
    <li className={styles.row} data-current={isCurrent ? 'true' : 'false'} data-available={track.available ? 'true' : 'false'}>
      <button type="button" className={styles.rowMain} disabled={!online || !track.available}
        aria-label={`播放 ${track.title}${badge ? '（' + badge + '）' : ''}`}
        onClick={() => run({ type: 'playAlbum', albumId: album.id, startTrackId: track.id }, { slot: 'album', key: 'play-' + track.id })}>
        <span className={`${styles.num} num`}>
          {isCurrent ? <NowGlyph /> : <><span className={styles.numText}>{track.trackNumber}</span><Icon name="play" size={14} className={styles.numPlay} /></>}
        </span>
        <span className={styles.rowTitle}>
          <span className={styles.rowTitleText} lang={lang}>{track.title}</span>
          {badge && <span className="cdp-badge">{badge}</span>}
          {!track.available && <span className="cdp-badge cdp-badge--warn">文件不可用</span>}
        </span>
        <span className={styles.rowCredit} lang={langHint(track.artistCredit, null, album.language)}>{showCredit ? track.artistCredit : ''}</span>
        <span className={styles.rowLyrics} data-tone={status.tone} title={status.label}>
          <Icon name={kindIcon} size={16} />
          {track.lyricsSummary?.translation === 'available' && <i className={styles.trDot} />}
          <span className="sr-only">{status.label}</span>
        </span>
        <span className={`${styles.rowTime} num`}>{formatClock(track.durationMs)}</span>
      </button>
      <Menu label={`更多：${track.title}`} tooltip="更多操作" buttonClassName={`cdp-icon-btn cdp-icon-btn--sm ${styles.rowMore}`} items={[
        { label: '下一首播放', icon: 'queueNext', disabled: !online || !track.available,
          onSelect: () => void run({ type: 'enqueue', trackIds: [track.id], position: 'next' }, { slot: 'album' }) },
        { label: '添加到播放队列', icon: 'list', disabled: !online || !track.available,
          onSelect: () => void run({ type: 'enqueue', trackIds: [track.id], position: 'end' }, { slot: 'album' }) },
        { kind: 'separator' },
        { label: '编辑歌词', icon: 'lyrics', disabled: !online,
          onSelect: () => void run({ type: 'openLyricsEditor', trackId: track.id }, { slot: 'album' }) },
        { label: '查找歌词', icon: 'search', disabled: !online,
          onSelect: () => void run({ type: 'lookupLyrics', trackId: track.id }, { slot: 'album' }) },
        { kind: 'separator' },
        { label: '编辑曲目资料…', icon: 'edit', onSelect: () => onEditMetadata(track.id) },
      ]} />
    </li>
  );
});

function NowGlyph() {
  const player = usePlayer();
  return <span className="cdp-eq" data-paused={player.status !== 'playing' ? 'true' : 'false'} aria-label="正在播放"><i /><i /><i /></span>;
}
