import type { Notice } from '../../contracts/player.ts';
import { Icon } from '../components/Icon.tsx';
import { useActions } from '../lib/actions.tsx';
import { useSurface } from '../lib/surface.tsx';
import styles from './Notices.module.css';

const TONE_ICON = { info: 'info', warning: 'warning', error: 'warning' } as const;

/** Passive events from the core (background failures, playback errors, demo notes). */
export function Notices({ notices, placement }: { notices: Notice[]; placement: 'plain' | 'capsule' | 'nowPlaying' }) {
  const { run } = useActions();
  if (!notices.length) return null;
  return (
    <div className={styles.stack} data-placement={placement}>
      {notices.slice(-3).map(notice => (
        <div key={notice.id} className={`${styles.toast} glass`} data-tone={notice.tone}
          role={notice.tone === 'error' ? 'alert' : 'status'}>
          <Icon name={TONE_ICON[notice.tone]} size={18} className={styles.icon} />
          <p className={styles.message}>{notice.message}</p>
          <div className={styles.actions}>
            {notice.action && (
              <button type="button" className="cdp-btn cdp-btn--text"
                onClick={() => run(notice.action!.action, { slot: 'library' })}>{notice.action.label}</button>
            )}
            <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label="关闭通知" title="关闭通知"
              onClick={() => run({ type: 'dismissNotice', noticeId: notice.id }, { slot: 'library', key: 'dismiss-' + notice.id })}>
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Shown while the playback core is unreachable; the UI keeps the last snapshot and recovers by itself. */
export function CoreBanner() {
  const { online } = useSurface();
  if (online) return null;
  return (
    <div className={styles.banner} role="status">
      <Icon name="warning" size={18} />
      <span><strong>播放核心没有响应。</strong>播放、保存和查找暂时不可用；恢复后界面会自动更新。</span>
    </div>
  );
}
