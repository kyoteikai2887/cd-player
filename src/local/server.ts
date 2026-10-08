import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { parseFile } from "music-metadata";
import type { AudioInfo } from "../core/adaptiveAudio.ts";
import { fileURLToPath } from "node:url";
import type {
  UIAction,
  TaskInfo,
  LyricsPendingImport,
  MetadataReview,
  LyricsReview,
} from "../contracts/player.ts";
import { parseLyrics } from "../core/lyrics.ts";
import { LocalError } from "./model.ts";
import type { LocalView } from "./model.ts";
import type { LocalStore } from "./store.ts";
import { scanFolder, mergeScan, cacheCover, markRootUnavailable } from "./scanner.ts";
import { observeLegacyIdentities } from './identity.ts';
import { applyLocalWrite, importLocalLyrics } from "./actions.ts";
import { planAlbumRemoval } from "../core/library.ts";
import { createOnlineServices } from './online/providers.ts';
import type { OnlineServices } from './online/providers.ts';
import { prepareMetadataReview, applyOnlineMetadata } from './online/metadata.ts';
import type { PreparedReview } from './online/metadata.ts';
import { fillOnlineLyrics } from './online/lyrics.ts';
import { prepareLyricsReview, selectedLyrics, applyLyricsReview } from './online/candidates.ts';
import type { PreparedLyricsReview } from './online/candidates.ts';

