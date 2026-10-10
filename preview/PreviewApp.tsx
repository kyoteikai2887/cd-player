import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ActionResult, PlayerBridge, UIAction } from '../src/contracts/player.ts';
import { createMockSession } from '../src/mock/createMockBridge.ts';
import type { MockOptions } from '../src/mock/createMockBridge.ts';
import { candidateRecords, manyRecords, multiSourceRecords } from './lyricsCandidates.ts';
import type { DemoScenario } from '../src/mock/fixtures.ts';
import { PlayerUI } from '../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../src/ui/lib/env.ts';
import { resolveTheme, THEME_LABEL, themePatch } from '../src/ui/lib/theme.ts';
import type { ThemeName } from '../src/ui/lib/theme.ts';
import { MEMORIAL_ACCENT, SCENARIOS, withTheme } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';

/**
 * Preview (Claude, R1 → R2). Two pages:
 *  #/live           interactive demo on Codex's mock session (main + mini, shared core)
 *                   ?scenario=missing&lyrics=five|sources|many|none|fail|slow picks the lyric candidate search (R2.3)
 *  #/states/<id>    static state matrix rendered from plain snapshots and a logging action stub
 * ?shot=<id>[&theme=light|blue|charcoal][&w=1920&h=1080] renders one static frame at 1:1 without chrome (screenshots).
 */
const THEMES: ThemeName[] = ['light', 'blue', 'charcoal'];
const isTheme = (value: string | null): value is ThemeName => !!value && (THEMES as string[]).includes(value);
function useHash() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function PreviewApp() {
  const params = new URLSearchParams(location.search);
  const shot = params.get('shot');
  const hash = useHash();
  if (shot) {
    const scenario = SCENARIOS.find(s => s.id === shot);
    const theme = params.get('theme');
    // &accent=RRGGBB: the same scenario with another accent (the settings sheet's colour), for checks.
    const accent = /^[0-9a-f]{6}$/i.test(params.get('accent') ?? '') ? '#' + params.get('accent')!.toUpperCase() : null;
    // &w=1920&h=1080: the same scenario at another window size in CSS px (V1.1, wide screens).
    const size = (key: 'w' | 'h') => { const n = Number(params.get(key)); return Number.isFinite(n) && n >= 320 && n <= 4000 ? Math.round(n) : null; };
    const sized = scenario && (size('w') || size('h')) ? { ...scenario, width: size('w') ?? scenario.width, height: size('h') ?? scenario.height } : scenario;
    return sized ? <ShotFrame scenario={sized} theme={isTheme(theme) ? theme : null} accent={accent} /> : <p>未知场景 {shot}</p>;
  }
  const page = hash.startsWith('#/states') ? 'states' : 'live';
  return (
    <div className="pv" data-page={page}>
      <header className="pv-bar">
        <span className="pv-brand">CD 播放器 · R2.3 界面预览</span>
        <nav className="pv-tabs">
          <a href="#/live" aria-current={page === 'live' ? 'page' : undefined}>交互演示</a>
          <a href="#/states" aria-current={page === 'states' ? 'page' : undefined}>状态一览</a>
        </nav>
        {page === 'live' && <LiveThemeSwitch />}
        <span className="pv-note">全部为虚构演示数据 · 模拟进度，不输出声音</span>
      </header>
      {page === 'live' ? <Live /> : <States hash={hash} />}
    </div>
  );
}

// ── Interactive demo ──────────────────────────────────────────────
/**
 * ?lyrics=five|sources|many|none|fail|slow picks what the demo's lyric candidate search returns (R2.3;
 * "sources" is one version per source with translations, as in core.19);
 * without it the DemoBridge's own two candidates are used.
 */
function liveLyricSearch(): MockOptions['searchLyrics'] {
  const mode = new URLSearchParams(location.search).get('lyrics');
  if (!mode) return undefined;
  return (track, signal) => new Promise((resolve, reject) => {
    const album = liveBridges?.main.getSnapshot().library.albums.find(a => a.id === track.albumId);
    const timer = setTimeout(() => {
      if (mode === 'fail') reject(new Error('demo failure'));
      else resolve(mode === 'none' || !album ? [] : mode === 'many' ? manyRecords(track, album)
        : mode === 'sources' ? multiSourceRecords(track, album) : candidateRecords(track, album));
    }, mode === 'slow' ? 6000 : 900);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });
}
const liveScenario = (new URLSearchParams(location.search).get('scenario') ?? 'default') as DemoScenario;
let liveSession: ReturnType<typeof createMockSession> | null = null;
let liveBridges: { main: PlayerBridge; mini: PlayerBridge } | null = null;
function getLive() {
  if (!liveSession) {
    liveSession = createMockSession({ scenario: liveScenario, searchLyrics: liveLyricSearch() });
    liveBridges = { main: liveSession.connect('main'), mini: liveSession.connect('mini') };
    window.addEventListener('pagehide', () => liveSession?.destroy(), { once: true });
  }
  return liveBridges!;
}

