import type { ReactNode } from 'react';
import styles from './Obi.module.css';

/** Longer work titles set smaller so a typical name (up to ~9 characters) fits the band. */
const obiSize = (title: string) => {
  const length = [...title].length;
  return length <= 4 ? 'l' : length <= 6 ? 'm' : 's';
};

/**
 * 帯 (obi): the paper band on the spine side of a Japanese CD case. It carries the work title
 * and catalog number in vertical type. Decorative duplicate of data shown elsewhere.
 */
export function Obi({ title, catalog, lang }: { title: string | null; catalog: string | null; lang?: string }) {
  if (!title && !catalog) return null;
  return (
    <div className={styles.obi} aria-hidden="true">
      <span className={styles.head}><i /></span>
      {title && <span className={styles.title} lang={lang} data-size={obiSize(title)}>{title}</span>}
      {catalog && <span className={styles.catalog}>{catalog}</span>}
    </div>
  );
}

/** Sleeve with an optional obi on its left; the cover keeps every pixel of its artwork. */
export function WithObi({ title, catalog, lang, children, className }: {
  title: string | null; catalog: string | null; lang?: string; children: ReactNode; className?: string;
}) {
  if (!title && !catalog) return <div className={className}>{children}</div>;
  return (
    <div className={[styles.withObi, className].filter(Boolean).join(' ')}>
      <Obi title={title} catalog={catalog} lang={lang} />
      {children}
    </div>
  );
}
