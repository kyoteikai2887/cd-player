import { memo } from 'react';
import { Icon } from '../../components/Icon.tsx';
import type { DraftAction, DraftKind, DraftLine } from '../../lib/lyricsDraft.ts';
import { AutoTextarea, TimeField } from './fields.tsx';
import styles from '../LyricsEditorSheet.module.css';

export interface LineProps {
  line: DraftLine;
  /** 1-based position among all lines, for labels. */
  number: number;
  kind: DraftKind;
  offsetMs: number;
  issues?: string[];
  showTranslation: boolean;
  tapping: boolean;
  isCursor: boolean;
  /** The current track is this one, so "set to now" and tap timing can work. */
  canStampNow: boolean;
  lang?: string;
  trLang?: string;
  dispatch(action: DraftAction): void;
  onStampNow(id: string): void;
  onCursor(id: string): void;
  onInsert(afterId: string): void;
}

/**
 * One lyric line: time (as heard), original, translation and quiet row tools. A timed line with
 * an empty original is a break — it ends the previous line's highlight.
 */
export const EditorLine = memo(function EditorLine(props: LineProps) {
  const { line, number, kind, offsetMs, issues, showTranslation, tapping, isCursor, canStampNow, lang, trLang, dispatch } = props;
  const effective = line.startMs === null ? null : line.startMs + offsetMs;
  const isBreak = kind === 'synced' && !line.original.trim();
  return (
    <li className={styles.line} data-line-id={line.id} data-break={isBreak ? 'true' : 'false'}
      data-cursor={tapping && isCursor ? 'true' : 'false'} data-invalid={issues?.length ? 'true' : 'false'}>
      <div className={styles.gutter}>
        {tapping ? (
          <button type="button" className={styles.cursorButton} aria-label={`从第 ${number} 行开始打轴`} title="从这一行开始打轴" aria-pressed={isCursor}
            onClick={() => props.onCursor(line.id)}>
            {isCursor ? <Icon name="tap" size={16} /> : <span className="num">{number}</span>}
          </button>
        ) : <span className={`${styles.number} num`} aria-hidden="true">{number}</span>}
        <i className={styles.playing} aria-hidden="true" />
      </div>
      {kind === 'synced' && (
        <div className={styles.timeCell}>
          <TimeField value={effective} label={`第 ${number} 行时间`} onCommit={ms => dispatch({ type: 'time', id: line.id, effectiveMs: ms })} />
        </div>
      )}
      <div className={styles.texts} data-translation={showTranslation ? 'true' : 'false'}>
        <AutoTextarea className={styles.original} value={line.original} lang={lang}
          aria-label={`第 ${number} 行原文`} placeholder={isBreak ? '间奏' : '原文'}
          title={isBreak ? '留空的同步行是间奏：上一句的高亮在这里结束' : undefined}
          onValue={value => dispatch({ type: 'text', id: line.id, field: 'original', value })} />
        {showTranslation && (
          <AutoTextarea className={styles.translation} value={line.translation} lang={trLang}
            aria-label={`第 ${number} 行译文`} placeholder={isBreak ? '' : '译文'} disabled={isBreak && !line.translation}
            onValue={value => dispatch({ type: 'text', id: line.id, field: 'translation', value })} />
        )}
      </div>
      <div className={styles.tools}>
        {kind === 'synced' && (
          <>
            <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label={`第 ${number} 行提前 0.1 秒`} title="提前 0.1 秒"
              disabled={effective === null} onClick={() => dispatch({ type: 'nudge', id: line.id, deltaMs: -100 })}>
              <span className={styles.nudge}>−.1</span>
            </button>
            <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label={`第 ${number} 行延后 0.1 秒`} title="延后 0.1 秒"
              disabled={effective === null} onClick={() => dispatch({ type: 'nudge', id: line.id, deltaMs: 100 })}>
              <span className={styles.nudge}>+.1</span>
            </button>
            <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label={`第 ${number} 行设为当前播放时间`}
              title={canStampNow ? '设为当前播放时间' : '播放这首歌后可用'} disabled={!canStampNow}
              onClick={() => props.onStampNow(line.id)}>
              <Icon name="stopwatch" size={16} />
            </button>
          </>
        )}
        <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label={`在第 ${number} 行后插入一行`} title="在下面插入一行"
          onClick={() => props.onInsert(line.id)}>
          <Icon name="insertBelow" size={16} />
        </button>
        <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label={`删除第 ${number} 行`} title="删除这一行"
          onClick={() => dispatch({ type: 'remove', id: line.id })}>
          <Icon name="trash" size={16} />
        </button>
      </div>
      {issues?.length ? <p className={styles.issue} role="note">{issues.join(' ')}</p> : null}
    </li>
  );
});
