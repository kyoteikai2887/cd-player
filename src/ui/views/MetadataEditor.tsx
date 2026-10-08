import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { Album, AlbumEditableField, TaskInfo, Track, TrackEditableField, VersionKind } from '../../contracts/player.ts';
import { Cover } from '../components/Cover.tsx';
import { Icon } from '../components/Icon.tsx';
import { useActions } from '../lib/actions.tsx';
import { formatClock } from '../lib/clock.ts';
import { useDirtyFlag } from '../lib/drafts.tsx';
import { useBoot } from '../lib/env.ts';
import type { MetadataEditorBoot } from '../lib/env.ts';
import {
  ALBUM_FIELD_LABEL, TRACK_FIELD_LABEL, VERSION_KINDS, albumForm, albumIssues, albumValues, compareFields, creditFrom, diffPatch,
  discOf, discUnion, patchIsValid, pickAlbumFields, pickTrackFields, sameFields, trackForm, trackIssues, trackValues,
} from '../lib/metadataDraft.ts';
import type { AlbumForm, FieldIssue, FieldCompareRow, TrackForm } from '../lib/metadataDraft.ts';
import { useSurface } from '../lib/surface.tsx';
import { langHint, versionBadge } from '../lib/text.ts';
import { Banner, BannerDetail, Banners, EditorFrame, EditorStatus } from './editor/EditorFrame.tsx';
import { NameList, languageOptions } from './editor/fields.tsx';
import fieldStyles from './editor/fields.module.css';
import styles from './MetadataEditor.module.css';

/**
 * Album and track metadata editor (Claude, R2).
 *
 * One draft per entity (the album, each track), each with the revision it started from. Saving
 * sends only the fields that changed, entity by entity, with that revision. Saved values come back
 * through the library snapshot: a draft that matches them is settled; a draft facing a newer
 * version that changed fields is kept and the user chooses (compare, load latest, overwrite).
 * Changes that touch no editable field (a new cover) are adopted quietly. The cover itself is
 * chosen through the bridge and saved at once; it is not part of the draft.
 */
interface Draft<F, E> { form: F; base: E }
interface Drafts { album: Draft<AlbumForm, Album>; tracks: Record<string, Draft<TrackForm, Track>> }
/** An overwrite is confirmed against the saved version the user was looking at. */
type Confirm = { id: string; kind: 'loadLatest' } | { id: string; kind: 'overwrite'; target?: Album | Track };
const ALBUM = 'album';