type PickKind = "folder" | "lyrics" | "cover";
export function pickWindowsFile(
  kind: PickKind,
  signal: AbortSignal,
  executablePath?: string,
): Promise<string | null> {
  if (process.platform !== "win32")
    throw new LocalError("unsupported", "此文件选择器目前只支持 Windows。");
  return new Promise((resolve, reject) => {
    const executable =
      executablePath ??
      fileURLToPath(
        new URL("../../.native-runtime/file-picker.exe", import.meta.url),
      );
    const child = spawn(
      executable,
      ["--kind", kind],
      // The helper is a GUI executable: it has no console to hide. SW_HIDE would
      // also suppress the native dialog on its first ShowWindow call.
      { windowsHide: false, signal },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    const errors: Buffer[] = [];
    let errorLength = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorLength < 8192) {
        errors.push(chunk);
        errorLength += chunk.length;
      }
    });
    child.on("error", (error) =>
      reject(
        signal.aborted
          ? error
          : new LocalError(
              "io",
              "文件选择窗口无法启动，请检查播放器文件是否完整。",
            ),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString("utf8").trim() || null)
        : reject(
            Object.assign(new LocalError("io", "文件选择器未能完成。"), {
              cause: new Error(Buffer.concat(errors).toString("utf8").trim()),
            }),
          ),
    );
  });
}
export interface LocalTask {
  task: TaskInfo;
  state: "running" | "done" | "failed" | "cancelled";
  result?: {
    view?: LocalView;
    pendingImport?: LyricsPendingImport;
    warnings?: string[];
    metadataReview?: MetadataReview;
    lyricsReview?: LyricsReview;
    lyricsLookup?: { trackId: string; status: 'idle' | 'notFound' };
  };
  error?: { code: string; message: string };
}
export async function startLocalServer(options: {
  store: LocalStore;
  dataDirectory: string;
  port?: number;
  picker?: (kind: PickKind, signal: AbortSignal) => Promise<string | null>;
  middleware?: (req: IncomingMessage, res: ServerResponse) => void;
  online?: OnlineServices;
}) {
  const { store } = options,
    token = randomBytes(32).toString("hex"),
    jobs = new Map<
      string,
      { record: LocalTask; controller: AbortController; promise: Promise<void> }
    >();
  const picker = options.picker ?? pickWindowsFile;
  const cache = path.join(options.dataDirectory, "covers");
  const online = options.online ?? createOnlineServices({ directory: path.join(options.dataDirectory, 'online-cache') });
  const reviews = new Map<string, PreparedReview>();
  const lyricsReviews = new Map<string, PreparedLyricsReview>();
  let activeLyricsReview: string | null = null;
  const previewCovers = new Map<string, { path: string; mime: string }>();
  const audioInfo = new Map<string, { key: string; value: AudioInfo }>();
  let origin = "";
  const errorBody = (error: unknown) =>
    error instanceof LocalError
      ? { ok: false, code: error.code, message: error.message }
      : {
          ok: false,
          code: "io",
          message: "本地操作未完成，请检查文件和目录权限。",
        };
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(value));
  };
  const begin = (
    kind: TaskInfo["kind"],
    label: string,
    run: (signal: AbortSignal) => Promise<LocalTask["result"]>,
    target: { albumId?: string; trackId?: string } = {},
    timeoutMs = 120000,
  ) => {
    if ([...jobs.values()].some((job) => job.record.state === "running"))
      throw new LocalError(
        "unavailable",
        "请等待当前文件操作完成，或先取消它。",
      );
    for (const [id, job] of jobs)
      if (jobs.size >= 64 && job.record.state !== "running") jobs.delete(id);
    const id = randomUUID(),
      controller = new AbortController(),
      record: LocalTask = {
        task: {
          id,
          kind,
          label,
          status: "running",
          cancellable: true,
          ...target,
        },
        state: "running",
      };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const promise = Promise.resolve()
      .then(() => run(controller.signal))
      .then(
        (result) => {
          if (timedOut) {
            record.state = "failed";
            record.error = {
              code: "unavailable",
              message: kind === 'metadata' || kind === 'lyrics' ? '在线查询超时，请重试。' : '文件操作超时，请重试。',
            };
          } else if (controller.signal.aborted) record.state = "cancelled";
          else if (!result) record.state = "cancelled";
          else {
            record.state = "done";
            record.result = result;
          }
        },
        (error) => {
          if (timedOut) {
            record.state = "failed";
            record.error = {
              code: "unavailable",
              message: kind === 'metadata' || kind === 'lyrics' ? '在线查询超时，请重试。' : '文件操作超时，请重试。',
            };
          } else if (controller.signal.aborted) record.state = "cancelled";
          else {
            record.state = "failed";
            const body = errorBody(error);
            record.error = { code: body.code, message: body.message };
            if (body.code === "conflict")
              record.result = { view: store.view() };
          }
        },
      )
      .finally(() => clearTimeout(timer));
    jobs.set(id, { record, controller, promise });
    return { ok: true, status: "started", taskId: id, task: record.task };
  };
  const requestBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024)
        throw new LocalError("invalidAction", "请求内容过大。");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new LocalError("invalidAction", "请求格式无效。");
    }
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const requestController = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) requestController.abort();
      });
      const url = new URL(req.url ?? "/", origin);
      if (!url.pathname.startsWith("/api/")) {
        if (options.middleware) options.middleware(req, res);
        else json(res, 404, { ok: false });
        return;
      }
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new LocalError("invalidAction", "请求来源无效。");
      if (url.pathname === "/api/bootstrap" && req.method === "GET") {
        res.setHeader(
          "set-cookie",
          "cd_session=" + token + "; HttpOnly; SameSite=Strict; Path=/",
        );
        json(res, 200, { token, view: store.view() });
        return;
      }
      const cookie = req.headers.cookie
        ?.split(";")
        .map((item) => item.trim())
        .includes("cd_session=" + token);
      if (
        req.headers["x-cd-token"] !== token &&
        !(req.method === "GET" && cookie)
      )
        throw new LocalError(
          "invalidAction",
          "本地会话已失效，请重新打开页面。",
        );
      if (req.method === "GET" && url.pathname === "/api/health") {
        // Authenticated liveness only: no library payload or cookie renewal.
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/library") {
        json(res, 200, store.view());
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/task/")) {
        const job = jobs.get(url.pathname.slice("/api/task/".length));
        if (!job) throw new LocalError("notFound", "任务不存在。");
        json(res, 200, job.record);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/audio-info/")) {
        const id = url.pathname.slice("/api/audio-info/".length);
        const record = store.read().files[id];
        if (!record) throw new LocalError("notFound", "文件不存在。");
        if ((await realpath(record.path)) !== record.path)
          throw new LocalError("fileMissing", "文件路径已改变，请重新扫描。");
        const info = await stat(record.path);
        if (!info.isFile()) throw new LocalError("fileMissing", "文件不可用。");
        const key = JSON.stringify([record.path, info.size, info.mtimeMs]);
        let cached = audioInfo.get(id);
        if (cached?.key !== key) {
          const metadata = await parseFile(record.path, {
            skipCovers: true,
            duration: true,
          });
          cached = {
            key,
            value: {
              size: info.size,
              durationMs: Math.round((metadata.format.duration ?? 0) * 1000),
              sampleRate: metadata.format.sampleRate ?? 0,
              channels: metadata.format.numberOfChannels ?? 0,
            },
          };
          // Bound metadata-only cache for repeated rescans/removals as well.
          if (audioInfo.size >= 512)
            audioInfo.delete(audioInfo.keys().next().value!);
          audioInfo.set(id, cached);
        }
        json(res, 200, cached.value);
        return;
      }
      if (
        req.method === "GET" &&
        (url.pathname.startsWith("/api/media/") ||
          url.pathname.startsWith("/api/cover/") || url.pathname.startsWith('/api/online-cover/'))
      ) {
        const media = url.pathname.startsWith("/api/media/"),
          preview = url.pathname.startsWith('/api/online-cover/'),
          id = url.pathname.slice(preview ? '/api/online-cover/'.length : 11),
          data = store.read();
        const record = media ? data.files[id] : preview ? previewCovers.get(id) : data.covers[id];
        if (!record) throw new LocalError("notFound", "文件不存在。");
        if ((await realpath(record.path)) !== record.path)
          throw new LocalError("fileMissing", "文件路径已改变，请重新扫描。");
        const info = await stat(record.path);
        if (!info.isFile()) throw new LocalError("fileMissing", "文件不可用。");
        const mime = media
          ? ({
              ".flac": "audio/flac",
              ".mp3": "audio/mpeg",
              ".wav": "audio/wav",
            }[path.extname(record.path).toLowerCase()] ??
            "application/octet-stream")
          : (preview ? previewCovers.get(id)! : data.covers[id]).mime;
        let start = 0,
          end = info.size - 1,
          status = 200;
        if (req.headers.range) {
          const match = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
          if (!match) {
            res.writeHead(416, { "content-range": "bytes */" + info.size });
            res.end();
            return;
          }
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), end) : end;
          if (start > end || start >= info.size) {
            res.writeHead(416, { "content-range": "bytes */" + info.size });
            res.end();
            return;
          }
          status = 206;
          res.setHeader("content-range", `bytes ${start}-${end}/${info.size}`);
        }
        res.writeHead(status, {
          "content-type": mime,
          "content-length": end - start + 1,
          "accept-ranges": "bytes",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        const stream = createReadStream(record.path, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (req.method !== "POST")
        throw new LocalError("unsupported", "不支持的请求。");
      const action = (await requestBody(req)) as UIAction;
      if (url.pathname === "/api/action") {
        try {
          if (action.type === 'closeLyricsReview') {
            activeLyricsReview = null; lyricsReviews.clear();
            for (const job of jobs.values()) if (job.record.state === 'running' && job.record.task.label === '搜索歌词候选') job.controller.abort();
            json(res, 200, { ok: true, view: store.view() }); return;
          }
          if (action.type === 'applyLyricsCandidate' && action.destination === 'editorDraft') {
            const prepared = lyricsReviews.get(action.reviewId);
            if (!prepared) throw new LocalError('conflict', '候选已关闭或过期，请重新查找。');
            const document = selectedLyrics(store.read(), prepared, action);
            lyricsReviews.delete(action.reviewId); activeLyricsReview = null;
            json(res, 200, { ok: true, view: store.view(), pendingImport: { id: randomUUID(), content: 'original',
              kind: document.kind, lines: document.lines, language: document.language, warnings: document.warnings } }); return;
          }
          if (action.type === 'closeMetadataReview') {
            reviews.clear(); previewCovers.clear();
            for (const job of jobs.values()) if (job.record.state === 'running' && job.record.task.kind === 'metadata') job.controller.abort();
            json(res, 200, { ok: true, view: store.view() }); return;
          }
          let removedTrackIds: Set<string> | null = null;
          if (action.type === 'removeAlbum') {
            const plan = planAlbumRemoval(store.view().library, action.albumId, action.baseLibraryRevision);
            if (!plan.ok) throw new LocalError(plan.code, plan.message);
            removedTrackIds = new Set(plan.trackIds);
            // Always preserve the latest application metadata before collection removal.
            await store.backup();
          }
          const view = await store.transact(
            (data) => {
              if (action.type === 'applyLyricsCandidate') {
                const prepared = lyricsReviews.get(action.reviewId);
                if (!prepared) throw new LocalError('conflict', '候选已关闭或过期，请重新查找。');
                if (action.destination !== undefined && action.destination !== 'document') throw new LocalError('invalidAction', '导入目标无效。');
                applyLyricsReview(data, prepared, action);
              } else if (action.type === 'applyMetadataCandidate') {
                const review = reviews.get(action.reviewId);
                if (!review) throw new LocalError('conflict', '候选已关闭或过期，请重新查找。');
                applyOnlineMetadata(data, review, action);
              } else applyLocalWrite(data, action);
            },
            () => !requestController.signal.aborted,
          );
          if (action.type === 'removeAlbum' && removedTrackIds) {
            for (const [id, prepared] of lyricsReviews) if (removedTrackIds.has(prepared.review.trackId)) { lyricsReviews.delete(id); if (activeLyricsReview === id) activeLyricsReview = null; }
            for (const [id, prepared] of reviews) if (prepared.review.albumId === action.albumId) reviews.delete(id);
            for (const job of jobs.values()) {
              if (job.record.state === 'running' && (job.record.task.albumId === action.albumId ||
                (job.record.task.trackId && removedTrackIds.has(job.record.task.trackId)))) job.controller.abort();
            }
          }
          if (action.type === 'applyMetadataCandidate') { reviews.delete(action.reviewId); previewCovers.clear(); }
          if (action.type === 'applyLyricsCandidate') { lyricsReviews.delete(action.reviewId); activeLyricsReview = null; }
          json(res, 200, { ok: true, view });
        } catch (error) {
          json(res, 409, { ...errorBody(error), view: store.view() });
        }
        return;
      }
      if (url.pathname !== "/api/task")
        throw new LocalError("notFound", "接口不存在。");
      switch (action.type) {
        case 'searchLyricsCandidates': {
          const baseline = store.read(), track = baseline.library.tracks.find(t => t.id === action.trackId), document = baseline.lyricsByTrack[action.trackId];
          const album = track && baseline.library.albums.find(a => a.id === track.albumId);
          if (!track || !album || !document) throw new LocalError('notFound', '曲目不存在。');
          if (document.locked) throw new LocalError('locked', '歌词已锁定。');
          if (!online.searchLyrics) throw new LocalError('unsupported', '此歌词源不支持候选搜索。');
          if (action.query && (typeof action.query.title !== 'string' || !action.query.title.trim() || action.query.title.length > 2000 ||
            typeof action.query.artist !== 'string' || action.query.artist.length > 2000)) throw new LocalError('invalidAction', '请输入有效曲名与歌手。');
          const query = action.query ? { title: action.query.title.trim(), artist: action.query.artist.trim() } :
            { title: track.title, artist: track.artists[0] ?? track.artistCredit };
          const prepared = prepareLyricsReview(track, album, document, [], query), reviewId = prepared.review.id;
          const reply = begin('lyrics', '搜索歌词候选', async signal => {
            const records = await online.searchLyrics!(track, album, signal, action.query ? query : undefined);
            if (signal.aborted || activeLyricsReview !== reviewId) return;
            const result = prepareLyricsReview(track, album, document, records, query); result.review.id = reviewId;
            lyricsReviews.set(reviewId, result);
            return { lyricsReview: result.review };
          }, { albumId: album.id, trackId: track.id }, 45000);
          lyricsReviews.clear(); activeLyricsReview = reviewId;
          json(res, 200, { ...reply, lyricsReview: { ...prepared.review, status: 'searching' } }); return;
        }
        case 'lookupMetadata': {
          const baseline = store.read(), album = baseline.library.albums.find(a => a.id === action.albumId);
          if (!album) throw new LocalError('notFound', '专辑不存在。');
          const reviewId = randomUUID();
          const initial: MetadataReview = { id: reviewId, albumId: album.id, baseLibraryRevision: baseline.library.revision,
            status: 'searching', candidates: [], error: null };
          const reply = begin('metadata', '查找在线专辑资料', async signal => {
            const results = await online.metadata(album, baseline.library.tracks.filter(t => t.albumId === album.id), signal);
            const staged = [];
            for (const result of results) {
              if (signal.aborted) return;
              let coverRecord: { path: string; mime: string } | undefined, coverPreview: string | undefined;
              if (result.cover) {
                try {
                  coverRecord = await cacheCover(result.cover, cache);
                  const id = randomUUID(); previewCovers.set(id, coverRecord); coverPreview = '/api/online-cover/' + id;
                } catch { result.notes.push('候选封面格式不支持，保留本地封面。'); }
              }
              staged.push({ ...result, coverRecord, coverPreview });
            }
            if (signal.aborted) return;
            const prepared = prepareMetadataReview(baseline, album, staged);
            prepared.review.id = reviewId;
            reviews.set(reviewId, prepared);
            return { metadataReview: prepared.review };
          }, { albumId: album.id }, 45000);
          reviews.clear(); previewCovers.clear();
          json(res, 200, { ...reply, metadataReview: initial }); return;
        }
        case 'lookupLyrics': {
          const baseline = store.read(), track = baseline.library.tracks.find(t => t.id === action.trackId), document = baseline.lyricsByTrack[action.trackId];
          const album = track && baseline.library.albums.find(a => a.id === track.albumId);
          if (!track || !document || !album) throw new LocalError('notFound', '曲目不存在。');
          if (document.locked) throw new LocalError('locked', '歌词已锁定；替换请使用编辑器或导入。');
          if (['instrumental', 'spoken'].includes(document.kind)) { json(res, 200, { ok: true, status: 'applied' }); return; }
          json(res, 200, begin('lyrics', '查找在线歌词', async signal => {
            const candidate = await online.lyrics(track, album, signal);
            if (signal.aborted) return;
            const expected = { trackId: track.id, trackRevision: track.revision, albumRevision: album.revision, lyricsRevision: document.revision };
            const changed = fillOnlineLyrics(store.read(), expected, candidate);
            const view = changed ? await store.transact(data => { fillOnlineLyrics(data, expected, candidate); }, () => !signal.aborted) : store.view();
            return { view, lyricsLookup: { trackId: track.id, status: candidate || changed ? 'idle' : 'notFound' } };
          }, { trackId: track.id, albumId: album.id }, 30000)); return;
        }
        case "cancelTask": {
          const job = jobs.get(action.taskId);
          if (!job) throw new LocalError("notFound", "任务已结束。");
          if (job.record.state === 'running') job.record.task = { ...job.record.task, status: 'cancelling' };
          job.controller.abort();
          json(res, 200, { ok: true, status: "applied" });
          return;
        }
        case "importFolder":
        case "rescanLibrary": {
          const importRevision = store.view().library.revision;
          json(
            res,
            200,
            begin(
              action.type === "importFolder" ? "import" : "scan",
              "读取本地资料库",
              async (signal) => {
                const roots =
                  action.type === "importFolder"
                    ? [await picker("folder", signal)]
                    : store.read().roots;
                const warnings: string[] = [];
                let imported = false;
                const observations = await observeLegacyIdentities(store.read(), signal);
                for (const root of roots) {
                  if (!root) return;
                  if (signal.aborted) throw new LocalError('unavailable', '扫描已取消。');
                  if (action.type === 'rescanLibrary') {
                    try { await stat(root); }
                    catch (error) {
                      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
                      await store.transact(data => markRootUnavailable(data, root), () => !signal.aborted);
                      warnings.push('音乐文件夹已离线或移动，记录已保留；请用导入文件夹关联新位置：' + path.basename(root));
                      imported = true;
                      continue;
                    }
                  }
                  const scan = await scanFolder(root, cache, signal);
                  let mergeResult: ReturnType<typeof mergeScan> | undefined;
                  await store.transact(
                    (data) => {
                      if (signal.aborted)
                        throw new LocalError("unavailable", "扫描已取消。");
                      mergeResult = mergeScan(data, scan, { observations, ...(action.type === 'importFolder'
                        ? { restoreRemovedAtRevision: importRevision } : {}) });
                    },
                    () => !signal.aborted,
                  );
                  warnings.push(...(mergeResult?.warnings ?? scan.warnings));
                  imported = true;
                }
                return {
                  view: store.view(),
                  warnings: imported
                    ? warnings
                    : ["资料库尚无根目录，请先导入。"],
                };
              },
            ),
          );
          return;
        }
        case "importLyrics": {
          const document = store.read().lyricsByTrack[action.trackId];
          if (!document) throw new LocalError("notFound", "曲目不存在。");
          if (
            !["original", "translation", "bilingual"].includes(action.content)
          )
            throw new LocalError("invalidAction", "歌词导入类型无效。");
          const baseline = action.baseRevision ?? document.revision;
          if (
            action.destination !== "editorDraft" &&
            baseline !== document.revision
          )
            throw new LocalError("conflict", "歌词已变化。");
          json(
            res,
            200,
            begin(
              "import",
              "导入本地歌词",
              async (signal) => {
                const filename = await picker("lyrics", signal);
                if (!filename) return;
                if ((await stat(filename)).size > 2 * 1024 * 1024)
                  throw new LocalError("invalidAction", "歌词文件须小于2MB。");
                const text = await readFile(filename, "utf8");
                if (signal.aborted) return;
                if (action.destination === "editorDraft") {
                  const parsed = parseLyrics(text, action.trackId, {
                    duplicateTimestampMode:
                      action.content === "bilingual" ? "bilingual" : "merge",
                  });
                  if (parsed.kind === "missing")
                    throw new LocalError("invalidAction", "没有有效歌词正文。");
                  return {
                    pendingImport: {
                      id: randomUUID(),
                      content: action.content,
                      kind: parsed.kind as "synced" | "plain",
                      lines: parsed.lines,
                      language: parsed.language,
                      warnings: parsed.warnings,
                    },
                  };
                }
                const view = await store.transact(
                  (data) => {
                    if (signal.aborted)
                      throw new LocalError("unavailable", "导入已取消。");
                    importLocalLyrics(data, action, text, baseline);
                  },
                  () => !signal.aborted,
                );
                return { view };
              },
              { trackId: action.trackId },
            ),
          );
          return;
        }
        case "pickCoverImage": {
          const album = store
            .read()
            .library.albums.find((a) => a.id === action.albumId);
          if (!album) throw new LocalError("notFound", "专辑不存在。");
          if (album.revision !== action.baseRevision)
            throw new LocalError("conflict", "专辑资料已变化。");
          json(
            res,
            200,
            begin(
              "import",
              "选择本地封面",
              async (signal) => {
                const filename = await picker("cover", signal);
                if (!filename) return;
                if ((await stat(filename)).size > 10 * 1024 * 1024)
                  throw new LocalError("invalidAction", "封面须小于10MB。");
                const cover = await cacheCover(await readFile(filename), cache);
                const view = await store.transact(
                  (data) => {
                    if (signal.aborted)
                      throw new LocalError("unavailable", "封面选择已取消。");
                    const latest = data.library.albums.find(
                      (a) => a.id === action.albumId,
                    );
                    if (!latest) throw new LocalError('notFound', '选择封面期间专辑已移除。');
                    if (latest.revision !== action.baseRevision)
                      throw new LocalError(
                        "conflict",
                        "选择封面期间资料已变化。",
                      );
                    latest.cover = {
                      thumbUrl: "/api/cover/" + latest.id,
                      fullUrl: "/api/cover/" + latest.id,
                    };
                    latest.userEditedFields = [
                      ...new Set([
                        ...latest.userEditedFields,
                        "cover" as const,
                      ]),
                    ];
                    latest.revision++;
                    data.covers[latest.id] = cover;
                    data.library.revision++;
                  },
                  () => !signal.aborted,
                );
                return { view };
              },
              { albumId: action.albumId },
            ),
          );
          return;
        }
        default:
          throw new LocalError("unsupported", "本地后台尚未接入该操作。");
      }
    })().catch((error) => {
      if (!res.headersSent)
        json(
          res,
          error instanceof LocalError && error.code === "notFound" ? 404 : 400,
          errorBody(error),
        );
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No listener address");
  origin = "http://127.0.0.1:" + address.port;
  return {
    origin,
    token,
    async close() {
      for (const job of jobs.values()) job.controller.abort();
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Stop accepting first, then terminate active media/static streams too. A hidden
        // WebView may leave one unfinished; waiting for it used to force the native 8s kill.
        server.closeAllConnections();
      });
      await Promise.allSettled([...jobs.values()].map((job) => job.promise));
    },
  };
}
