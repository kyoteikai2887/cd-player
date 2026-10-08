import type { RefObject } from 'react';
import type { TaskInfo } from '../../contracts/player.ts';
import { Icon } from '../components/Icon.tsx';
import { IconTabs } from '../components/IconTabs.tsx';
import type { IconTab } from '../components/IconTabs.tsx';
import { VinylMark } from '../components/VinylMark.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import type { LibraryTab, Route } from './MainSurface.tsx';
import styles from './TopBar.module.css';

const TABS: IconTab<LibraryTab>[] = [
  { key: 'albums', icon: 'shelf', label: '专辑' },
  { key: 'works', icon: 'works', label: '作品' },
  { key: 'artists', icon: 'people', label: '艺术家' },
];
const BRAND = 'CD 收藏';
const MARK = 46;

interface TopBarProps {
  route: Route;
  tab: LibraryTab;
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  tasks: TaskInfo[];
  libraryEmpty: boolean;
  onTab(tab: LibraryTab): void;
  onQuery(query: string): void;
  onBack(): void;
  onOpenSettings(): void;
}

export function TopBar({ route, tab, query, searchRef, tasks, libraryEmpty, onTab, onQuery, onBack, onOpenSettings }: TopBarProps) {
  const { run, isPending } = useActions();
  const { online } = useSurface();
  const inLibrary = route.name === 'library';
  return (
    <header className={styles.bar}>
      <div className={styles.lead}>
        {/* The record is the brand. On the shelf it names the page; elsewhere it is the way home. */}
        {inLibrary ? (
          <div className={styles.brand} title={BRAND}>
            <h1 className="sr-only">{BRAND}</h1>
            <TurningRecord />
          </div>
        ) : (
          <button type="button" className={styles.home} onClick={onBack} aria-label={`返回${BRAND}`} title={`返回${BRAND}`}>
            <Icon name="back" size={18} className={styles.homeChevron} />
            <TurningRecord />
          </button>
        )}
        {inLibrary && !libraryEmpty && <IconTabs as="nav" label="浏览方式" items={TABS} value={tab} onChange={onTab} />}
      </div>
      <div className={styles.trail}>
        {!libraryEmpty && <InlineError slot="library" />}
        {tasks.length > 0 && <TaskPill tasks={tasks} />}
        {!libraryEmpty && (
          <label className={styles.search}>
            <Icon name="search" size={17} />
            <input ref={searchRef} type="search" placeholder="搜索" aria-label="搜索音乐" title="搜索专辑、曲名、歌手、CV 或品番"
              value={query} onChange={event => onQuery(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape' && query) { event.stopPropagation(); onQuery(''); } }} />
            {query && <button type="button" className={styles.clear} aria-label="清除搜索" title="清除搜索" onClick={() => onQuery('')}><Icon name="close" size={14} /></button>}
          </label>
        )}
        {!libraryEmpty && (
          <button type="button" className="cdp-icon-btn cdp-icon-btn--glass" aria-label="导入文件夹" title="导入文件夹" disabled={!online}
            onClick={() => run({ type: 'importFolder' }, { slot: 'library', key: 'importFolder' })}>
            {isPending('importFolder') ? <span className="cdp-spinner" /> : <Icon name="folderPlus" />}
          </button>
        )}
        <button type="button" className="cdp-icon-btn cdp-icon-btn--glass" aria-label="迷你模式" title="迷你模式" disabled={!online}
          onClick={() => run({ type: 'setWindowMode', mode: 'mini' }, { slot: 'library', key: 'mini' })}>
          <Icon name="mini" />
        </button>
        <button type="button" className="cdp-icon-btn cdp-icon-btn--glass" aria-label="设置" title="设置" onClick={onOpenSettings}>
          <Icon name="tune" />
        </button>
      </div>
    </header>
  );
}

function TaskPill({ tasks }: { tasks: TaskInfo[] }) {
  const { run } = useActions();
  const task = tasks[0];
  const percent = task.progress !== undefined ? Math.round(task.progress * 100) : null;
  return (
    <div className={`${styles.task} glass-flat`} role="status" aria-live="polite">
      <span className="cdp-spinner" aria-hidden="true" />
      <span className={styles.taskLabel}>
        {task.status === 'cancelling' ? '正在取消…' : task.label}
        {percent !== null && <span className="num"> {percent}%</span>}
        {tasks.length > 1 && <span className={styles.taskMore}> 另有 {tasks.length - 1} 项</span>}
      </span>
      {task.cancellable && task.status !== 'cancelling' && (
        <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label={`取消：${task.label}`} title="取消"
          onClick={() => run({ type: 'cancelTask', taskId: task.id }, { slot: 'library', key: 'cancel-' + task.id })}>
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

/** The record turns only while music plays and the window is visible (player updates stay out of TopBar). */
function TurningRecord() {
  const { visible } = useSurface();
  const player = usePlayer();
  return <VinylMark spinning={player.status === 'playing' && visible} size={MARK} />;
}