export function MetadataEditor({ albumId, focusTrackId, tasks = [], onClose }: {
  albumId: string; focusTrackId?: string | null; tasks?: TaskInfo[]; onClose(): void;
}) {
  const { index, online } = useSurface();
  const { run, clear } = useActions();
  const seed = useBoot().metadataEditor;
  const latestAlbum = index.albumsById.get(albumId) ?? null;
  const lastAlbum = useRef<Album | null>(latestAlbum);
  if (latestAlbum) lastAlbum.current = latestAlbum;

  const [drafts, setDrafts] = useState<Drafts>(() => initialDrafts(lastAlbum.current!, index.tracksById, seed));
  const [selected, setSelected] = useState<string>(() => seed?.select ?? focusTrackId ?? ALBUM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<Confirm | null>(seed?.confirm ?? null);
  const [comparing, setComparing] = useState<string | null>(seed?.compare ?? null);
  const [closing, setClosing] = useState(!!seed?.closing);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const album = latestAlbum ?? drafts.album.base;
  const gone = !latestAlbum;
  const latestTrack = useCallback((id: string) => index.tracksById.get(id) ?? null, [index]);

  // ── Derived state per entity ───────────────────────────────────────────────
  const model = useMemo(() => buildModel(drafts, latestAlbum, latestTrack), [drafts, latestAlbum, latestTrack]);
  const anyDirty = model.dirtyIds.length > 0;
  useDirtyFlag('metadata-editor', anyDirty);
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const modelRef = useRef(model); modelRef.current = model;

  // Adopt newer saved versions wherever that loses nothing (see buildModel for the rules).
  useEffect(() => {
    setDrafts(prev => {
      const m = buildModel(prev, latestAlbum, latestTrack);
      let next = prev;
      const albumState = m.entities.get(ALBUM)!;
      if (latestAlbum && albumState.adopt) next = { ...next, album: albumState.adopt === 'reset' ? { form: albumForm(latestAlbum), base: latestAlbum } : { ...next.album, base: latestAlbum } };
      for (const id of Object.keys(prev.tracks)) {
        const state = m.entities.get(id), latest = latestTrack(id);
        if (!state?.adopt || !latest) continue;
        next = { ...next, tracks: { ...next.tracks, [id]: state.adopt === 'reset' ? { form: trackForm(latest), base: latest } : { ...next.tracks[id], base: latest } } };
      }
      return next;
    });
  }, [latestAlbum, latestTrack]);

  // ── Editing ────────────────────────────────────────────────────────────────
  const setAlbum = <K extends keyof AlbumForm>(field: K, value: AlbumForm[K]) =>
    setDrafts(prev => ({ ...prev, album: { ...prev.album, form: { ...prev.album.form, [field]: value } } }));
  const setTrack = <K extends keyof TrackForm>(id: string, field: K, value: TrackForm[K]) =>
    setDrafts(prev => ({ ...prev, tracks: { ...prev.tracks, [id]: { ...prev.tracks[id], form: { ...prev.tracks[id].form, [field]: value } } } }));
  const revert = (id: string) => setDrafts(prev => id === ALBUM
    ? { ...prev, album: { ...prev.album, form: albumForm(prev.album.base) } }
    : { ...prev, tracks: { ...prev.tracks, [id]: { ...prev.tracks[id], form: trackForm(prev.tracks[id].base) } } });
  const loadLatest = (id: string) => setDrafts(prev => {
    if (id === ALBUM) return latestAlbum ? { ...prev, album: { form: albumForm(latestAlbum), base: latestAlbum } } : prev;
    const latest = latestTrack(id);
    return latest ? { ...prev, tracks: { ...prev.tracks, [id]: { form: trackForm(latest), base: latest } } } : prev;
  });

  // ── Saving ─────────────────────────────────────────────────────────────────
  const savingRef = useRef(false);
  const send = useCallback(async (id: string, patch: object, revision: number) => {
    if (!Object.keys(patch).length) return true;
    if (!patchIsValid(patch, id === ALBUM)) { setErrors(e => ({ ...e, [id]: '有字段格式不正确，没有保存。' })); return false; }
    const result = await run(id === ALBUM
      ? { type: 'updateAlbum', albumId, baseRevision: revision, patch }
      : { type: 'updateTrack', trackId: id, baseRevision: revision, patch }, { slot: 'metaEdit', key: 'meta-save' });
    clear('metaEdit');   // shown per entity below, not as a second message
    if (result.ok) { setErrors(e => { const { [id]: _drop, ...rest } = e; return rest; }); return true; }
    // A conflict is explained by the bar on that entry once the newer version is in the snapshot.
    setErrors(e => ({ ...e, [id]: result.code === 'conflict' ? '资料已在别处更新；你的修改还在，请比较后再决定。' : result.message }));
    return false;
  }, [run, clear, albumId]);

  const saveAll = useCallback(async () => {
    if (savingRef.current) return false;
    const m = modelRef.current;
    const blocked = m.dirtyIds.find(id => m.entities.get(id)!.issues.some(i => i.blocking));
    if (blocked) { setSelected(blocked); setNote('有必填或格式不对的地方，先改好再保存。'); return false; }
    savingRef.current = true; setSaving(true); setNote(null);
    let ok = true, skipped = 0;
    try {
      for (const id of m.dirtyIds) {
        if (m.entities.get(id)!.conflict) { skipped++; ok = false; continue; }
        const state = m.entities.get(id)!;
        if (!(await send(id, diffPatch(state.values as object, state.baseFields as object), state.baseRevision!))) ok = false;
      }
    } finally { savingRef.current = false; setSaving(false); }
    if (skipped) setNote(`有 ${skipped} 项与最新版本冲突，没有保存；请逐项比较后决定。`);
    if (ok) setSavedAt(Date.now());
    return ok;
  }, [send]);

  /**
   * "Overwrite with my changes": the fields changed in this draft go on top of the version the
   * user confirmed against; everything else keeps that version's values. The draft is rebased onto
   * it first, so if yet another version lands meanwhile the next conflict compares against it.
   */
  const overwrite = async (id: string, target: Album | Track | undefined) => {
    setConfirm(null);
    const state = modelRef.current.entities.get(id);
    if (!state || !target) return;
    const base = state.baseFields as Record<string, unknown>, values = state.values as Record<string, unknown>;
    const mine = Object.keys(values).filter(key => !sameFields(values[key], base[key]));
    const targetFields = (id === ALBUM ? pickAlbumFields(target as Album) : pickTrackFields(target as Track)) as unknown as Record<string, unknown>;
    const merged = { ...targetFields, ...Object.fromEntries(mine.map(key => [key, values[key]])) };
    setDrafts(prev => id === ALBUM
      ? { ...prev, album: { form: { ...albumForm({ ...(target as Album), ...merged }), discTitles: prev.album.form.discTitles }, base: target as Album } }
      : { ...prev, tracks: { ...prev.tracks, [id]: { form: trackForm({ ...(target as Track), ...merged }), base: target as Track } } });
    setComparing(null);
    await send(id, diffPatch(merged, targetFields), target.revision);
  };
  const latestEntity = (id: string): Album | Track | undefined => (id === ALBUM ? latestAlbum : latestTrack(id)) ?? undefined;
  const pickCover = () => {
    if (!latestAlbum) return;
    void run({ type: 'pickCoverImage', albumId, baseRevision: latestAlbum.revision }, { slot: 'metaEdit', key: 'meta-cover' }).then(result => {
      clear('metaEdit');
      if (!result.ok) setErrors(e => ({ ...e, cover: result.message }));
      else setErrors(e => { const { cover: _drop, ...rest } = e; return rest; });
    });
  };

  const requestClose = () => { if (modelRef.current.dirtyIds.length) setClosing(true); else onClose(); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void saveAll(); return; }
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (confirm) setConfirm(null);
      else if (comparing) setComparing(null);
      else if (closing) setClosing(false);
      else requestClose();
      return;
    }
    if (event.key !== ' ' || /^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement).tagName)) event.stopPropagation();
  };

  // Choosing a cover runs as a task on the album (the native picker, then the copy).
  const coverBusy = tasks.some(t => t.albumId === albumId && (t.status === 'queued' || t.status === 'running'));
  const sel = model.entities.get(selected) ? selected : ALBUM;
  const selState = model.entities.get(sel)!;
  const savedRecently = savedAt > 0 && !anyDirty && Date.now() - savedAt < 4000;
  const conflicts = model.conflictIds.length;
  const statusText = saving ? '正在保存…' : conflicts ? `${conflicts} 项与最新版本冲突` : anyDirty ? `${model.dirtyIds.length} 项未保存` : savedRecently ? '已保存' : '已是最新';
  const lang = langHint(album.title, null, album.language);

  return (
    <EditorFrame album={album} kicker="资料编辑" meta={`${album.trackIds.length} 首`} heading={album.title} headingLang={lang}
      sub={album.albumArtistCredit} subLang={langHint(album.albumArtistCredit, null, album.language)}
      status={<EditorStatus tone={conflicts ? 'warn' : anyDirty ? 'dirty' : 'clean'}>{statusText}</EditorStatus>}
      closeLabel="关闭资料编辑" onClose={requestClose} onEscape={requestClose} onKeyDown={onKeyDown}>
      {gone && (
        <Banners>
          <Banner tone="warn" icon="warning" text="这张专辑已经不在资料库里了（可能在重新扫描时被移除）。修改无法保存，关闭即可。" />
        </Banners>
      )}
      <div className={styles.body}>
        <nav className={styles.rail} aria-label="要编辑的条目">
          <RailItem id={ALBUM} selected={sel === ALBUM} state={model.entities.get(ALBUM)!} onSelect={setSelected}
            art={<Cover albumId={album.id} title={album.title} cover={album.cover} className={styles.railArt} showTitleOnPlaceholder={false} />}
            title="专辑资料" detail={album.releaseYear ? String(album.releaseYear) : undefined} />
          {model.discs.map(disc => (
            <div key={disc.number} className={styles.railGroup} role="group" aria-label={model.discs.length > 1 ? `第 ${disc.number} 碟` : '曲目'}>
              {model.discs.length > 1 && <p className={styles.railDisc} aria-hidden="true">Disc {disc.number}{disc.title ? ` · ${disc.title}` : ''}</p>}
              {disc.trackIds.map(id => {
                const draft = drafts.tracks[id];
                if (!draft) return null;
                const badge = versionBadge(draft.form.versionKind, draft.form.versionLabel || null);
                return (
                  <RailItem key={id} id={id} selected={sel === id} state={model.entities.get(id)!} onSelect={setSelected}
                    art={<span className={`${styles.railNo} num`}>{draft.base.trackNumber}</span>}
                    title={draft.form.title || draft.base.title} lang={langHint(draft.form.title, draft.form.language, album.language)} detail={badge ?? undefined} />
                );
              })}
            </div>
          ))}
        </nav>

        <section className={styles.pane} aria-label={sel === ALBUM ? '专辑资料' : `曲目：${drafts.tracks[sel]?.form.title ?? ''}`}>
          <Banners>
            {selState.conflict && (
              <Banner tone="warn" icon="warning"
                text={<>这一项在别处更新了（已保存第 <span className="num">{selState.latestRevision}</span> 版）。你的修改还在，没有被覆盖。</>}>
                {confirm?.id !== sel && <>
                  {comparing === sel
                    ? <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setComparing(null)}>返回编辑</button>
                    : <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setComparing(sel)}><Icon name="compare" size={16} /> 比较</button>}
                  <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setConfirm({ id: sel, kind: 'loadLatest' })}>载入最新…</button>
                  <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setConfirm({ id: sel, kind: 'overwrite', target: latestEntity(sel) })}>用我的修改覆盖…</button>
                </>}
              </Banner>
            )}
            {confirm?.id === sel && (
              <Banner tone="ask" icon="info" text={confirm.kind === 'loadLatest'
                ? '放弃这一项的修改，换成最新保存的资料？'
                : '用你的修改覆盖最新保存的资料？只会提交你改过、且和最新版本不同的字段。'}>
                <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setConfirm(null)}>取消</button>
                {confirm.kind === 'loadLatest'
                  ? <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => { loadLatest(sel); setConfirm(null); setComparing(null); }}>载入最新</button>
                  : <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || saving}
                    onClick={() => void overwrite(sel, confirm.target ?? latestEntity(sel))}>覆盖</button>}
              </Banner>
            )}
            {errors[sel] && !selState.conflict && (
              <Banner tone="warn" icon="warning" text={errors[sel]} onDismiss={() => setErrors(e => { const { [sel]: _drop, ...rest } = e; return rest; })} />
            )}
          </Banners>

          {comparing === sel && selState.conflict ? (
            <FieldCompare rows={selState.compare} revision={selState.latestRevision ?? 0} />
          ) : sel === ALBUM ? (
            <AlbumPane album={album} draft={drafts.album} discs={model.discs} issues={selState.issues} dirty={selState.dirty}
              set={setAlbum} onRevert={() => revert(ALBUM)} onPickCover={pickCover} coverBusy={coverBusy} coverError={errors.cover}
              online={online && !gone} />
          ) : (
            <TrackPane key={sel} draft={drafts.tracks[sel]} album={album} issues={selState.issues} dirty={selState.dirty}
              set={(field, value) => setTrack(sel, field, value)} onRevert={() => revert(sel)} />
          )}
        </section>
      </div>

      <footer className={styles.footer}>
        <p className={styles.footerNote} role="status">
          {note ?? (anyDirty ? <>未保存：{model.dirtyIds.map(id => id === ALBUM ? '专辑资料' : `“${drafts.tracks[id]?.form.title || drafts.tracks[id]?.base.title}”`).join('、')}</>
            : '修改只在保存后写入资料库；不会改动音乐文件里的标签。')}
        </p>
        <div className={styles.footerActions}>
          {closing ? (
            <div className={styles.closeAsk} role="alertdialog" aria-label="未保存的修改">
              <span>有未保存的修改。</span>
              <button type="button" className="cdp-btn cdp-btn--quiet" onClick={onClose}>放弃修改</button>
              <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setClosing(false)}>继续编辑</button>
              <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || saving || gone}
                onClick={async () => { if (await saveAll()) onClose(); else setClosing(false); }}>保存并关闭</button>
            </div>
          ) : (
            <>
              <button type="button" className="cdp-btn cdp-btn--quiet" onClick={requestClose}>{anyDirty ? '关闭' : '完成'}</button>
              <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || !anyDirty || saving || gone} onClick={() => void saveAll()}>
                {saving ? <span className="cdp-spinner" /> : <Icon name="check" size={16} />} 保存{model.dirtyIds.length > 1 ? `（${model.dirtyIds.length} 项）` : ''}
              </button>
            </>
          )}
        </div>
      </footer>
    </EditorFrame>
  );
}

