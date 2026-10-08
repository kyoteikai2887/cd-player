import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { Album } from '../../../contracts/player.ts';
import { Cover } from '../../components/Cover.tsx';
import { Icon } from '../../components/Icon.tsx';
import type { IconName } from '../../components/Icon.tsx';
import styles from './EditorFrame.module.css';

/**
 * Shared shell for the R2 editors (lyrics, metadata): a frosted workbench over the main window.
 * Focus moves in on open and back on close; Tab stays inside; Escape goes to the caller.
 */
export function EditorFrame({ album, art, kicker, meta, heading, headingLang, sub, subLang, status, actions, closeLabel, children, onClose, onEscape, onKeyDown }: {
  album?: Album; art?: IconName; kicker: string; meta?: ReactNode; heading: string; headingLang?: string; sub?: ReactNode; subLang?: string;
  status?: ReactNode; actions?: ReactNode; closeLabel: string; children: ReactNode;
  onClose?(): void; onEscape(): void; onKeyDown?(event: ReactKeyboardEvent<HTMLDivElement>): void;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { previous?.focus?.(); };
  }, []);
  const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab' && panel.current) {
      const nodes = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
      if (nodes.length) {
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    if (onKeyDown) onKeyDown(event);
    else if (event.key === 'Escape') { event.stopPropagation(); onEscape(); }
  };
  return (
    <div className={styles.overlay} onKeyDown={handleKey}>
      <div className={styles.scrim} aria-hidden="true" />
      <div ref={panel} className={`${styles.panel} glass glass-strong`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        <header className={styles.head}>
          {album ? <Cover albumId={album.id} title={album.title} cover={album.cover} className={styles.headArt} showTitleOnPlaceholder={false} />
            : <span className={styles.headArtEmpty}><Icon name={art ?? 'lyrics'} size={20} /></span>}
          <div className={styles.headText}>
            <p className={styles.headKicker}><span id={id}>{kicker}</span>{meta && <span className={styles.headMeta}>{meta}</span>}</p>
            <h2 className={styles.headTitle} lang={headingLang}>{heading}</h2>
            {sub && <p className={styles.headSub} lang={subLang}>{sub}</p>}
          </div>
          <div className={styles.headTrail}>
            {status}
            {actions}
            {onClose && <button type="button" className="cdp-icon-btn" aria-label={closeLabel} title={closeLabel} onClick={onClose}><Icon name="close" /></button>}
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

export type StatusTone = 'clean' | 'dirty' | 'warn';
export function EditorStatus({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={styles.status} data-tone={tone}>{children}</span>;
}

export type BannerTone = 'warn' | 'info' | 'ok' | 'ask';
export function Banner({ tone, icon, text, children, onDismiss }: {
  tone: BannerTone; icon: IconName; text: ReactNode; children?: ReactNode; onDismiss?(): void;
}) {
  return (
    <div className={styles.banner} data-tone={tone} role={tone === 'warn' ? 'alert' : 'status'}>
      <Icon name={icon} size={17} className={styles.bannerIcon} />
      <p className={styles.bannerText}>{text}</p>
      {children && <div className={styles.bannerActions}>{children}</div>}
      {onDismiss && <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label="关闭提示" title="关闭提示" onClick={onDismiss}><Icon name="close" size={14} /></button>}
    </div>
  );
}
export function BannerName({ children }: { children: ReactNode }) {
  return <span className={styles.bannerName}>{children}</span>;
}
export function BannerDetail({ children }: { children: ReactNode }) {
  return <span className={styles.bannerDetail}>{children}</span>;
}
/** Vertical stack for banners under the header. */
export function Banners({ children }: { children: ReactNode }) {
  return <div className={styles.banners}>{children}</div>;
}
