import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CONTRACT_VERSION } from '../../contracts/player.ts';
import type { SettingsPatch, TaskInfo } from '../../contracts/player.ts';
import { Icon } from '../components/Icon.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import { onAccent } from '../lib/color.ts';
import { useSurface } from '../lib/surface.tsx';
import { memorialPlatesPatch, showMemorialPlates } from '../lib/memorial.ts';
import { audioVisualizationPatch, showAudioVisualization } from '../lib/stageViz.ts';
import { THEME_LABEL, themePatch } from '../lib/theme.ts';
import type { ThemeName } from '../lib/theme.ts';
import { Sheet } from './Sheet.tsx';
import styles from './SettingsSheet.module.css';

/** Argentine blue first (the user's base colour); the rest are tuned to sit beside it on glass. */
const ACCENTS = [
  { hex: '#6CACE4', name: '阿根廷蓝' }, { hex: '#2F80ED', name: '晴空' }, { hex: '#3DB5A6', name: '青碧' },
  { hex: '#9A8CF0', name: '藤紫' }, { hex: '#EE8BB0', name: '樱色' }, { hex: '#F0A35E', name: '夕橙' },
];
const THEMES: ThemeName[] = ['light', 'blue', 'charcoal'];

export function SettingsSheet({ onClose, focus, tasks = [] }: {
  onClose(): void;
  /** 'player': opened from a music video that would not launch; focus starts at the PotPlayer row. */
  focus?: 'player';
  tasks?: TaskInfo[];
}) {
  const { settings, host, online, theme: current } = useSurface();
  const { run, isPending } = useActions();
  const save = (patch: SettingsPatch) => run({ type: 'updateSettings', patch }, { slot: 'settings', key: 'settings' });
  const custom = !ACCENTS.some(a => a.hex.toLowerCase() === settings.accentColor.toLowerCase());

  return (
    <Sheet title="设置" onClose={onClose}>
      <Group title="外观">
        <Row label="主题">
          <div className={styles.themes} role="group" aria-label="主题">
            {THEMES.map(theme => (
              <button key={theme} type="button" className={styles.theme} data-theme-swatch={theme} aria-pressed={current === theme}
                onClick={() => { if (current !== theme) void save(themePatch(theme)); }}>
                <span className={styles.themePreview} aria-hidden="true"><i /><i /><i /></span>
                {THEME_LABEL[theme]}
              </button>
            ))}
          </div>
        </Row>
        <Row label="强调色">
          <div className={styles.accents} role="group" aria-label="强调色">
            {ACCENTS.map(accent => (
              <button key={accent.hex} type="button" className={styles.swatch} style={{ background: accent.hex, color: onAccent(accent.hex) }}
                aria-label={`强调色：${accent.name}`} title={accent.name} aria-pressed={settings.accentColor.toLowerCase() === accent.hex.toLowerCase()}
                onClick={() => save({ accentColor: accent.hex })}>
                <Icon name="check" size={14} />
              </button>
            ))}
            <label className={styles.custom} title="自定义颜色" data-active={custom ? 'true' : 'false'}>
              <input type="color" value={settings.accentColor.toLowerCase()} aria-label="自定义强调色"
                onChange={event => save({ accentColor: event.target.value.toUpperCase() })} />
              <Icon name="plus" size={14} />
            </label>
          </div>
        </Row>
        <SliderRow label="玻璃质感" min={0} max={1} step={0.05} value={settings.glassIntensity}
          format={v => (v === 0 ? '实色' : `${Math.round(v * 100)}%`)}
          hint={!host.transparencyAllowed ? '系统关闭了透明效果，界面使用实色。' : undefined}
          onCommit={v => save({ glassIntensity: v })} />
        <Row label="动效">
          <div className="cdp-seg" role="group" aria-label="动效">
            {([['system', '跟随系统'], ['reduced', '减少'], ['full', '完整']] as const).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={settings.motion === value} onClick={() => save({ motion: value })}>{label}</button>
            ))}
          </div>
        </Row>
        <SwitchRow label="正在播放时显示光盘" checked={settings.showDiscAnimation} hint="封面旁露出一张缓慢转动的光盘，暂停时停下。"
          onChange={v => save({ showDiscAnimation: v })} />
        <SwitchRow label="纪念铭牌" checked={showMemorialPlates(settings)} hint="在收藏首屏和纯音乐的歌词区显示 Codex 与 Claude 的纪念铭牌。"
          onChange={v => save(memorialPlatesPatch(v))} />
        <SwitchRow label="主舞台音乐图案" checked={showAudioVisualization(settings)}
          hint="收藏首屏随播放的声音起伏的点阵与连线。关闭后只停掉这一处，星轨与氛围灯保留。"
          onChange={v => save(audioVisualizationPatch(v))} />
      </Group>

      <Group title="文字">
        <SliderRow label="界面字号" min={0.85} max={1.3} step={0.05} value={settings.fontScale}
          format={v => `${Math.round(v * 100)}%`} onCommit={v => save({ fontScale: v })} />
        <SliderRow label="歌词字号" min={0.8} max={1.5} step={0.05} value={settings.lyricsScale}
          format={v => `${Math.round(v * 100)}%`} onCommit={v => save({ lyricsScale: v })} />
      </Group>

      <Group title="歌词">
        <Row label="默认显示">
          <div className="cdp-seg" role="group" aria-label="默认歌词显示">
            <button type="button" aria-pressed={settings.lyricsMode === 'original'} onClick={() => save({ lyricsMode: 'original' })}>只看原文</button>
            <button type="button" aria-pressed={settings.lyricsMode === 'bilingual'} onClick={() => save({ lyricsMode: 'bilingual' })}>原文和中文</button>
          </div>
        </Row>
      </Group>

      <Group title="迷你模式">
        <SwitchRow label="总在最前" checked={settings.miniAlwaysOnTop} hint="普通置顶窗口不一定能盖住独占全屏的游戏。"
          onChange={v => save({ miniAlwaysOnTop: v })} />
        <SwitchRow label="显示当前歌词" checked={settings.miniShowLyrics} hint="只对同步歌词显示一行，窗口会稍微变高。"
          onChange={v => save({ miniShowLyrics: v })} />
      </Group>

      <PlayerGroup tasks={tasks} focus={focus === 'player'} />

      <Group title="资料库">
        <Row label="音乐文件夹">
          <div className={styles.libraryActions}>
            <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online}
              onClick={() => run({ type: 'rescanLibrary' }, { slot: 'settings', key: 'rescan' })}>
              {isPending('rescan') ? <span className="cdp-spinner" /> : <Icon name="refresh" size={17} />} 重新扫描
            </button>
            <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online}
              onClick={() => run({ type: 'importFolder' }, { slot: 'settings', key: 'import-settings' })}>
              <Icon name="folder" size={17} /> 添加文件夹…
            </button>
          </div>
        </Row>
      </Group>
      <InlineError slot="settings" />
      {/* The interface version comes from the shared contract, so it cannot go stale. */}
      <p className={styles.about}>CD 播放器 · 接口 <span className="num">{CONTRACT_VERSION}</span></p>
    </Sheet>
  );
}

