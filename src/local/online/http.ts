import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { LocalError } from "../model.ts";

export const ONLINE_USER_AGENT = "CDPlayer/1.0.0 (+https://github.com/kyoteikai2887/cd-player)";
export type Service = "musicbrainz" | "lrclib" | "cover" | "qq" | "netease" | "kugou";
const intervals: Record<Service, number> = {
  musicbrainz: 1100,
  lrclib: 500,
  cover: 500,
  qq: 500,
  netease: 500,
  kugou: 500,
};
export const cancelled = (signal: AbortSignal) => {
  if (signal.aborted) throw new LocalError("unavailable", "查询已取消。");
};
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new LocalError("unavailable", "查询已取消。"));
    };
    const timer = setTimeout(finish, Math.min(2147483647, Math.max(0, ms)));
    signal.addEventListener("abort", abort, { once: true });
  });
}
function allowed(raw: string, service: Service): URL {
  const url = new URL(raw);
  // CAA documents legacy http redirects; upgrade before sending any request.
  if (service === "cover" && url.protocol === "http:") url.protocol = "https:";
  const host = url.hostname;
  const safe =
    service === "musicbrainz"
      ? host === "musicbrainz.org"
      : service === "lrclib"
        ? host === "lrclib.net"
        : service === "qq"
          ? host === "u.y.qq.com" && url.pathname === "/cgi-bin/musicu.fcg"
          : service === "netease"
            ? host === "music.163.com" && ["/api/cloudsearch/pc", "/api/song/lyric"].includes(url.pathname)
            : service === "kugou"
              ? host === "lyrics.kugou.com" && ["/search", "/download"].includes(url.pathname)
              : host === "coverartarchive.org" ||
          host === "archive.org" ||
          host.endsWith(".archive.org");
  if (
    !safe ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new LocalError("invalidAction", "在线服务返回了不支持的地址。");
  return url;
}
/** Private disk cache: bounded, atomic and separate from the recoverable collection. */
export function createOnlineHttp(options: {
  directory?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: typeof pause;
  timeoutMs?: number;
}) {
  const request = options.fetch ?? fetch,
    now = options.now ?? Date.now,
    sleep = options.sleep ?? pause;
  const next = new Map<Service, number>(),
    tails = new Map<Service, Promise<unknown>>();
  const memory = new Map<string, { expires: number; value: unknown }>();
  const sizes = new Map<string, number>();
  const keyFor = (url: string, body?: string) =>
    createHash("sha256").update(body === undefined ? url : 'POST\n' + url + '\n' + body).digest("hex");
  async function cached(key: string) {
    let entry = memory.get(key);
    if (!entry && options.directory) {
      try {
        const filename = path.join(options.directory, key + ".json");
        if ((await stat(filename)).size <= 2 * 1024 * 1024)
          entry = JSON.parse(await readFile(filename, "utf8"));
      } catch {
        /* Corrupt/absent cache is a miss, never a collection reset. */
      }
    }
    return entry && Number.isFinite(entry.expires) && entry.expires > now()
      ? entry
      : undefined;
  }
  async function remember(key: string, value: unknown, signal: AbortSignal) {
    cancelled(signal);
    const v = value && typeof value === 'object' ? value as Record<string, any> : null;
    const negative = value === null || (Array.isArray(value) && !value.length) ||
      (v?.status === 200 && Array.isArray(v.candidates) && !v.candidates.length) ||
      (v?.code === 200 && (v.nolyric === true || v.uncollected === true ||
        v.result?.songCount === 0 || Array.isArray(v.result?.songs) && !v.result.songs.length)) ||
      (v?.code === 0 && v.request?.code === 0 && Array.isArray(v.request?.data?.body?.item_song) && !v.request.data.body.item_song.length);
    const entry = {
      expires: now() + (negative ? 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000),
      value,
    };
    const serialized = JSON.stringify(entry),
      bytes = Buffer.byteLength(serialized);
    sizes.set(key, bytes);
    memory.set(key, structuredClone(entry));
    while (
      memory.size > 96 ||
      [...sizes.values()].reduce((a, b) => a + b, 0) > 16 * 1024 * 1024
    ) {
      const first = memory.keys().next().value;
      if (!first) break;
      memory.delete(first);
      sizes.delete(first);
    }
    if (!options.directory) return;
    const filename = path.join(options.directory, key + ".json"),
      temporary = filename + "." + randomUUID() + ".tmp";
    try {
      await mkdir(options.directory, { recursive: true });
      await writeFile(temporary, serialized, { flag: "wx" });
      cancelled(signal);
      await rename(temporary, filename);
      const entries = await Promise.all(
        (await readdir(options.directory))
          .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
          .map(async (name) => ({
            name,
            info: await stat(path.join(options.directory!, name)),
          })),
      );
      entries.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs);
      let bytes = entries.reduce((sum, item) => sum + item.info.size, 0),
        count = entries.length;
      for (const item of entries) {
        if (count <= 96 && bytes <= 16 * 1024 * 1024) break;
        await unlink(path.join(options.directory, item.name));
        bytes -= item.info.size;
        count--;
      }
    } catch {
      /* A read-only/full cache must not make the lookup or save fail. */
    } finally {
      await unlink(temporary).catch(() => {});
    }
    cancelled(signal);
  }
  async function bytes(
    raw: string,
    service: Service,
    signal: AbortSignal,
    limit: number,
    body?: string,
  ): Promise<Uint8Array | null> {
    const prior = tails.get(service) ?? Promise.resolve();
    const operation = prior
      .catch(() => {})
      .then(async () => {
        cancelled(signal);
        await sleep(Math.max(0, (next.get(service) ?? 0) - now()), signal);
        const deadline = AbortSignal.timeout(options.timeoutMs ?? 10000);
        const combined = AbortSignal.any([signal, deadline]);
        let url = allowed(raw, service);
        if (body !== undefined && (service !== 'qq' || Buffer.byteLength(body) > 64000))
          throw new LocalError('invalidAction', '此在线服务不支持该请求。');
        try {
          for (let redirects = 0; redirects <= 5; redirects++) {
            cancelled(combined);
            if (redirects)
              await sleep(
                Math.max(0, (next.get(service) ?? 0) - now()),
                combined,
              );
            next.set(service, now() + intervals[service]);
            const response = await request(url, {
              signal: combined,
              redirect: "manual",
              ...(body === undefined ? {} : { method: 'POST', body }),
              headers: {
                "User-Agent": ONLINE_USER_AGENT,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(service === "netease" ? { Referer: "https://music.163.com/" } : {}),
                Accept:
                  service === "cover"
                    ? "image/jpeg,image/png,image/webp"
                    : "application/json",
              },
            });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers.get("location");
              await response.body?.cancel();
              if (!location || redirects === 5)
                throw new LocalError("unavailable", "在线服务跳转未完成。");
              url = allowed(new URL(location, url).href, service);
              continue;
            }
            if (response.status === 404) {
              await response.body?.cancel();
              return null;
            }
            if (response.status === 429 || response.status === 503) {
              const retry = response.headers.get("retry-after");
              const delay =
                retry && /^\d+$/.test(retry)
                  ? Number(retry) * 1000
                  : retry
                    ? Date.parse(retry) - now()
                    : 30000;
              next.set(
                service,
                now() +
                  Math.max(
                    intervals[service],
                    Number.isFinite(delay) ? Math.max(0, delay) : 30000,
                  ),
              );
              await response.body?.cancel();
              throw new LocalError(
                "unavailable",
                "在线服务繁忙，请稍后再查找。",
              );
            }
            if (!response.ok) {
              await response.body?.cancel();
              throw new LocalError(
                "unavailable",
                "在线服务暂时无法查询，请稍后重试。",
              );
            }
            if (Number(response.headers.get("content-length")) > limit) {
              await response.body?.cancel();
              throw new LocalError("unavailable", "在线结果过大，未采用。");
            }
            const reader = response.body?.getReader();
            if (!reader)
              throw new LocalError("unavailable", "在线服务返回了空响应。");
            let length = 0;
            const chunks: Uint8Array[] = [];
            try {
              while (true) {
                cancelled(combined);
                const { done, value } = await reader.read();
                if (done) break;
                length += value.length;
                if (length > limit)
                  throw new LocalError("unavailable", "在线结果过大，未采用。");
                chunks.push(value);
              }
            } finally {
              await reader.cancel().catch(() => {});
            }
            cancelled(combined);
            return Buffer.concat(chunks);
          }
          throw new LocalError("unavailable", "在线服务跳转未完成。");
        } catch (error) {
          cancelled(signal);
          if (deadline.aborted)
            throw new LocalError("unavailable", "在线查询超时，请重试。");
          if (error instanceof LocalError) throw error;
          throw new LocalError(
            "unavailable",
            deadline.aborted
              ? "在线查询超时，请重试。"
              : "在线连接失败，请检查网络后重试。",
          );
        }
      });
    tails.set(
      service,
      operation.catch(() => {}),
    );
    return operation;
  }
  return {
    bytes,
    async json(
      raw: string,
      service: Service,
      signal: AbortSignal,
      validate?: (value: unknown) => void,
      body?: string,
    ): Promise<unknown> {
      if (body !== undefined && (service !== 'qq' || Buffer.byteLength(body) > 64000))
        throw new LocalError('invalidAction', '此在线服务不支持该请求。');
      const url = allowed(raw, service).href,
        key = keyFor(url, body),
        hit = await cached(key);
      cancelled(signal);
      if (hit) {
        try {
          validate?.(hit.value);
          return structuredClone(hit.value);
        } catch {
          memory.delete(key);
          sizes.delete(key);
          if (options.directory)
            await unlink(path.join(options.directory, key + ".json")).catch(
              () => {},
            );
        }
      }
      const result = await bytes(url, service, signal, 2 * 1024 * 1024, body);
      let value: unknown = null;
      if (result !== null) {
        try {
          value = JSON.parse(Buffer.from(result).toString("utf8"));
        } catch {
          throw new LocalError("unavailable", "在线服务返回的数据无法读取。");
        }
      }
      validate?.(value);
      await remember(key, value, signal);
      return value;
    },
  };
}