// ── Model ────────────────────────────────────────────────────────────────────

interface EntityState {
  dirty: boolean;
  conflict: boolean;
  /** What the effect should do with a newer saved version: keep the form ('base') or take it ('reset'). */
  adopt: 'base' | 'reset' | null;
  issues: FieldIssue[];
  values: unknown;
  baseFields: unknown;
  baseRevision: number | null;
  latestFields: unknown | null;
  latestRevision: number | null;
  compare: FieldCompareRow[];
}
interface Model {
  entities: Map<string, EntityState>;
  dirtyIds: string[];
  conflictIds: string[];
  discs: { number: number; title?: string; trackIds: string[] }[];
}

function buildModel(drafts: Drafts, latestAlbum: Album | null, latestTrack: (id: string) => Track | null): Model {
  const entities = new Map<string, EntityState>();
  const trackDrafts = Object.entries(drafts.tracks);

  // Album
  {
    const { form, base } = drafts.album;
    const values = albumValues(form, discUnion(base.discs, []));
    const baseValues = albumValues(albumForm(base), discUnion(base.discs, []));
    const dirty = !sameFields(values, baseValues);
    const latest = latestAlbum;
    const moved = !!latest && latest.revision !== base.revision;
    const latestValues = latest ? albumValues(albumForm(latest), discUnion(latest.discs, [])) : null;
    const quiet = moved && sameFields(pickAlbumFields(latest!), pickAlbumFields(base));
    const settled = moved && dirty && !!latestValues && sameFields(latestValues, values);
    const adopt = !moved ? null : quiet || settled ? 'base' : !dirty ? 'reset' : null;
    entities.set(ALBUM, {
      dirty: dirty && !settled, conflict: moved && dirty && !quiet && !settled, adopt,
      issues: albumIssues(form), values, baseFields: pickAlbumFields(base), baseRevision: base.revision,
      latestFields: latest ? pickAlbumFields(latest) : null, latestRevision: latest?.revision ?? null,
      compare: latest ? compareFields(pickAlbumFields(base), pickAlbumFields(latest), values, ALBUM_FIELD_LABEL) : [],
    });
  }
  // Tracks
  const siblings = trackDrafts.map(([id, d]) => ({ id, disc: discOf(d.form) ?? -1, track: Number(d.form.trackNumber), title: d.form.title || d.base.title }));
  for (const [id, { form, base }] of trackDrafts) {
    const values = trackValues(form);
    const dirty = !sameFields(values, trackValues(trackForm(base)));
    const latest = latestTrack(id);
    const moved = !!latest && latest.revision !== base.revision;
    const quiet = moved && sameFields(pickTrackFields(latest!), pickTrackFields(base));
    const settled = moved && dirty && sameFields(pickTrackFields(latest!), values);
    const adopt = !moved ? null : quiet || settled ? 'base' : !dirty ? 'reset' : null;
    entities.set(id, {
      dirty: dirty && !settled, conflict: moved && dirty && !quiet && !settled, adopt,
      issues: trackIssues(form, siblings, id), values, baseFields: pickTrackFields(base), baseRevision: base.revision,
      latestFields: latest ? pickTrackFields(latest) : null, latestRevision: latest?.revision ?? null,
      compare: latest ? compareFields(pickTrackFields(base), pickTrackFields(latest), values, TRACK_FIELD_LABEL) : [],
    });
  }

  // Rail groups follow the saved order and disc numbers (rows do not jump while typing).
  const order = latestAlbum?.trackIds ?? drafts.album.base.trackIds;
  const groups = new Map<number, { number: number; title?: string; trackIds: string[] }>();
  for (const id of order) {
    const d = drafts.tracks[id];
    if (!d) continue;
    const number = (latestTrack(id) ?? d.base).discNumber;
    const title = (drafts.album.form.discTitles[number] ?? '').trim() || undefined;
    const group = groups.get(number) ?? { number, title, trackIds: [] };
    group.trackIds.push(id);
    groups.set(number, group);
  }
  const ids = [ALBUM, ...order.filter(id => drafts.tracks[id])];
  return {
    entities,
    dirtyIds: ids.filter(id => entities.get(id)?.dirty),
    conflictIds: ids.filter(id => entities.get(id)?.conflict),
    discs: [...groups.values()].sort((a, b) => a.number - b.number),
  };
}

