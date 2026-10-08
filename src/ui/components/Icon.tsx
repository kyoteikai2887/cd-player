import type { ReactElement } from 'react';

/** Hand-drawn 20px icon set: 1.6 stroke, round caps. Playback glyphs are filled. No dependency. */
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const paths = {
  play: <path d="M6.2 3.9c0-.9 1-1.5 1.8-1l9 5.6c.7.5.7 1.6 0 2.1L8 16.1c-.8.5-1.8-.1-1.8-1V3.9Z" fill="currentColor" />,
  pause: <g fill="currentColor"><rect x="4.6" y="3.2" width="3.9" height="13.6" rx="1.3" /><rect x="11.5" y="3.2" width="3.9" height="13.6" rx="1.3" /></g>,
  prev: <g fill="currentColor"><rect x="3.4" y="3.6" width="2.2" height="12.8" rx="1.1" /><path d="M16.6 4.8c0-.8-.9-1.3-1.6-.8l-7.8 5.2c-.6.4-.6 1.3 0 1.7l7.8 5.2c.7.5 1.6 0 1.6-.8V4.8Z" /></g>,
  next: <g fill="currentColor"><rect x="14.4" y="3.6" width="2.2" height="12.8" rx="1.1" /><path d="M3.4 4.8c0-.8.9-1.3 1.6-.8l7.8 5.2c.6.4.6 1.3 0 1.7L5 16.1c-.7.5-1.6 0-1.6-.8V4.8Z" /></g>,
  shuffle: <g {...stroke}><path d="M2.8 6h2.6c1.4 0 2.6.7 3.4 1.8l2.4 4.4c.8 1.1 2 1.8 3.4 1.8h2.6" /><path d="M2.8 14h2.6c1.2 0 2.3-.5 3-1.4M11.2 7.4c.8-.9 1.9-1.4 3-1.4h3" /><path d="m15.4 3.8 2.2 2.2-2.2 2.2M15.4 11.8l2.2 2.2-2.2 2.2" /></g>,
  repeat: <g {...stroke}><path d="M4 9.2V8a3 3 0 0 1 3-3h9.4" /><path d="m14 2.8 2.4 2.2L14 7.2" /><path d="M16 10.8V12a3 3 0 0 1-3 3H3.6" /><path d="m6 12.8-2.4 2.2L6 17.2" /></g>,
  repeatOne: <g {...stroke}><path d="M4 9.2V8a3 3 0 0 1 3-3h9.4" /><path d="m14 2.8 2.4 2.2L14 7.2" /><path d="M16 10.8V12a3 3 0 0 1-3 3H3.6" /><path d="m6 12.8-2.4 2.2L6 17.2" /><path d="M9.3 9.1 10.6 8v5" /></g>,
  volume: <g {...stroke}><path d="M3.2 7.6h2.6l4-3.2v11.2l-4-3.2H3.2z" fill="currentColor" fillOpacity=".12" /><path d="M13 7.4a3.6 3.6 0 0 1 0 5.2M15.3 5.2a6.8 6.8 0 0 1 0 9.6" /></g>,
  volumeLow: <g {...stroke}><path d="M3.2 7.6h2.6l4-3.2v11.2l-4-3.2H3.2z" fill="currentColor" fillOpacity=".12" /><path d="M13 7.4a3.6 3.6 0 0 1 0 5.2" /></g>,
  volumeMute: <g {...stroke}><path d="M3.2 7.6h2.6l4-3.2v11.2l-4-3.2H3.2z" fill="currentColor" fillOpacity=".12" /><path d="m13.2 8 4 4M17.2 8l-4 4" /></g>,
  search: <g {...stroke}><circle cx="8.8" cy="8.8" r="5.3" /><path d="m12.8 12.8 4 4" /></g>,
  plus: <g {...stroke}><path d="M10 4v12M4 10h12" /></g>,
  tune: <g {...stroke}><path d="M3.5 6h6.8M14.6 6h1.9M3.5 14h1.9M9.7 14h6.8" /><circle cx="12.4" cy="6" r="2.1" /><circle cx="7.6" cy="14" r="2.1" /></g>,
  back: <g {...stroke}><path d="m12.2 4.4-5.6 5.6 5.6 5.6" /></g>,
  chevronDown: <g {...stroke}><path d="m5.4 8 4.6 4.6L14.6 8" /></g>,
  chevronRight: <g {...stroke}><path d="m8 5.4 4.6 4.6L8 14.6" /></g>,
  more: <g fill="currentColor"><circle cx="4.6" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="15.4" cy="10" r="1.5" /></g>,
  close: <g {...stroke}><path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6" /></g>,
  check: <g {...stroke}><path d="m4.4 10.4 3.6 3.6 7.6-8" /></g>,
  mini: <g {...stroke}><rect x="2.8" y="4" width="14.4" height="12" rx="2.4" /><rect x="9.6" y="10" width="5.4" height="3.8" rx="1" fill="currentColor" fillOpacity=".22" /></g>,
  expand: <g {...stroke}><path d="M11.6 3.6h4.8v4.8M16.4 3.6l-5.2 5.2M8.4 16.4H3.6v-4.8M3.6 16.4l5.2-5.2" /></g>,
  pin: <g {...stroke}><path d="M12.6 2.9 17.1 7.4l-2.3.8-3.1 3.1.1 3.2-1.3 1.3-6.3-6.3 1.3-1.3 3.2.1 3.1-3.1.8-2.3Z" /><path d="m6.7 13.3-3.8 3.8" /></g>,
  disc: <g {...stroke}><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="2" /><path d="M5.8 8.2a4.6 4.6 0 0 1 2.4-2.4" opacity=".6" /></g>,
  note: <g {...stroke}><path d="M8 14.6V4.8l8-1.8v9.6" /><circle cx="5.8" cy="14.6" r="2.2" fill="currentColor" fillOpacity=".15" /><circle cx="13.8" cy="12.6" r="2.2" fill="currentColor" fillOpacity=".15" /></g>,
  mic: <g {...stroke}><rect x="7.2" y="2.8" width="5.6" height="9.4" rx="2.8" /><path d="M4.6 9.6a5.4 5.4 0 0 0 10.8 0M10 15v2.4" /></g>,
  lyrics: <g {...stroke}><path d="M4 5.2h12M4 9.2h8.4M4 13.2h10M4 17.2h5.4" /></g>,
  lock: <g {...stroke}><rect x="4.4" y="8.6" width="11.2" height="8.4" rx="2" /><path d="M7 8.6V6.4a3 3 0 0 1 6 0v2.2" /></g>,
  image: <g {...stroke}><rect x="3" y="3.6" width="14" height="12.8" rx="2.4" /><circle cx="7.4" cy="8" r="1.4" /><path d="m3.4 14.4 4-3.6 3 2.4 2.6-2.2 3.6 3" /></g>,
  refresh: <g {...stroke}><path d="M16 10a6 6 0 1 1-1.8-4.3" /><path d="M16.2 3.4v3.2H13" /></g>,
  info: <g {...stroke}><circle cx="10" cy="10" r="7.2" /><path d="M10 9.2v4.4" /><circle cx="10" cy="6.4" r=".4" fill="currentColor" /></g>,
  warning: <g {...stroke}><path d="M8.6 3.6a1.6 1.6 0 0 1 2.8 0l6 10.6a1.6 1.6 0 0 1-1.4 2.4H4a1.6 1.6 0 0 1-1.4-2.4l6-10.6Z" /><path d="M10 8v3.6" /><circle cx="10" cy="14" r=".4" fill="currentColor" /></g>,
  list: <g {...stroke}><path d="M7.4 5.4h9M7.4 10h9M7.4 14.6h9" /><circle cx="3.9" cy="5.4" r=".6" fill="currentColor" /><circle cx="3.9" cy="10" r=".6" fill="currentColor" /><circle cx="3.9" cy="14.6" r=".6" fill="currentColor" /></g>,
  queueNext: <g {...stroke}><path d="M3.6 5.4h9M3.6 10h6.4M3.6 14.6h6.4" /><path d="m13 11.2 3.6 2.6-3.6 2.6z" fill="currentColor" /></g>,
  edit: <g {...stroke}><path d="m12.6 4 3.4 3.4-8.6 8.6-4 .6.6-4z" /><path d="m11 5.6 3.4 3.4" /></g>,
  folder: <g {...stroke}><path d="M2.8 6.2a1.8 1.8 0 0 1 1.8-1.8h3.2l1.8 1.8h5.8a1.8 1.8 0 0 1 1.8 1.8v6.6a1.8 1.8 0 0 1-1.8 1.8H4.6a1.8 1.8 0 0 1-1.8-1.8V6.2Z" /><path d="M10 8.6v4.8M7.6 11 10 13.4l2.4-2.4" /></g>,
  importFile: <g {...stroke}><path d="M5 2.8h6.2L15 6.6v9a1.6 1.6 0 0 1-1.6 1.6H5a1.6 1.6 0 0 1-1.6-1.6V4.4A1.6 1.6 0 0 1 5 2.8Z" /><path d="M11 2.8v4h4M9.2 9.4v5M7 12.2l2.2 2.2 2.2-2.2" /></g>,
  translate: <g {...stroke}><path d="M3 5h7M6.5 3.4V5M4.4 5c.4 2.6 2 4.6 4.4 5.6M8.6 5c-.5 2.8-2.4 5-5 6" /><path d="m10.2 16.6 3-7.2 3 7.2M11.2 14.4h4" /></g>,
  timer: <g {...stroke}><circle cx="10" cy="11" r="6" /><path d="M10 8v3.2l2 1.4M8 2.8h4" /></g>,
  sparkle: <g {...stroke}><path d="M10 3.2c.5 3.4 1.9 4.9 5.2 5.4-3.3.5-4.7 2-5.2 5.4-.5-3.4-1.9-4.9-5.2-5.4C8.1 8.1 9.5 6.6 10 3.2Z" /></g>,
  record: <g {...stroke}><circle cx="10" cy="10" r="2.6" fill="currentColor" /><circle cx="10" cy="10" r="7" /></g>,
  // R2 editing set
  undo: <g {...stroke}><path d="M7.4 5.2 3.8 8.6l3.6 3.4" /><path d="M4.2 8.6h7.6a4.4 4.4 0 0 1 0 8.8H9.4" /></g>,
  redo: <g {...stroke}><path d="m12.6 5.2 3.6 3.4-3.6 3.4" /><path d="M15.8 8.6H8.2a4.4 4.4 0 0 0 0 8.8h2.4" /></g>,
  trash: <g {...stroke}><path d="M3.8 5.6h12.4M8 5.6V4a1.2 1.2 0 0 1 1.2-1.2h1.6A1.2 1.2 0 0 1 12 4v1.6" /><path d="m5.2 5.6.8 10.2a1.6 1.6 0 0 0 1.6 1.4h4.8a1.6 1.6 0 0 0 1.6-1.4l.8-10.2" /></g>,
  arrowUp: <g {...stroke}><path d="M10 16.2V4M5.4 8.4 10 3.8l4.6 4.6" /></g>,
  arrowDown: <g {...stroke}><path d="M10 3.8v12.2M5.4 11.6l4.6 4.6 4.6-4.6" /></g>,
  grip: <g fill="currentColor"><circle cx="7.4" cy="5" r="1.3" /><circle cx="12.6" cy="5" r="1.3" /><circle cx="7.4" cy="10" r="1.3" /><circle cx="12.6" cy="10" r="1.3" /><circle cx="7.4" cy="15" r="1.3" /><circle cx="12.6" cy="15" r="1.3" /></g>,
  insertBelow: <g {...stroke}><path d="M3.6 5.2h12.8M3.6 9.2h12.8" opacity=".55" /><path d="M10 11.6v5.6M7.2 14.4h5.6" /></g>,
  tap: <g {...stroke}><circle cx="10" cy="10" r="2.2" fill="currentColor" /><path d="M10 2.6v2.6M10 14.8v2.6M2.6 10h2.6M14.8 10h2.6" /><circle cx="10" cy="10" r="5.6" opacity=".45" /></g>,
  stopwatch: <g {...stroke}><circle cx="10" cy="11.2" r="5.8" /><path d="M10 11.2 12.4 8.8M8.2 2.8h3.6M10 2.8v2.6M15.2 5.6l1.2-1.2" /></g>,
  compare: <g {...stroke}><rect x="2.8" y="3.6" width="6" height="12.8" rx="1.6" /><rect x="11.2" y="3.6" width="6" height="12.8" rx="1.6" /><path d="M5 7.6h1.6M5 10.4h1.6M13.4 7.6h1.6M13.4 10.4h1.6" /></g>,
  merge: <g {...stroke}><path d="M5 3.4v4.2a3 3 0 0 0 1.2 2.4L10 13v3.6M15 3.4v4.2a3 3 0 0 1-1.2 2.4L10 13" /><path d="m7.8 14.2 2.2 2.4 2.2-2.4" /></g>,
  unlock: <g {...stroke}><rect x="4.4" y="8.6" width="11.2" height="8.4" rx="2" /><path d="M7 8.6V6.4a3 3 0 0 1 5.8-1" /></g>,
  person: <g {...stroke}><circle cx="10" cy="6.6" r="3.2" /><path d="M3.8 17c.6-3.4 3.2-5.4 6.2-5.4s5.6 2 6.2 5.4" /></g>,
  // R2.1: icon-first navigation.
  /** The shelf: four cases face out. */
  shelf: <g {...stroke}><rect x="3" y="3" width="6" height="6" rx="1.3" /><rect x="11" y="3" width="6" height="6" rx="1.3" /><rect x="3" y="11" width="6" height="6" rx="1.3" /><rect x="11" y="11" width="6" height="6" rx="1.3" fill="currentColor" fillOpacity=".18" /></g>,
  /** A series: cases stacked behind one another. */
  works: <g {...stroke}><rect x="6.6" y="2.8" width="10.6" height="10.6" rx="1.8" /><path d="M4.6 5.6v8.8c0 1 .8 1.8 1.8 1.8h8.8" /><path d="M2.8 8.2v8a1.8 1.8 0 0 0 1.8 1.8h8" opacity=".55" /></g>,
  people: <g {...stroke}><circle cx="8" cy="7" r="2.9" /><path d="M2.8 16.6c.5-3 2.6-4.8 5.2-4.8s4.7 1.8 5.2 4.8" /><path d="M12.6 4.4a2.8 2.8 0 0 1 0 5.4M14.6 12.2c1.4.6 2.4 2.1 2.7 4.2" /></g>,
  sort: <g {...stroke}><path d="M3.6 5.2h7.6M3.6 10h5.6M3.6 14.8h3.6" /><path d="M14.8 4v12M12.4 13.6l2.4 2.4 2.4-2.4" /></g>,
  clock: <g {...stroke}><circle cx="10" cy="10" r="7.2" /><path d="M10 6.2V10l2.6 1.8" /></g>,
  folderPlus: <g {...stroke}><path d="M2.8 6.2a1.8 1.8 0 0 1 1.8-1.8h3.2l1.8 1.8h5.8a1.8 1.8 0 0 1 1.8 1.8v6.6a1.8 1.8 0 0 1-1.8 1.8H4.6a1.8 1.8 0 0 1-1.8-1.8V6.2Z" /><path d="M10 8.6v5M7.5 11.1h5" /></g>,
  /** Open the full view (album page, now playing). */
  open: <g {...stroke}><path d="M8.4 4H5.6A1.6 1.6 0 0 0 4 5.6v8.8A1.6 1.6 0 0 0 5.6 16h8.8a1.6 1.6 0 0 0 1.6-1.6v-2.8" /><path d="M11.4 4h4.6v4.6M16 4l-6.2 6.2" /></g>,
  calendar: <g {...stroke}><rect x="3.2" y="4.4" width="13.6" height="12" rx="2" /><path d="M3.2 8.4h13.6M7 2.8v3M13 2.8v3" /></g>,
  tag: <g {...stroke}><path d="M3.2 4.8v4.4c0 .5.2.9.5 1.2l6 6a1.6 1.6 0 0 0 2.3 0l4.3-4.3a1.6 1.6 0 0 0 0-2.3l-6-6a1.6 1.6 0 0 0-1.2-.5H4.8c-.9 0-1.6.7-1.6 1.6Z" /><circle cx="6.8" cy="6.8" r="1.1" fill="currentColor" /></g>,
  // R2.2: removing an album from the collection.
  /** The shelf with one place emptied. */
  shelfRemove: <g {...stroke}><rect x="3" y="3" width="6" height="6" rx="1.3" /><rect x="11" y="3" width="6" height="6" rx="1.3" /><rect x="3" y="11" width="6" height="6" rx="1.3" /><path d="M11.4 14h5.2" /></g>,
  /** A kept copy (backup). */
  archive: <g {...stroke}><rect x="2.8" y="3.6" width="14.4" height="3.8" rx="1.2" /><path d="M4.2 7.4v7.4a1.8 1.8 0 0 0 1.8 1.8h8a1.8 1.8 0 0 0 1.8-1.8V7.4M8 10.6h4" /></g>,
  stop: <rect x="5" y="5" width="10" height="10" rx="1.8" fill="currentColor" />,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 20 20" aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined} focusable="false">
      {title ? <title>{title}</title> : null}
      {paths[name]}
    </svg>
  );
}
