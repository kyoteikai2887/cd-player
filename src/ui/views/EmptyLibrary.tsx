import { Icon } from '../components/Icon.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import { useSurface } from '../lib/surface.tsx';
import styles from './EmptyLibrary.module.css';

/** First run: an open, empty jewel case and one clear action. */
export function EmptyLibrary() {
  const { run, isPending } = useActions();
  const { online } = useSurface();
  return (
    <div className={styles.empty}>
      <svg className={styles.art} viewBox="0 0 240 170" aria-hidden="true">
        <defs>
          <linearGradient id="cdp-empty-disc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset=".45" stopColor="#e4effc" />
            <stop offset=".6" stopColor="#efe8fb" />
            <stop offset="1" stopColor="#dff1f4" />
          </linearGradient>
        </defs>
        <rect className={styles.case} x="18" y="22" width="120" height="126" rx="6" />
        <rect className={styles.spine} x="18" y="22" width="16" height="126" rx="3" />
        <rect className={styles.lid} x="102" y="14" width="120" height="126" rx="6" />
        <circle cx="162" cy="77" r="50" fill="url(#cdp-empty-disc)" stroke="rgba(20,37,61,.16)" />
        <circle cx="162" cy="77" r="17" fill="none" stroke="rgba(20,37,61,.12)" />
        <circle className={styles.hub} cx="162" cy="77" r="6" />
        <path d="M128 52a40 40 0 0 1 22-18" stroke="#fff" strokeWidth="3" strokeLinecap="round" fill="none" opacity=".9" />
      </svg>
      <h1 className={styles.title}>把抓好的 CD 放进来</h1>
      <p className={styles.body}>选择存放音乐的文件夹。专辑会按碟号和曲号排好，EAC 的日志和 CUE 会原样保留。</p>
      <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online}
        onClick={() => run({ type: 'importFolder' }, { slot: 'library', key: 'importFolder' })}>
        {isPending('importFolder') ? <span className="cdp-spinner" /> : <Icon name="folder" size={18} />}
        导入文件夹
      </button>
      <InlineError slot="library" className={styles.error} />
    </div>
  );
}
