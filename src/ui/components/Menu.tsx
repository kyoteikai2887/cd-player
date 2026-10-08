import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';

export type MenuItem =
  | { kind?: 'item'; label: string; icon?: IconName; onSelect: () => void; disabled?: boolean; hint?: string }
  | { kind: 'separator' };

interface MenuProps {
  label: string;
  items: MenuItem[];
  align?: 'start' | 'end';
  placement?: 'below' | 'above';
  trigger?: (props: { open: boolean; toggle: () => void; id: string; ref: (el: HTMLButtonElement | null) => void }) => ReactNode;
  buttonClassName?: string;
  /** Hover tooltip for the default trigger; defaults to the label. */
  tooltip?: string;
}

/** Small acrylic menu: click outside / Escape closes, arrow keys move, focus returns to the trigger. */
export function Menu({ label, items, align = 'end', placement = 'below', trigger, buttonClassName, tooltip }: MenuProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    first?.focus();
    const onDown = (event: PointerEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const close = (refocus = true) => { setOpen(false); if (refocus) button.current?.focus(); };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!open) return;
    if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const nodes = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!nodes.length) return;
    const current = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length;
    nodes[next].focus();
  };
  const toggle = () => setOpen(value => !value);
  const setButton = (el: HTMLButtonElement | null) => { button.current = el; };

  return (
    <div ref={wrapper} style={{ position: 'relative', display: 'inline-flex' }} onKeyDown={onKeyDown}>
      {trigger ? trigger({ open, toggle, id, ref: setButton }) : (
        <button ref={setButton} type="button" className={buttonClassName ?? 'cdp-icon-btn'} aria-label={label} title={tooltip ?? label}
          aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
          <Icon name="more" />
        </button>
      )}
      {open && (
        <div ref={list} id={id} role="menu" aria-label={label} className="cdp-menu glass"
          style={{ [align === 'end' ? 'right' : 'left']: 0, ...(placement === 'below' ? { top: 'calc(100% + 6px)' } : { bottom: 'calc(100% + 6px)' }) }}>
          {items.map((item, index) => item.kind === 'separator' ? <hr key={'sep' + index} /> : (
            <button key={item.label} type="button" role="menuitem" disabled={item.disabled} title={item.hint}
              onClick={() => { close(false); item.onSelect(); }}>
              {item.icon && <Icon name={item.icon} size={18} />}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
