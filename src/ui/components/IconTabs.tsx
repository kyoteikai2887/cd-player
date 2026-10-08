import type { IconName } from './Icon.tsx';
import { Icon } from './Icon.tsx';

export interface IconTab<K extends string> { key: K; icon: IconName; label: string }

/**
 * Icon-first segmented control (R2.1): every option is an icon with a tooltip and an accessible
 * name; the chosen one also shows its word, so the current place is always spelled out once.
 * `mode` picks the semantics: toggle buttons (browse modes) or tabs (panels).
 */
export function IconTabs<K extends string>({ items, value, onChange, label, mode = 'pressed', as = 'div' }: {
  items: IconTab<K>[]; value: K; onChange(key: K): void; label: string; mode?: 'pressed' | 'tabs'; as?: 'div' | 'nav';
}) {
  const Root = as;
  return (
    <Root className="cdp-seg cdp-seg--icons" role={mode === 'tabs' ? 'tablist' : undefined} aria-label={label}>
      {items.map(item => {
        const active = item.key === value;
        return (
          <button key={item.key} type="button" title={item.label} aria-label={item.label}
            {...(mode === 'tabs' ? { role: 'tab', 'aria-selected': active } : { 'aria-pressed': active })}
            onClick={() => onChange(item.key)}>
            <Icon name={item.icon} size={18} />
            <span className="cdp-seg__word" aria-hidden="true">{item.label}</span>
          </button>
        );
      })}
    </Root>
  );
}