/**
 * MV round: the external player for linked music videos. The core only says whether a PotPlayer
 * location is on record (not that it was just checked), so the row says exactly that. Finding and
 * choosing are background tasks (started → done / cancelled / failed); a cancelled choice changes
 * nothing and says nothing, a failure arrives as the core's notice.
 */
function PlayerGroup({ tasks, focus }: { tasks: TaskInfo[]; focus: boolean }) {
  const { settings, online } = useSurface();
  const { run, isPending } = useActions();
  const configured = !!settings.potPlayerConfigured;
  const [pending, setPending] = useState<{ taskId: string | null; kind: 'detect' | 'pick'; was: boolean } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  useEffect(() => {
    if (!focus) return;
    // After the sheet's own focus (its effect runs after this one), so closing still returns to the opener.
    const frame = requestAnimationFrame(() => {
      first.current?.focus();
      first.current?.scrollIntoView?.({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  const start = async (kind: 'detect' | 'pick') => {
    setSaid(null);
    const was = configured;
    const result = await run(kind === 'detect' ? { type: 'detectPotPlayer' } : { type: 'pickPotPlayer' }, { slot: 'player', key: 'player-' + kind });
    if (result.ok && result.status !== 'cancelled') setPending({ taskId: result.status === 'started' ? result.taskId : null, kind, was });
  };
  const running = pending?.taskId ? tasks.find(t => t.id === pending.taskId) ?? null : null;
  useEffect(() => {
    if (!pending || running) return;
    // Answered at once (applied), or a task that ended with a player now on record that was not before.
    if (!pending.taskId || (!pending.was && configured)) setSaid(pending.kind === 'detect' ? '已找到 PotPlayer。' : '已设置 PotPlayer。');
    setPending(null);
  }, [pending, running, configured]);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), 6000);
    return () => clearTimeout(timer);
  }, [said]);
  const spinning = (kind: 'detect' | 'pick') => isPending('player-' + kind) || (!!running && pending?.kind === kind);
  const busy = !!running || isPending('player-detect') || isPending('player-pick');
  return (
    <Group title="MV 播放">
      <div className={`${styles.row} ${styles.playerRow}`}>
        <div className={styles.rowLabel}>
          <span className={styles.playerName}>PotPlayer
            <span className={`cdp-badge ${configured ? 'cdp-badge--accent' : ''}`}>{configured ? '已指定' : '未指定'}</span>
          </span>
          <small id={hintId}>{configured
            ? '已记录播放器位置，播放专辑里的 MV 时交给它打开。'
            : '还没有记录位置。第一次播放 MV 时会在常见安装位置自动查找，也可以现在指定。'}</small>
        </div>
        <div className={styles.libraryActions}>
          <button ref={first} type="button" className="cdp-btn cdp-btn--quiet" disabled={!online || busy} aria-describedby={hintId}
            onClick={() => void start('detect')}>
            {spinning('detect') ? <span className="cdp-spinner" /> : <Icon name="search" size={17} />} 自动查找
          </button>
          <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online || busy} aria-describedby={hintId}
            onClick={() => void start('pick')}>
            {spinning('pick') ? <span className="cdp-spinner" /> : <Icon name="folder" size={17} />} 选择程序…
          </button>
        </div>
      </div>
      {(running || said) && (
        <p className={styles.playerStatus} role="status">
          {running ? <>
            <span>{running.status === 'cancelling' ? '正在取消…'
              : pending?.kind === 'detect' ? '正在常见安装位置查找 PotPlayer…' : '请在弹出的窗口中选择 PotPlayer 程序（PotPlayerMini64.exe 等）。'}</span>
            {running.cancellable && running.status !== 'cancelling' && (
              <button type="button" className="cdp-btn cdp-btn--text"
                onClick={() => void run({ type: 'cancelTask', taskId: running.id }, { slot: 'player', key: 'cancel-' + running.id })}>取消</button>
            )}
          </> : <><Icon name="check" size={15} /><span>{said}</span></>}
        </p>
      )}
      {/* A failure (not found, not PotPlayer, busy) is said here, next to the buttons. */}
      <InlineError slot="player" className={styles.playerError} />
    </Group>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.group} aria-label={title}>
      <h3 className={styles.groupTitle}>{title}</h3>
      <div className={styles.groupBody}>{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}><span>{label}</span>{hint && <small>{hint}</small>}</div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}><span>{label}</span>{hint && <small>{hint}</small>}</div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className={styles.switch} onClick={() => onChange(!checked)}>
        <i />
      </button>
    </div>
  );
}

/** Previews locally while dragging; commits once on release (and after keyboard steps). */
function SliderRow({ label, hint, min, max, step, value, format, onCommit }: {
  label: string; hint?: string; min: number; max: number; step: number; value: number;
  format(v: number): string; onCommit(v: number): Promise<unknown>;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const shown = local ?? value;
  const commit = (v: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void onCommit(v).finally(() => setLocal(current => (current === v ? null : current))); }, 120);
  };
  return (
    <Row label={label} hint={hint}>
      <div className={styles.slider}>
        <input className="cdp-range" type="range" min={min} max={max} step={step} value={shown} aria-label={label}
          aria-valuetext={format(shown)} style={{ ['--fill' as string]: String((shown - min) / (max - min)) }}
          onChange={event => { const v = Number(event.target.value); setLocal(v); commit(v); }} />
        <span className={`${styles.sliderValue} num`}>{format(shown)}</span>
      </div>
    </Row>
  );
}