function initialDrafts(album: Album, tracksById: ReadonlyMap<string, Track>, seed?: MetadataEditorBoot): Drafts {
  const tracks: Drafts['tracks'] = {};
  for (const id of album.trackIds) {
    const track = tracksById.get(id);
    if (!track) continue;
    const base = seed?.staleTrack?.(track) ?? track;
    tracks[id] = { form: seed?.editTrack ? seed.editTrack(trackForm(base), track) : trackForm(base), base };
  }
  const base = seed?.staleAlbum?.(album) ?? album;
  return { album: { form: seed?.editAlbum ? seed.editAlbum(albumForm(base)) : albumForm(base), base }, tracks };
}

// ── Panes ────────────────────────────────────────────────────────────────────

function RailItem({ id, selected, state, onSelect, art, title, lang, detail }: {
  id: string; selected: boolean; state: EntityState; onSelect(id: string): void; art: ReactNode; title: string; lang?: string; detail?: string;
}) {
  const flag = state.conflict ? 'conflict' : state.issues.some(i => i.blocking) && state.dirty ? 'issue' : state.dirty ? 'dirty' : null;
  return (
    <button type="button" className={styles.railItem} aria-current={selected ? 'true' : undefined} data-flag={flag ?? undefined}
      onClick={() => onSelect(id)}>
      {art}
      <span className={styles.railText}>
        <span className={styles.railTitle} lang={lang}>{title}</span>
        {detail && <span className={styles.railDetail}>{detail}</span>}
      </span>
      <span className={styles.railFlag} aria-hidden={!flag}>
        {flag === 'conflict' ? <Icon name="warning" size={15} /> : flag ? <i /> : null}
        {flag && <span className="sr-only">{flag === 'conflict' ? '有冲突' : flag === 'issue' ? '需要修改' : '未保存'}</span>}
      </span>
    </button>
  );
}

