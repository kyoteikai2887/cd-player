import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Icon } from '../components/Icon.tsx';
import styles from './Sheet.module.css';

/**
 * Side sheet over the current view. Escape and the scrim close it; focus moves in on open
 * and returns to the previously focused control on close. Tab stays inside the sheet.
 */
export function Sheet({ title, subtitle, onClose, children, footer, wide = false, closeLabel = '关闭', onKeyDown: onKey, raised = false }: {
  title: string; subtitle?: ReactNode; onClose(): void; children: ReactNode; footer?: ReactNode;
  /** 'xl' is for two-pane sheets (a list beside a preview). */
  wide?: boolean | 'xl'; closeLabel?: string;
  /** Runs first; a handler that stops propagation keeps the key from the sheet's own handling too. */
  onKeyDown?(event: ReactKeyboardEvent<HTMLDivElement>): void;
  /** Above the full-window editors (a sheet the editor itself opened). */
  raised?: boolean;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { previous?.focus?.(); };
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKey?.(event);
    if (event.isPropagationStopped()) return;
    if (event.key === 'Escape') { event.stopPropagation(); onCloseRef.current(); return; }
    if (event.key !== 'Tab' || !panel.current) return;
    const nodes = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])')];
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return (
    <div className={styles.overlay} data-raised={raised ? 'true' : undefined} onKeyDown={onKeyDown}>
      <div className={styles.scrim} onClick={() => onCloseRef.current()} aria-hidden="true" />
      <div ref={panel} className={`${styles.panel} glass glass-strong`} data-wide={wide === 'xl' ? 'xl' : wide ? 'true' : 'false'} role="dialog" aria-modal="true"
        aria-labelledby={id} tabIndex={-1}>
        <header className={styles.head}>
          <div className={styles.titles}>
            <h2 id={id} className={styles.title}>{title}</h2>
            {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
          </div>
          <button type="button" className="cdp-icon-btn" aria-label={closeLabel} title={closeLabel} onClick={() => onCloseRef.current()}><Icon name="close" /></button>
        </header>
        <div className={styles.content}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </div>
  );
}
