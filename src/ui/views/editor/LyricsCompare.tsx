import { Fragment, useMemo, useState } from 'react';
import { compareDrafts, formatStamp } from '../../lib/lyricsDraft.ts';
import type { CompareRow, DraftLine, LyricsDraft } from '../../lib/lyricsDraft.ts';
import styles from '../LyricsEditorSheet.module.css';

const STATUS_LABEL = { same: '相同', changed: '改动', onlyDraft: '新增', onlyLatest: '删去' } as const;

/**
 * The latest saved version beside the draft. Lines pair by identity, then by time, then by text;
 * differing parts are marked on both sides. Runs of identical lines fold away by default.
 * Nothing is merged here — the user chooses afterwards.
 */
export function LyricsCompare({ latest, latestRevision, draft, lang, trLang }: {
  latest: LyricsDraft; latestRevision: number; draft: LyricsDraft; lang?: string; trLang?: string;
}) {
  const { rows, summary } = useMemo(() => compareDrafts(latest, draft), [latest, draft]);
  const differing = rows.filter(r => r.status !== 'same').length;
  const [onlyDiff, setOnlyDiff] = useState(true);
  const blocks = useMemo(() => fold(rows, onlyDiff && differing > 0), [rows, onlyDiff, differing]);
  return (
    <div className={styles.compare}>
      <div className={styles.compareHead}>
        <p className={styles.compareLead}>
          左边是别处最新保存的第 <span className="num">{latestRevision}</span> 版，右边是你的草稿。
          {differing ? <> 有 <strong className="num">{differing}</strong> 行不同{summary.length ? '，另有设置不同' : ''}。</>
            : summary.length ? ' 歌词行相同，只有设置不同。' : ' 两边完全相同。'}
        </p>
        {differing > 0 && differing < rows.length && (
          <div className="cdp-seg" role="group" aria-label="显示范围">
            <button type="button" aria-pressed={onlyDiff} onClick={() => setOnlyDiff(true)}>只看不同</button>
            <button type="button" aria-pressed={!onlyDiff} onClick={() => setOnlyDiff(false)}>全部 <span className="num">{rows.length}</span> 行</button>
          </div>
        )}
      </div>
      {summary.length > 0 && (
        <dl className={styles.compareFields}>
          {summary.map(s => (
            <div key={s.field}><dt>{s.field}</dt><dd><del>{s.latest}</del><span aria-hidden="true">→</span><ins>{s.draft}</ins></dd></div>
          ))}
        </dl>
      )}
      {rows.length > 0 && (
        <table className={styles.compareTable}>
          <thead>
            <tr><th scope="col">时间</th><th scope="col">最新已保存</th><th scope="col">你的草稿</th></tr>
          </thead>
          <tbody>
            {blocks.map(block => block.kind === 'fold' ? (
              <tr key={block.key} className={styles.compareFold}>
                <td colSpan={3}>
                  <button type="button" className="cdp-btn cdp-btn--text" onClick={() => setOnlyDiff(false)}>
                    ⋯ <span className="num">{block.count}</span> 行相同
                  </button>
                </td>
              </tr>
            ) : (
              <Fragment key={block.row.key}>
                <tr data-status={block.row.status}>
                  <td className={styles.compareTime}>
                    <Time row={block.row} />
                    {block.row.status !== 'same' && <span className={styles.compareTag}>{STATUS_LABEL[block.row.status]}</span>}
                  </td>
                  <td data-side="latest"><Pair line={block.row.latest} other={block.row.draft} row={block.row} lang={lang} trLang={trLang} empty="（这一版没有这行）" /></td>
                  <td data-side="draft"><Pair line={block.row.draft} other={block.row.latest} row={block.row} lang={lang} trLang={trLang} empty="（草稿里删去了）" /></td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

type Block = { kind: 'row'; row: CompareRow } | { kind: 'fold'; key: string; count: number };
function fold(rows: CompareRow[], collapse: boolean): Block[] {
  if (!collapse) return rows.map(row => ({ kind: 'row', row }));
  const out: Block[] = [];
  let run: CompareRow[] = [];
  const flush = () => {
    // A single identical line between changes stays visible as context.
    if (run.length === 1) out.push({ kind: 'row', row: run[0] });
    else if (run.length > 1) out.push({ kind: 'fold', key: 'fold-' + run[0].key, count: run.length });
    run = [];
  };
  for (const row of rows) {
    if (row.status === 'same') run.push(row);
    else { flush(); out.push({ kind: 'row', row }); }
  }
  flush();
  return out;
}

function Time({ row }: { row: CompareRow }) {
  if (row.changed.time && row.latestTime !== null && row.draftTime !== null) {
    return <span className="num"><del>{formatStamp(row.latestTime)}</del><ins>{formatStamp(row.draftTime)}</ins></span>;
  }
  const time = row.draftTime ?? row.latestTime;
  return <span className="num">{time === null ? '—' : formatStamp(time)}</span>;
}

function Pair({ line, other, row, lang, trLang, empty }: {
  line?: DraftLine; other?: DraftLine; row: CompareRow; lang?: string; trLang?: string; empty: string;
}) {
  if (!line) return <span className={styles.compareNone}>{empty}</span>;
  const paired = !!other;
  return (
    <>
      <span className={styles.compareOriginal} lang={lang} data-diff={paired && row.changed.original ? 'true' : undefined}>
        {line.original.trim() ? line.original : <span className={styles.compareBreak}>间奏</span>}
      </span>
      {(line.translation || (paired && row.changed.translation)) && (
        <span className={styles.compareTranslation} lang={trLang} data-diff={paired && row.changed.translation ? 'true' : undefined}>
          {line.translation || <span className={styles.compareBreak}>（无译文）</span>}
        </span>
      )}
    </>
  );
}
