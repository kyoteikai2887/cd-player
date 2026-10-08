import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, TextareaHTMLAttributes } from 'react';
import { formatStamp, parseStamp } from '../../lib/lyricsDraft.ts';
import styles from './fields.module.css';

const fieldSizing = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

/** A textarea that grows with its content (CSS field-sizing where available, measured otherwise). */
export function AutoTextarea({ value, onValue, className, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & {
  value: string; onValue(value: string): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || fieldSizing) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return <textarea ref={ref} rows={1} spellCheck={false} {...rest} className={`${styles.area} ${className ?? ''}`} value={value}
    onChange={event => onValue(event.target.value)} />;
}

/**
 * Effective time (m:ss.cc). Shows the formatted value; while focused the text is free to edit and is
 * committed on Enter or blur. Invalid text stays visible and marked until fixed or Escape.
 */
export function TimeField({ value, onCommit, label, disabled }: {
  value: number | null; onCommit(ms: number | null): void; label: string; disabled?: boolean;
}) {
  const shown = value === null ? '' : formatStamp(value);
  const [text, setText] = useState<string | null>(null);
  const invalid = text !== null && text.trim() !== '' && parseStamp(text) === null;
  const commit = () => {
    if (text === null) return;
    if (text.trim() === '') { if (value !== null) onCommit(null); setText(null); return; }
    const ms = parseStamp(text);
    if (ms === null) return;
    if (ms !== value) onCommit(ms);
    setText(null);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); selectIfFocused(event.currentTarget); }
    else if (event.key === 'Escape' && text !== null) { event.stopPropagation(); setText(null); }
  };
  return (
    <input className={`${styles.time} num`} type="text" inputMode="decimal" aria-label={label} disabled={disabled}
      aria-invalid={invalid || undefined} placeholder="未定时" value={text ?? shown}
      onFocus={event => { const el = event.currentTarget; requestAnimationFrame(() => selectIfFocused(el)); }}
      onChange={event => setText(event.target.value)} onBlur={commit} onKeyDown={onKeyDown}
      title={invalid ? '格式：分:秒.百分秒，例如 1:23.45，可为负数' : undefined} />
  );
}

/** Selects the text only while the field has focus (select() would otherwise pull focus back). */
function selectIfFocused(el: HTMLInputElement) {
  if (el.ownerDocument.activeElement === el) el.select();
}

export const LANGUAGES: [string, string][] = [['ja', '日语'], ['zh-Hans', '简体中文'], ['zh-Hant', '繁体中文'], ['en', '英语'], ['ko', '韩语']];
/** Known languages plus a tag already present in the data, so nothing is lost by opening a form. */
export const languageOptions = (value: string | null): [string, string][] =>
  value && !LANGUAGES.some(([tag]) => tag === value) ? [...LANGUAGES, [value, value]] : LANGUAGES;

/** Language tag or none. Unknown tags already in the data stay selectable as they are. */
export function LanguageSelect({ value, onChange, label }: { value: string | null; onChange(value: string | null): void; label: string }) {
  const id = useId();
  const options = languageOptions(value);
  return (
    <label className={styles.lang} htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value ?? ''} onChange={event => onChange(event.target.value || null)}>
        <option value="">未标注</option>
        {options.map(([tag, name]) => <option key={tag} value={tag}>{name}</option>)}
      </select>
    </label>
  );
}

/** Focus a control after React commits (used to move the caret to a new or flagged line). */
export function useFocusRequest() {
  const [request, setRequest] = useState<string | null>(null);
  useEffect(() => {
    if (!request) return;
    const el = document.querySelector<HTMLElement>(request);
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest' });
    setRequest(null);
  }, [request]);
  return setRequest;
}

/**
 * A list of names (artists) as removable chips plus a field to add more. Enter or a comma adds;
 * Backspace in the empty field removes the last name. Order is kept as entered.
 */
export function NameList({ names, onChange, label, placeholder, describedBy, invalid }: {
  names: string[]; onChange(names: string[]): void; label: string; placeholder?: string; describedBy?: string; invalid?: boolean;
}) {
  const [text, setText] = useState('');
  const add = (value: string) => {
    const parts = value.split(/[,，、]/).map(p => p.trim()).filter(Boolean).filter(p => !names.includes(p));
    if (parts.length) onChange([...names, ...parts]);
    setText('');
  };
  return (
    <div className={styles.names} data-invalid={invalid ? 'true' : undefined}>
      <ul className={styles.nameChips} aria-label={label}>
        {names.map((name, i) => (
          <li key={name + i} className={styles.nameChip}>
            <span lang={/[぀-ヿ]/.test(name) ? 'ja' : undefined}>{name}</span>
            <button type="button" aria-label={`移除 ${name}`} title="移除" onClick={() => onChange(names.filter((_, k) => k !== i))}>×</button>
          </li>
        ))}
      </ul>
      <input className={styles.nameInput} type="text" value={text} aria-label={`添加${label}`} aria-describedby={describedBy}
        placeholder={names.length ? '再添加一位…' : placeholder ?? '输入名字，回车添加'}
        onChange={event => { const v = event.target.value; if (/[,，、]$/.test(v)) add(v); else setText(v); }}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); if (text.trim()) add(text); }
          else if (event.key === 'Backspace' && !text && names.length) onChange(names.slice(0, -1));
        }}
        onBlur={() => { if (text.trim()) add(text); }} />
    </div>
  );
}
