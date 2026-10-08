import { useMemo, useState } from 'react';
import type { CoverPreview, JsonValue, MetadataCandidate, MetadataChange, MetadataReview } from '../../contracts/player.ts';
import { Icon } from '../components/Icon.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import { useSurface } from '../lib/surface.tsx';
import { langHint } from '../lib/text.ts';
import { Sheet } from './Sheet.tsx';
import styles from './MetadataReviewSheet.module.css';

const FIELD: Record<string, string> = {
  title: '标题', albumArtists: '艺术家', albumArtistCredit: '署名', workTitle: '作品', releaseYear: '发行年份',
  catalogNumber: '品番', label: '厂牌', language: '语言', titleSort: '排序名', discs: '碟片', cover: '封面',
  artists: '艺术家', artistCredit: '署名', discNumber: '碟号', trackNumber: '曲号', versionKind: '版本类型', versionLabel: '版本',
};
const MATCH: Record<MetadataCandidate['match'], string> = {
  discId: '光盘 ID 一致', toc: '目录 (TOC) 一致', catalog: '品番一致', text: '按名称找到',
};

function formatValue(value: JsonValue): string {
  if (value === null || value === '') return '（空）';
  if (Array.isArray(value)) {
    if (value.every(v => v && typeof v === 'object' && 'number' in (v as object))) return `${value.length} 张`;
    return value.map(v => String(v)).join(' / ') || '（空）';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Candidate review: per-field choice; fields the user edited stay unchecked and need an explicit opt-in each. */
export function MetadataReviewSheet({ review }: { review: MetadataReview }) {
  const { index, online } = useSurface();
  const { run, isPending } = useActions();
  const album = index.albumsById.get(review.albumId);
  const [candidateId, setCandidateId] = useState<string | null>(review.candidates[0]?.id ?? null);
  const candidate = review.candidates.find(c => c.id === candidateId) ?? review.candidates[0] ?? null;
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const isSelected = (change: MetadataChange) => selected[change.id] ?? !change.userEdited;
  const chosen = useMemo(() => candidate ? candidate.changes.filter(isSelected) : [], [candidate, selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => void run({ type: 'closeMetadataReview' }, { slot: 'metadata' });

  const apply = async () => {
    if (!candidate) return;
    await run({ type: 'applyMetadataCandidate', albumId: review.albumId, reviewId: review.id, candidateId: candidate.id,
      changeIds: chosen.map(c => c.id), confirmedProtectedChangeIds: chosen.filter(c => c.userEdited).map(c => c.id) },
    { slot: 'metadata', key: 'apply-metadata' });
  };

  const footer = review.status === 'ready' && candidate ? (
    <>
      <InlineError slot="metadata" />
      <button type="button" className="cdp-btn cdp-btn--quiet" onClick={close}>不修改</button>
      <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || !chosen.length || isPending('apply-metadata')}
        onClick={() => void apply()}>
        {isPending('apply-metadata') && <span className="cdp-spinner" />}
        应用 {chosen.length} 项修改
      </button>
    </>
  ) : undefined;

  return (
    <Sheet title="专辑资料候选" wide onClose={close} closeLabel="关闭资料候选" footer={footer}
      subtitle={album && <span lang={langHint(album.title, null, album.language)}>{album.title}</span>}>
      {review.status === 'searching' && (
        <div className={styles.state} role="status"><span className="cdp-spinner" /> 正在查找这张专辑的资料…</div>
      )}
      {review.status === 'failed' && (
        <div className={styles.state} data-tone="warn">
          <Icon name="warning" size={18} /> {review.error?.message ?? '资料查找没有完成。'}
          <button type="button" className="cdp-btn cdp-btn--text" disabled={!online}
            onClick={() => run({ type: 'lookupMetadata', albumId: review.albumId }, { slot: 'metadata' })}>重试</button>
        </div>
      )}
      {review.status === 'noResults' && (
        <div className={styles.state}>没有找到候选。可以检查抓轨日志或 CUE 是否完整，或者直接手动编辑资料。</div>
      )}
      {review.status === 'ready' && candidate && (
        <>
          {review.candidates.length > 1 && (
            <div className={styles.candidates} role="radiogroup" aria-label="候选">
              {review.candidates.map(c => (
                <button key={c.id} type="button" role="radio" aria-checked={c.id === candidate.id} className={styles.candidate}
                  onClick={() => { setCandidateId(c.id); setSelected({}); }}>
                  <CandidateSummary candidate={c} />
                </button>
              ))}
            </div>
          )}
          {review.candidates.length === 1 && <div className={styles.single}><CandidateSummary candidate={candidate} /></div>}

          <h3 className={styles.changesTitle}>将要修改的内容</h3>
          <p className={styles.changesHint}>默认只勾选你没有手动改过的字段。带锁的字段是你改过的，需要逐项确认才会替换。</p>
          <ul className={styles.changes}>
            {candidate.changes.map(change => {
              const checked = isSelected(change);
              const track = change.target === 'track' ? index.tracksById.get(change.trackId) : null;
              return (
                <li key={change.id} className={styles.change} data-protected={change.userEdited ? 'true' : 'false'} data-checked={checked ? 'true' : 'false'}>
                  <label className={styles.changeLabel}>
                    <input type="checkbox" checked={checked} onChange={event => setSelected(s => ({ ...s, [change.id]: event.target.checked }))} />
                    <span className={styles.field}>
                      {track && <span className={styles.fieldTrack}>{track.trackNumber}. {track.title}</span>}
                      {FIELD[change.field] ?? change.field}
                      {change.userEdited && <span className="cdp-badge cdp-badge--warn"><Icon name="lock" size={11} />手动修改过</span>}
                    </span>
                  </label>
                  {change.field === 'cover' ? (
                    <span className={styles.values}>
                      <CoverThumb preview={change.from as CoverPreview | null} label="现在" />
                      <Icon name="chevronRight" size={16} />
                      <CoverThumb preview={change.to as CoverPreview | null} label="候选" />
                    </span>
                  ) : (
                    <span className={styles.values}>
                      <span className={styles.from} lang={langHint(formatValue(change.from as JsonValue))}>{formatValue(change.from as JsonValue)}</span>
                      <Icon name="chevronRight" size={16} />
                      <span className={styles.to} lang={langHint(formatValue(change.to as JsonValue))}>{formatValue(change.to as JsonValue)}</span>
                    </span>
                  )}
                  {change.userEdited && checked && <p className={styles.confirm}>将替换你手动修改的值；替换后这一项仍受保护。</p>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Sheet>
  );
}

function CandidateSummary({ candidate }: { candidate: MetadataCandidate }) {
  return (
    <span className={styles.summary}>
      {candidate.coverThumbUrl ? <img src={candidate.coverThumbUrl} alt="" className={styles.summaryThumb} /> : <span className={styles.summaryThumb} />}
      <span className={styles.summaryText}>
        <span className={styles.summaryTitle} lang={langHint(candidate.title)}>{candidate.title}</span>
        <span className={styles.summarySub}>
          <span lang={langHint(candidate.albumArtistCredit)}>{candidate.albumArtistCredit}</span>
          {candidate.releaseYear && <span className="num">{candidate.releaseYear}</span>}
          {candidate.catalogNumber && <span className="num">{candidate.catalogNumber}</span>}
          <span>{candidate.discCount} 张 {candidate.trackCount} 首</span>
        </span>
        <span className={styles.summaryMeta}>
          <span className="cdp-badge cdp-badge--accent">{MATCH[candidate.match]}</span>
          <span>{candidate.provider}</span>
        </span>
        {candidate.notes.length > 0 && <span className={styles.notes}>{candidate.notes.join(' ')}</span>}
      </span>
    </span>
  );
}

function CoverThumb({ preview, label }: { preview: CoverPreview | null; label: string }) {
  return (
    <span className={styles.coverThumb}>
      {preview ? <img src={preview.thumbUrl} alt={`${label}的封面`} /> : <span className={styles.coverNone}>无封面</span>}
      <small>{label}</small>
    </span>
  );
}
