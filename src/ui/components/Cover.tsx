import { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CoverImage } from '../../contracts/player.ts';
import { hashString } from '../lib/color.ts';
import styles from './Cover.module.css';

interface CoverProps {
  albumId: string;
  title: string;
  lang?: string;
  cover: CoverImage | null;
  /** thumb for grids/bars, full for hero artwork. URLs always come from the bridge. */
  variant?: 'thumb' | 'full';
  className?: string;
  style?: CSSProperties;
  /** Decorative when the title is already shown next to it. */
  decorative?: boolean;
  showTitleOnPlaceholder?: boolean;
}

/** Album artwork in its original colours; generated paper-and-disc placeholder when missing or broken. */
export function Cover({ albumId, title, lang, cover, variant = 'thumb', className, style, decorative = true,
  showTitleOnPlaceholder = true }: CoverProps) {
  const url = cover ? (variant === 'full' ? cover.fullUrl : cover.thumbUrl) : null;
  const [state, setState] = useState<{ url: string | null; status: 'loading' | 'loaded' | 'failed' }>({ url, status: 'loading' });
  const status = state.url === url ? state.status : 'loading';
  if (state.url !== url) setState({ url, status: 'loading' });
  const imgRef = useCallback((img: HTMLImageElement | null) => {
    if (img && img.complete && img.naturalWidth > 0) setState(s => (s.url === url ? { url, status: 'loaded' } : s));
  }, [url]);
  const tint = cover?.dominantColor;
  const ratio = cover?.width && cover?.height ? cover.width / cover.height : 1;
  return (
    <div className={[styles.cover, className].filter(Boolean).join(' ')} data-status={url ? status : 'none'}
      data-fit={ratio < 0.95 || ratio > 1.05 ? 'contain' : 'cover'}
      style={{ ...style, ...(tint ? { ['--cover-tint' as string]: tint } : {}) }}>
      {(!url || status === 'failed') && <Placeholder albumId={albumId} title={title} lang={lang} showTitle={showTitleOnPlaceholder} />}
      {url && status !== 'failed' && (
        <img ref={imgRef} src={url} alt={decorative ? '' : `${title} 的封面`} draggable={false} loading="lazy" decoding="async"
          width={cover?.width} height={cover?.height}
          onLoad={() => setState({ url, status: 'loaded' })} onError={() => setState({ url, status: 'failed' })} />
      )}
    </div>
  );
}

function Placeholder({ albumId, title, lang, showTitle }: { albumId: string; title: string; lang?: string; showTitle: boolean }) {
  const hash = hashString(albumId);
  const hue = 198 + (hash % 26);
  const angle = 120 + (hash % 70);
  const cx = 62 + ((hash >> 5) % 18);
  const cy = 38 + ((hash >> 9) % 18);
  return (
    <div className={styles.placeholder} aria-hidden="true"
      style={{ background: `linear-gradient(${angle}deg, hsl(${hue} 72% 95%), hsl(${hue + 8} 64% 86%) 70%, hsl(${hue + 14} 58% 80%))` }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
        <g fill="none" stroke="#fff" strokeOpacity=".75">
          <circle cx={cx} cy={cy} r="30" strokeWidth=".8" />
          <circle cx={cx} cy={cy} r="22" strokeWidth=".5" strokeOpacity=".5" />
          <circle cx={cx} cy={cy} r="8" strokeWidth="1.4" />
        </g>
        <circle cx={cx} cy={cy} r="3" fill="#fff" fillOpacity=".7" />
      </svg>
      {showTitle && <span className={styles.placeholderTitle} lang={lang}>{title}</span>}
    </div>
  );
}