/**
 * Offer to fill the credit from the names only when it would help: the credit is empty, or the
 * names were changed in this draft. A hand-written credit (CV notes and the like) is otherwise left alone.
 */
function offerCredit(names: string[], savedNames: string[], credit: string) {
  if (!names.length || creditFrom(names) === credit.trim()) return false;
  return !credit.trim() || !sameFields(names, savedNames);
}

function Field({ label, field, required, edited, issues, hint, wide, children, htmlFor }: {
  label: string; field: string | string[]; required?: boolean; edited?: boolean; issues: FieldIssue[]; hint?: ReactNode; wide?: boolean;
  children: ReactNode; htmlFor?: string;
}) {
  const fields = Array.isArray(field) ? field : [field];
  const mine = issues.filter(i => fields.includes(i.field));
  return (
    <div className={styles.field} data-wide={wide ? 'true' : undefined} data-field={fields[0]} data-invalid={mine.some(i => i.blocking) ? 'true' : undefined}>
      <div className={styles.fieldHead}>
        {htmlFor ? <label htmlFor={htmlFor} className={styles.fieldLabel}>{label}</label> : <span className={styles.fieldLabel}>{label}</span>}
        {required && <span className={styles.required}>必填</span>}
        {edited && <span className={styles.edited} title="手动修改过：自动查找资料时不会覆盖这一项"><Icon name="lock" size={12} /> 手动</span>}
      </div>
      {children}
      {mine.map(issue => <p key={issue.message} className={styles.issue} data-blocking={issue.blocking ? 'true' : 'false'}>{issue.message}</p>)}
      {hint && !mine.length && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}

function TextInput({ id, value, onValue, invalid, placeholder, lang, numeric, label }: {
  id: string; value: string; onValue(value: string): void; invalid?: boolean; placeholder?: string; lang?: string; numeric?: boolean; label?: string;
}) {
  return <input id={id} className={fieldStyles.input} type="text" value={value} lang={lang} placeholder={placeholder}
    inputMode={numeric ? 'numeric' : undefined} aria-invalid={invalid || undefined} aria-label={label} spellCheck={false}
    onChange={event => onValue(event.target.value)} />;
}

function LanguageField({ id, value, onChange }: { id: string; value: string | null; onChange(value: string | null): void }) {
  return (
    <select id={id} className={fieldStyles.select} value={value ?? ''} onChange={event => onChange(event.target.value || null)}>
      <option value="">未标注</option>
      {languageOptions(value).map(([tag, name]) => <option key={tag} value={tag}>{name}</option>)}
    </select>
  );
}

function AlbumPane({ album, draft, discs, issues, dirty, set, onRevert, onPickCover, coverBusy, coverError, online }: {
  album: Album; draft: Draft<AlbumForm, Album>; discs: Model['discs']; issues: FieldIssue[]; dirty: boolean;
  set<K extends keyof AlbumForm>(field: K, value: AlbumForm[K]): void; onRevert(): void; onPickCover(): void;
  coverBusy: boolean; coverError?: string; online: boolean;
}) {
  const id = useId();
  const f = draft.form;
  const edited = (field: AlbumEditableField) => album.userEditedFields.includes(field);
  const bad = (field: string) => issues.some(i => i.field === field && i.blocking);
  const lang = langHint(f.title, null, f.language);
  const discNumbers = discUnion(album.discs, discs.map(d => d.number));
  return (
    <div className={styles.form}>
      <div className={styles.paneHead}>
        <h3 className={styles.paneTitle}>专辑资料</h3>
        {dirty && <button type="button" className="cdp-btn cdp-btn--text" onClick={onRevert}><Icon name="undo" size={15} /> 还原这一项</button>}
      </div>
      <div className={styles.coverRow}>
        <Cover albumId={album.id} title={album.title} cover={album.cover} className={styles.cover} showTitleOnPlaceholder={false} />
        <div className={styles.coverText}>
          <p className={styles.fieldLabel}>封面 {edited('cover') && <span className={styles.edited} title="手动更换过"><Icon name="lock" size={12} /> 手动</span>}</p>
          <p className={styles.hint}>{album.cover?.width ? <><span className="num">{album.cover.width}×{album.cover.height}</span> · </> : null}选好的图片会立即保存，不经过下面的“保存”。</p>
          <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online || coverBusy} onClick={onPickCover}>
            {coverBusy ? <span className="cdp-spinner" /> : <Icon name="image" size={16} />} {coverBusy ? '正在更换…' : '更换封面…'}
          </button>
          {coverError && <p className={styles.issue} role="alert" data-blocking="true">{coverError}</p>}
        </div>
      </div>
      <div className={styles.grid}>
        <Field label={ALBUM_FIELD_LABEL.title} field="title" required edited={edited('title')} issues={issues} wide htmlFor={id + 't'}>
          <TextInput id={id + 't'} value={f.title} onValue={v => set('title', v)} invalid={bad('title')} lang={lang} />
        </Field>
        <Field label={ALBUM_FIELD_LABEL.workTitle} field="workTitle" edited={edited('workTitle')} issues={issues} wide htmlFor={id + 'w'}
          hint="动画、游戏等作品名，用于“按作品”分组。">
          <TextInput id={id + 'w'} value={f.workTitle} onValue={v => set('workTitle', v)} placeholder="（未填写）" lang={langHint(f.workTitle, null, f.language)} />
        </Field>
        <Field label={ALBUM_FIELD_LABEL.albumArtists} field="albumArtists" edited={edited('albumArtists')} issues={issues} wide
          hint="逐个添加，用于“按艺术家”分组和搜索。">
          <NameList names={f.albumArtists} onChange={v => set('albumArtists', v)} label="专辑艺术家" />
        </Field>
        <Field label={ALBUM_FIELD_LABEL.albumArtistCredit} field="albumArtistCredit" required edited={edited('albumArtistCredit')} issues={issues} wide htmlFor={id + 'c'}
          hint={<>显示用的署名，可以写 CV 等说明。{offerCredit(f.albumArtists, draft.base.albumArtists, f.albumArtistCredit) &&
            <button type="button" className={styles.inlineAction} onClick={() => set('albumArtistCredit', creditFrom(f.albumArtists))}>按艺术家生成</button>}</>}>
          <TextInput id={id + 'c'} value={f.albumArtistCredit} onValue={v => set('albumArtistCredit', v)} invalid={bad('albumArtistCredit')}
            lang={langHint(f.albumArtistCredit, null, f.language)} />
        </Field>
        <Field label={ALBUM_FIELD_LABEL.releaseYear} field="releaseYear" edited={edited('releaseYear')} issues={issues} htmlFor={id + 'y'}>
          <TextInput id={id + 'y'} value={f.releaseYear} onValue={v => set('releaseYear', v)} invalid={bad('releaseYear')} numeric placeholder="（未填写）" />
        </Field>
        <Field label={ALBUM_FIELD_LABEL.catalogNumber} field="catalogNumber" edited={edited('catalogNumber')} issues={issues} htmlFor={id + 'n'}>
          <TextInput id={id + 'n'} value={f.catalogNumber} onValue={v => set('catalogNumber', v)} placeholder="例如 DEMO-001" />
        </Field>
        <Field label={ALBUM_FIELD_LABEL.label} field="label" edited={edited('label')} issues={issues} htmlFor={id + 'l'}>
          <TextInput id={id + 'l'} value={f.label} onValue={v => set('label', v)} placeholder="（未填写）" lang={langHint(f.label)} />
        </Field>
        <Field label={ALBUM_FIELD_LABEL.language} field="language" edited={edited('language')} issues={issues} htmlFor={id + 'g'}>
          <LanguageField id={id + 'g'} value={f.language} onChange={v => set('language', v)} />
        </Field>
        <Field label={ALBUM_FIELD_LABEL.titleSort} field="titleSort" edited={edited('titleSort')} issues={issues} wide htmlFor={id + 's'}
          hint="按标题排序时用它代替专辑名，例如写成假名读音。">
          <TextInput id={id + 's'} value={f.titleSort} onValue={v => set('titleSort', v)} placeholder="（未填写）" lang={langHint(f.titleSort, null, f.language)} />
        </Field>
        {(discNumbers.length > 1 || Object.values(f.discTitles).some(t => t.trim())) && (
          <Field label={ALBUM_FIELD_LABEL.discs} field="discs" edited={edited('discs')} issues={issues} wide hint="可以留空。">
            <div className={styles.discs}>
              {discNumbers.map(n => (
                <label key={n} className={styles.disc}>
                  <span className="num">Disc {n}</span>
                  <input className={fieldStyles.input} type="text" value={f.discTitles[n] ?? ''} placeholder="（无标题）" aria-label={`第 ${n} 碟标题`}
                    lang={langHint(f.discTitles[n], null, f.language)}
                    onChange={event => set('discTitles', { ...f.discTitles, [n]: event.target.value })} />
                </label>
              ))}
            </div>
          </Field>
        )}
      </div>
    </div>
  );
}

function TrackPane({ draft, album, issues, dirty, set, onRevert }: {
  draft: Draft<TrackForm, Track>; album: Album; issues: FieldIssue[]; dirty: boolean;
  set<K extends keyof TrackForm>(field: K, value: TrackForm[K]): void; onRevert(): void;
}) {
  const id = useId();
  const f = draft.form, track = draft.base;
  const edited = (field: TrackEditableField) => track.userEditedFields.includes(field);
  const bad = (field: string) => issues.some(i => i.field === field && i.blocking);
  const lang = langHint(f.title, f.language, album.language);
  return (
    <div className={styles.form}>
      <div className={styles.paneHead}>
        <h3 className={styles.paneTitle} lang={lang}>{f.title || track.title}</h3>
        <span className={`${styles.paneMeta} num`}>Disc {track.discNumber} · {track.trackNumber} · {formatClock(track.durationMs)}</span>
        {dirty && <button type="button" className="cdp-btn cdp-btn--text" onClick={onRevert}><Icon name="undo" size={15} /> 还原这一项</button>}
      </div>
      <div className={styles.grid}>
        <Field label={TRACK_FIELD_LABEL.title} field="title" required edited={edited('title')} issues={issues} wide htmlFor={id + 't'}>
          <TextInput id={id + 't'} value={f.title} onValue={v => set('title', v)} invalid={bad('title')} lang={lang} />
        </Field>
        <Field label={TRACK_FIELD_LABEL.artists} field="artists" edited={edited('artists')} issues={issues} wide
          hint="角色歌可以把角色和 CV 都加进来，方便搜索。">
          <NameList names={f.artists} onChange={v => set('artists', v)} label="歌手" />
        </Field>
        <Field label={TRACK_FIELD_LABEL.artistCredit} field="artistCredit" required edited={edited('artistCredit')} issues={issues} wide htmlFor={id + 'c'}
          hint={<>显示用的署名，例如 “白石ミナ (CV.月野ユイ)”。{offerCredit(f.artists, track.artists, f.artistCredit) &&
            <button type="button" className={styles.inlineAction} onClick={() => set('artistCredit', creditFrom(f.artists))}>按歌手生成</button>}</>}>
          <TextInput id={id + 'c'} value={f.artistCredit} onValue={v => set('artistCredit', v)} invalid={bad('artistCredit')}
            lang={langHint(f.artistCredit, f.language, album.language)} />
        </Field>
        <Field label={TRACK_FIELD_LABEL.versionKind} field="versionKind" edited={edited('versionKind')} issues={issues} htmlFor={id + 'k'}>
          <select id={id + 'k'} className={fieldStyles.select} value={f.versionKind ?? ''}
            onChange={event => set('versionKind', (event.target.value || null) as VersionKind | null)}>
            <option value="">未标注</option>
            {VERSION_KINDS.map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}
          </select>
        </Field>
        <Field label={TRACK_FIELD_LABEL.versionLabel} field="versionLabel" edited={edited('versionLabel')} issues={issues} htmlFor={id + 'v'}
          hint="原样显示在曲名旁，例如 TV size。">
          <TextInput id={id + 'v'} value={f.versionLabel} onValue={v => set('versionLabel', v)} placeholder="（未填写）" />
        </Field>
        <Field label={TRACK_FIELD_LABEL.language} field="language" edited={edited('language')} issues={issues} htmlFor={id + 'g'}>
          <LanguageField id={id + 'g'} value={f.language} onChange={v => set('language', v)} />
        </Field>
        <Field label="碟号 / 曲号" field={['discNumber', 'trackNumber']} edited={edited('discNumber') || edited('trackNumber')} issues={issues}>
          <div className={styles.numbers}>
            <TextInput id={id + 'd'} value={f.discNumber} onValue={v => set('discNumber', v)} invalid={bad('discNumber')} numeric label="碟号" />
            <span aria-hidden="true">/</span>
            <TextInput id={id + 'n'} value={f.trackNumber} onValue={v => set('trackNumber', v)} invalid={bad('trackNumber')} numeric label="曲号" />
          </div>
        </Field>
      </div>
    </div>
  );
}

function FieldCompare({ rows, revision }: { rows: FieldCompareRow[]; revision: number }) {
  return (
    <div className={styles.compare}>
      <p className={styles.compareLead}>左边是别处最新保存的第 <span className="num">{revision}</span> 版，右边是你的修改。标“双方都改”的字段需要你来决定。</p>
      <table className={styles.compareTable}>
        <thead><tr><th scope="col">字段</th><th scope="col">最新已保存</th><th scope="col">你的修改</th></tr></thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.field} data-clash={row.theirs && row.mine ? 'true' : undefined}>
              <th scope="row">{row.label}<span className={styles.compareWho}>{row.theirs && row.mine ? '双方都改' : row.theirs ? '别处改的' : '你改的'}</span></th>
              <td data-side="latest" data-changed={row.theirs ? 'true' : undefined}>{row.latest}</td>
              <td data-side="draft" data-changed={row.mine ? 'true' : undefined}>{row.draft}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <BannerDetail>两边的字段已经一致。</BannerDetail>}
    </div>
  );
}