/** Same action the settings sheet sends; shown in the preview bar so themes are one click apart. */
function LiveThemeSwitch() {
  const bridges = getLive();
  const main = useSyncExternalStore(bridges.main.subscribe, bridges.main.getSnapshot);
  const current = resolveTheme(main.settings);
  return (
    <div className="pv-themes" role="group" aria-label="主题">
      {THEMES.map(theme => (
        <button key={theme} type="button" aria-pressed={current === theme && main.settings.accentColor.toUpperCase() !== MEMORIAL_ACCENT}
          onClick={() => void bridges.main.dispatch({ type: 'updateSettings', patch: themePatch(theme) })}>{THEME_LABEL[theme]}</button>
      ))}
      {/* The memorial look: the charcoal theme with Claude's orange, as the settings sheet would set them. */}
      <button type="button" aria-pressed={current === 'charcoal' && main.settings.accentColor.toUpperCase() === MEMORIAL_ACCENT}
        onClick={() => void bridges.main.dispatch({ type: 'updateSettings', patch: { ...themePatch('charcoal'), accentColor: MEMORIAL_ACCENT } })}>黑橙</button>
    </div>
  );
}

function LiveSurface({ bridge, surface }: { bridge: PlayerBridge; surface: 'main' | 'mini' }) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  return (
    <div className="pv-live-window" hidden={!snapshot.host.surfaceVisible} data-surface={surface}>
      <PlayerUI snapshot={snapshot} surface={surface} onAction={bridge.dispatch} />
    </div>
  );
}

function Live() {
  const bridges = getLive();
  const main = useSyncExternalStore(bridges.main.subscribe, bridges.main.getSnapshot);
  const mini = useSyncExternalStore(bridges.mini.subscribe, bridges.mini.getSnapshot);
  const trayed = !main.host.surfaceVisible && !mini.host.surfaceVisible;
  return (
    <div className="pv-live">
      <LiveSurface bridge={bridges.main} surface="main" />
      <LiveSurface bridge={bridges.mini} surface="mini" />
      {trayed && (
        <div className="pv-tray">
          <p>窗口已收起到托盘，播放继续。</p>
          <button type="button" onClick={() => bridges.main.dispatch({ type: 'setWindowMode', mode: 'full' })}>从托盘打开</button>
        </div>
      )}
    </div>
  );
}

// ── Static state matrix ───────────────────────────────────────────
type StubResult = 'applied' | 'cancelled' | 'conflict' | 'unavailable';
const RESULTS: Record<StubResult, ActionResult> = {
  applied: { ok: true, status: 'applied' },
  cancelled: { ok: true, status: 'cancelled' },
  conflict: { ok: false, code: 'conflict', message: '资料已变化，请刷新后重试。' },
  unavailable: { ok: false, code: 'unavailable', message: '播放核心未及时响应，请重试。' },
};

function useStub(result: StubResult, log: (line: string) => void) {
  return useMemo(() => async (action: UIAction): Promise<ActionResult> => {
    log(action.type + ' ' + JSON.stringify(action).slice(0, 120));
    await new Promise(resolve => setTimeout(resolve, 260));
    return RESULTS[result];
  }, [result, log]);
}

function Frame({ scenario, theme, accent = null, onAction }: {
  scenario: Scenario; theme: ThemeName | null; accent?: string | null; onAction: (a: UIAction) => Promise<ActionResult>;
}) {
  const snapshot = useMemo(() => {
    const built = theme ? withTheme(scenario.build(), theme) : scenario.build();
    return accent ? { ...built, settings: { ...built.settings, accentColor: accent } } : built;
  }, [scenario, theme, accent]);
  return (
    <div className="pv-frame" data-desktop={scenario.desktop ? 'true' : 'false'} data-theme={resolveTheme(snapshot.settings)}
      style={{ width: scenario.width, height: scenario.height, ['--cdp-viewport-h' as string]: scenario.height + 'px' }}>
      <UIBootContext.Provider value={scenario.boot ?? {}}>
        <PlayerUI key={scenario.id} snapshot={snapshot} surface={scenario.surface} onAction={onAction} />
      </UIBootContext.Provider>
    </div>
  );
}

