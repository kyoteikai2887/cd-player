import type { ReactNode } from 'react';
import type { Album, RipSummary, Track } from '../../contracts/player.ts';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { langHint } from '../lib/text.ts';
import { Sheet } from './Sheet.tsx';
import styles from './AlbumInfoSheet.module.css';

/** Album field names as the editor labels them. */
export const ALBUM_FIELD_LABEL: Record<string, string> = {
  title: '标题', albumArtists: '艺术家', albumArtistCredit: '署名', workTitle: '作品', releaseYear: '年份',
  catalogNumber: '品番', label: '厂牌', language: '语言', titleSort: '排序名', discs: '碟片', cover: '封面',
};

/** What the metadata status means, in the words the page used before V1.1. */
export const METADATA_STATUS: Record<Album['metadataStatus'], { label: string; note: string; tone: 'ok' | 'warn' }> = {
  matched: { label: '资料已匹配', note: '专辑与曲目资料来自资料库，或已经过确认。', tone: 'ok' },
  partial: { label: '资料不完整', note: '只找到了部分资料，有些项目可能还是文件里原有的内容。', tone: 'warn' },
  unmatched: { label: '资料未匹配', note: '还没有在资料库里找到这张专辑，显示的是文件里原有的内容。', tone: 'warn' },
};

/**
 * AccurateRip, kept exact (core.9): only "verified" means the rip matched the database. A log on its
 * own proves nothing, "unknown" was never checked, and "notVerified" was checked and did not match.
 */
export const ACCURATE_RIP: Record<RipSummary['accurateRip'], { label: string; note: string; tone: 'ok' | 'warn' | 'quiet' }> = {
  verified: { label: '已核验', note: '与 AccurateRip 数据库一致。', tone: 'ok' },
  partial: { label: '部分核验', note: '只有部分曲目与 AccurateRip 数据库一致。', tone: 'warn' },
  notVerified: { label: '未通过', note: '核验过，但与 AccurateRip 数据库不一致。', tone: 'warn' },
  unknown: { label: '未核验', note: '没有可用的 AccurateRip 结果；有抓轨日志也不代表核验通过。', tone: 'quiet' },
};

/**
 * Album information (Claude, V1.1): the album's technical state — metadata status, the fields the
 * user protected by editing them, and what the rip left behind — moved off the album page into a
 * sheet the user opens from the album's "more" menu. It shows the snapshot as it is and changes
 * nothing; the actions it offers are the page's own.
 */
export function AlbumInfoSheet({ album, tracks, online, onClose, onLookup, onEdit }: {
  album: Album; tracks: Track[]; online: boolean; onClose(): void;
  /** Starts a metadata lookup (the sheet closes first, so the review that follows is in front). */
  onLookup(): void;
  onEdit(): void;
}) {
  const status = METADATA_STATUS[album.metadataStatus];
  const edited = album.userEditedFields.map(f => ALBUM_FIELD_LABEL[f] ?? f);
  const editedTracks = tracks.filter(t => t.userEditedFields.length > 0).length;
  const unavailable = tracks.filter(t => !t.available).length;
  return (
    <Sheet title="专辑信息" subtitle={<span lang={langHint(album.title, null, album.language)}>{album.title}</span>} onClose={onClose}
      footer={<>
        <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online} onClick={onLookup}>
          <Icon name="search" size={17} /> 查找专辑资料
        </button>
        <button type="button" className="cdp-btn cdp-btn--quiet" onClick={onEdit}>
          <Icon name="edit" size={17} /> 编辑专辑资料…
        </button>
      </>}>
      <Group title="资料">
        <Row icon={status.tone === 'ok' ? 'check' : 'info'} label="资料状态" value={status.label} tone={status.tone} note={status.note} />
        <Row icon="lock" label="手动修改" value={edited.length ? `${edited.length} 项` : '没有'}
          note={edited.length ? `${edited.join('、')}。自动查找资料不会覆盖这些项。` : '自动查找资料时，所有项目都可以更新。'} />
        {editedTracks > 0 && (
          <Row icon="note" label="曲目的手动修改" value={`${editedTracks} 首`} note="这些曲目里手动改过的项，自动查找资料同样不会覆盖。" />
        )}
        {album.musicBrainzReleaseId && (
          <Row icon="tag" label="MusicBrainz" value={<span className={styles.code}>{album.musicBrainzReleaseId}</span>} />
        )}
        {unavailable > 0 && (
          <Row icon="warning" label="文件" value={`${unavailable} 首不可用`} tone="warn" note="文件暂时找不到，可能是移动了位置或外接硬盘未连接。" />
        )}
      </Group>
      <Group title="抓轨">
        {album.rip ? <RipRows rip={album.rip} /> : (
          <Row icon="disc" label="抓轨信息" value="没有" note="这张专辑旁边没有找到抓轨日志或 CUE。" />
        )}
      </Group>
    </Sheet>
  );
}

function RipRows({ rip }: { rip: RipSummary }) {
  const ar = ACCURATE_RIP[rip.accurateRip];
  return (
    <>
      <Row icon={rip.hasLog ? 'check' : 'close'} label="抓轨日志" value={rip.hasLog ? '有' : '没有'} />
      <Row icon={rip.hasCue ? 'check' : 'close'} label="CUE" value={rip.hasCue ? '有' : '没有'} />
      <Row icon={rip.accurateRip === 'verified' ? 'check' : 'info'} label="AccurateRip" value={ar.label} tone={ar.tone} note={ar.note}
        data={{ 'data-accuraterip': rip.accurateRip }} />
      {rip.discs && rip.discs.length > 1 && (
        <div className={styles.discs}>
          <table className={styles.discTable}>
            <caption className="sr-only">各张碟片的抓轨文件</caption>
            <thead><tr><th scope="col">碟片</th><th scope="col">日志</th><th scope="col">CUE</th><th scope="col">Disc ID</th></tr></thead>
            <tbody>
              {rip.discs.map(d => (
                <tr key={d.number}>
                  <th scope="row" className="num">Disc {d.number}</th>
                  <td><Mark on={d.hasLog} /></td>
                  <td><Mark on={d.hasCue} /></td>
                  <td className={styles.code}>{d.discId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Mark({ on }: { on: boolean }) {
  return <span className={styles.mark} data-on={on ? 'true' : 'false'}><Icon name={on ? 'check' : 'close'} size={14} /><span className="sr-only">{on ? '有' : '没有'}</span></span>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.group} aria-label={title}>
      <h3 className={styles.groupTitle}>{title}</h3>
      <dl className={styles.groupBody}>{children}</dl>
    </section>
  );
}

function Row({ icon, label, value, note, tone, data }: {
  icon: IconName; label: string; value: ReactNode; note?: string; tone?: 'ok' | 'warn' | 'quiet';
  data?: Record<string, string>;
}) {
  return (
    <div className={styles.row} data-tone={tone} {...data}>
      <dt className={styles.label}><Icon name={icon} size={16} /><span>{label}</span></dt>
      <dd className={styles.value}>
        <span className={styles.valueText}>{value}</span>
        {note && <small className={styles.note}>{note}</small>}
      </dd>
    </div>
  );
}