function ShotFrame({ scenario, theme, accent }: { scenario: Scenario; theme: ThemeName | null; accent: string | null }) {
  const onAction = useStub('applied', () => undefined);
  const resolved = theme ?? resolveTheme(scenario.build().settings);
  return (
    <div className="pv-shot" data-desktop={scenario.desktop ? 'true' : 'false'} data-theme={resolved}>
      <Frame scenario={scenario} theme={theme} accent={accent} onAction={onAction} />
    </div>
  );
}

function States({ hash }: { hash: string }) {
  const id = hash.replace(/^#\/states\/?/, '') || SCENARIOS[0].id;
  const index = Math.max(0, SCENARIOS.findIndex(s => s.id === id));
  const scenario = SCENARIOS[index];
  const [result, setResult] = useState<StubResult>('applied');
  const [themeChoice, setThemeChoice] = useState<ThemeName | 'scenario'>('scenario');
  const theme = themeChoice === 'scenario' ? null : themeChoice;
  const resolved = theme ?? resolveTheme(scenario.build().settings);
  const [log, setLog] = useState<string[]>([]);
  const append = useMemo(() => (line: string) => setLog(l => [line, ...l].slice(0, 6)), []);
  const onAction = useStub(result, append);
  const [stage, setStage] = useState({ w: 1000, h: 700 });
  useEffect(() => {
    const el = document.querySelector('.pv-stage');
    if (!el || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      setStage({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = SCENARIOS[(index + (e.key === 'ArrowDown' ? 1 : -1) + SCENARIOS.length) % SCENARIOS.length];
        location.hash = '#/states/' + next.id;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index]);
  const pad = scenario.desktop ? 56 : 0;
  const outerW = scenario.width + pad * 2, outerH = scenario.height + pad * 2;
  const scale = Math.min(scenario.desktop ? 2 : 1, (stage.w - 48) / outerW, (stage.h - 48) / outerH);
  const groups = [...new Set(SCENARIOS.map(s => s.group))];
  return (
    <div className="pv-states">
      <aside className="pv-list" aria-label="场景">
        {groups.map(group => (
          <section key={group}>
            <h2>{group}</h2>
            <ul>
              {SCENARIOS.filter(s => s.group === group).map(s => (
                <li key={s.id}><a href={'#/states/' + s.id} aria-current={s.id === scenario.id ? 'true' : undefined}>{s.title}</a></li>
              ))}
            </ul>
          </section>
        ))}
      </aside>
      <main className="pv-main">
        <div className="pv-caption">
          <div>
            <h1>{scenario.title}</h1>
            <p>{scenario.note ?? '静态快照；按钮会记录动作并按右侧设置返回结果。'} <span className="pv-size">{scenario.width}×{scenario.height}</span></p>
          </div>
          <label className="pv-result">主题
            <select value={themeChoice} onChange={e => setThemeChoice(e.target.value as ThemeName | 'scenario')}>
              <option value="scenario">按场景</option>
              {THEMES.map(t => <option key={t} value={t}>{THEME_LABEL[t]}</option>)}
            </select>
          </label>
          <label className="pv-result">动作结果
            <select value={result} onChange={e => setResult(e.target.value as StubResult)}>
              <option value="applied">applied</option><option value="cancelled">cancelled</option>
              <option value="conflict">conflict</option><option value="unavailable">unavailable</option>
            </select>
          </label>
        </div>
        <div className="pv-stage">
          <div className="pv-scaled" data-desktop={scenario.desktop ? 'true' : 'false'} data-theme={resolved} style={{ width: outerW * scale, height: outerH * scale }}>
            <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0', padding: pad }}>
              <Frame key={scenario.id + result + resolved} scenario={scenario} theme={theme} onAction={onAction} />
            </div>
          </div>
        </div>
        <ol className="pv-log" aria-label="动作记录">{log.map((l, i) => <li key={i}>{l}</li>)}</ol>
      </main>
    </div>
  );
}
