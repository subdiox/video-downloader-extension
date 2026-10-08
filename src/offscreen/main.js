// Offscreen document: downloads HLS/DASH streams with Mediabunny and writes a
// single MP4 (best video + audio, copied without re-encoding) into an OPFS
// file, so long recordings never sit in memory. Requests come from the
// extension origin: host_permissions bypass CORS and a DNR session rule set by
// the service worker supplies the page's Referer/Origin.
//
// Mediabunny handles HLS itself (TS/fMP4, AES-128, alternate audio, live).
// DASH goes through dash.js. Live streams record until the worker sends "stop".
// YouTube goes through youtube.js (youtubei.js, like yt-dlp).

import {
  ALL_FORMATS,
  Conversion,
  ConversionCanceledError,
  Input,
  Logging,
  LogLevel,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
} from "mediabunny";
import { dashSource, isMpd } from "./dash.js";
import { UserError, errorPayload } from "./errors.js";
// #if youtube
import { downloadYouTube, openYouTube } from "./youtube.js";
import { youtubeLiveSource } from "./youtube-live.js";
// #endif

const FETCH_INIT = { credentials: "include" };

// Mediabunny retries only network errors, and none at all for cross-origin
// requests (it suspects CORS). Retry flaky servers too: network errors and
// the statuses below, a few times with backoff. A segment that keeps failing
// still fails the download.
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export const SOURCE_OPTIONS = {
  requestInit: FETCH_INIT,
  fetchFn: async (url, init) => {
    const res = await fetch(url, init);
    if (RETRY_STATUS.has(res.status)) throw new Error(`HTTP ${res.status}`);
    return res;
  },
  getRetryDelay: (attempts) => (attempts <= 5 ? Math.min(2 ** (attempts - 1), 16) : null),
};

// Mediabunny warns about tracks it skips, e.g. ID3 timed metadata in MPEG-TS
// (stream_type 0x15). Harmless, but Chrome lists extension warnings as errors.
Logging.level = LogLevel.Errors;
const jobs = new Map(); // key -> { stop(), fileNames, url? }
const opfs = navigator.storage.getDirectory();

// Files left over from a previous offscreen document (crash, browser restart).
opfs.then(async (dir) => {
  for await (const name of dir.keys()) await dir.removeEntry(name).catch(() => {});
});

// Stopping a live recording disposes the input while segment reads may still
// be in flight; those reads then reject with this. Nothing is lost.
window.addEventListener("unhandledrejection", (e) => {
  if (/ref has already been freed/.test(e.reason?.message)) e.preventDefault();
});

// Chrome sniffs an MP4 holding only audio as video/mp4 and then renames .m4a
// to .mp4; a generic type keeps the name as given.
const AUDIO_BLOB_TYPE = "application/octet-stream";

const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});

// #if dev
// Development bridge (see background.js): devLog() lines reach the bridge.
globalThis.devLog = (...parts) => send({ type: "dev-log", text: parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ") });
// #endif

// `plain`: a single media file rather than a manifest (audio-only extraction).
async function openInput(url, quality, plain) {
  if (plain) return new Input({ source: new UrlSource(url, SOURCE_OPTIONS), formats: ALL_FORMATS });
  const res = await fetch(url, FETCH_INIT);
  if (!res.ok) throw new UserError("errManifest", res.status);
  const text = await res.text();
  const source = isMpd(text) ? dashSource(res.url, text, FETCH_INIT, SOURCE_OPTIONS, quality) : new UrlSource(res.url, SOURCE_OPTIONS);
  return new Input({ source, formats: ALL_FORMATS });
}

// The tracks to save: the best video no taller than `maxHeight` (else the
// smallest), and an audio track that plays with it. `audioOnly` skips video.
async function pickTracks(input, { maxHeight = Infinity, audioOnly = false } = {}) {
  let video = null;
  if (!audioOnly) {
    const fits = async (t) => (await t.getDisplayHeight()) <= maxHeight;
    video =
      (await input.getPrimaryVideoTrack({ filter: fits })) ??
      (await input.getVideoTracks({ sortBy: (t) => t.getDisplayHeight() }))[0] ??
      null;
  }
  // Audio only: a track that comes without video (e.g. Twitch's audio_only
  // variant) avoids downloading video it would throw away.
  const audio = audioOnly
    ? ((await input.getAudioTracks({ sortBy: async (t) => ((await t.getPairableVideoTracks()).length ? 1 : 0) }))[0] ?? null)
    : await input.getPrimaryAudioTrack({ filter: (t) => !video || video.canBePairedWith(t) });
  return { video, audio };
}

// The error as a UserError: library errors are wrapped as-is.
function userError(e) {
  if (e instanceof UserError) return e;
  const message = String(e?.message ?? e);
  return new UserError(/decrypt|encrypt|key|drm|protect/i.test(message) ? "errEncrypted" : "errDownloadFailed", message);
}

// `openSource`, if given, supplies the input in place of fetching `url`.
async function run(key, url, { liveFrom = "now", quality, plain = false, openSource = null } = {}) {
  const pause = new AbortController();
  const audioOnly = !!quality?.audioOnly;
  const fileName = `${crypto.randomUUID()}.mp4`;
  let conversion = null;
  let stopped = false;
  // Pausing suspends the track pumps at their next checkpoint, but a pump
  // waiting on the live edge may never reach one; cancel() wakes it. A
  // composable conversion's cancel leaves the output intact for finalize().
  const stop = () => {
    stopped = true;
    pause.abort();
    setTimeout(() => conversion?.cancel(), 2000);
  };
  jobs.set(key, { stop, fileNames: [fileName] });
  const dir = await opfs;
  try {
    const handle = await dir.getFileHandle(fileName, { create: true });
    const input = openSource ? new Input({ source: await openSource(), formats: ALL_FORMATS }) : await openInput(url, quality, plain);
    const target = new StreamTarget(await handle.createWritable(), { chunked: true });
    let bytes = 0;
    target.on("write", ({ end }) => (bytes = Math.max(bytes, end)));
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
    // Live: by default record from the live edge (when the user pressed
    // record); "start" keeps everything the stream's DVR window still holds.
    // Copying starts at the preceding key frame.
    // Every track must say live: before hydration an HLS VOD's audio track can
    // report live, which would trim a VOD down to its last seconds.
    const picked = await pickTracks(input, quality);
    const primary = [picked.video, picked.audio].filter(Boolean);
    if (!primary.length || (quality?.audioOnly && !picked.audio)) throw new UserError(quality?.audioOnly ? "errNoAudio" : "errNoTracks");
    const live = primary.length > 0 && (await Promise.all(primary.map((t) => t.isLive()))).every(Boolean);
    const trim = live && liveFrom !== "start" ? { start: await input.computeDuration(primary, { skipLiveWait: true }) } : undefined;

    // Composable: we own the output's lifecycle, so a paused (stopped) live
    // recording can still be finalized into a valid file.
    const only = (track) => (track === picked.video || track === picked.audio ? {} : { discard: true });
    conversion = await Conversion.init({ input, output, composable: true, showWarnings: false, trim, tracks: "all", video: only, audio: only });
    if (!conversion.isValid || !conversion.utilizedTracks.length) {
      throw conversion.discardedTracks.length ? new Error(conversion.discardedTracks.map((d) => d.reason).join(", ")) : new UserError("errNoTracks");
    }

    if (live) send({ type: "stream-live", key });
    // Mediabunny only reports progress when the fraction changes, which for
    // live input (infinite duration) is never, so report on a timer: elapsed
    // recording time and bytes written, plus the fraction for VOD.
    let progress = 0;
    conversion.onProgress = (p) => (progress = p);
    const startedAt = Date.now();
    const reporter = setInterval(() => {
      send({ type: "stream-progress", key, live, progress, seconds: (Date.now() - startedAt) / 1000, bytes });
    }, 1000);

    await output.start();
    try {
      await conversion.execute({ pauseSignal: pause.signal });
    } catch (e) {
      if (!(stopped && e instanceof ConversionCanceledError)) throw e;
    } finally {
      clearInterval(reporter);
    }
    await output.finalize();
    input.dispose?.();

    const file = await handle.getFile();
    if (!file.size) throw new UserError("errNoData");
    const blobUrl = URL.createObjectURL(new Blob([file], { type: audioOnly ? AUDIO_BLOB_TYPE : "video/mp4" }));
    jobs.get(key).url = blobUrl;
    send({ type: "stream-done", key, files: [{ url: blobUrl, suffix: "", ext: audioOnly ? ".m4a" : ".mp4" }] });
  } catch (e) {
    console.error(e);
    await cleanup(key);
    send({ type: "stream-failed", key, error: errorPayload(userError(e)) });
  }
}

// Players without a manifest: `candidates` are media files the page fetched,
// newest first. Keep those as long as the player's `duration` (others are
// preloaded neighbours or ads), take the best video and an audio track among
// them, and copy both into one file.
async function runMedia(key, candidates, duration, quality) {
  const audioOnly = !!quality?.audioOnly;
  const fileName = `${crypto.randomUUID()}.mp4`;
  const abort = new AbortController();
  const conversions = [];
  jobs.set(key, { stop: () => (abort.abort(), conversions.forEach((c) => c.cancel())), fileNames: [fileName] });
  const inputs = [];
  try {
    for (const url of candidates) {
      const input = new Input({ source: new UrlSource(url, SOURCE_OPTIONS), formats: ALL_FORMATS });
      try {
        const length = await input.computeDuration();
        if (Number.isFinite(duration) && Math.abs(length - duration) > Math.max(2, duration * 0.02)) throw new Error("other video");
        inputs.push(input);
      } catch {
        input.dispose?.();
      }
      if (abort.signal.aborted) throw new UserError("errAborted");
    }
    const tracks = (await Promise.all(inputs.map(async (input) => (await input.getTracks()).map((track) => ({ input, track }))))).flat();
    const fits = async ({ track }) => track.isVideoTrack() && (await track.getDisplayHeight()) <= (quality?.maxHeight ?? Infinity);
    const videos = tracks.filter(({ track }) => track.isVideoTrack());
    const sized = await Promise.all(videos.map(async (v) => ({ ...v, height: await v.track.getDisplayHeight(), ok: await fits(v) })));
    sized.sort((a, b) => b.height - a.height);
    const video = audioOnly ? null : (sized.find((v) => v.ok) ?? sized.at(-1) ?? null);
    const audio = tracks.find(({ input, track }) => track.isAudioTrack() && input === video?.input) ?? tracks.find(({ track }) => track.isAudioTrack()) ?? null;
    if (audioOnly ? !audio : !video) throw new UserError(audioOnly ? "errNoAudio" : "errNoTracks");

    const dir = await opfs;
    const handle = await dir.getFileHandle(fileName, { create: true });
    const target = new StreamTarget(await handle.createWritable(), { chunked: true });
    let bytes = 0;
    target.on("write", ({ end }) => (bytes = Math.max(bytes, end)));
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
    const chosen = [video, audio].filter(Boolean);
    for (const input of new Set(chosen.map((c) => c.input))) {
      const only = (track) => (chosen.some((c) => c.track === track) ? {} : { discard: true });
      conversions.push(await Conversion.init({ input, output, composable: true, showWarnings: false, tracks: "all", video: only, audio: only }));
    }
    const progress = conversions.map(() => 0);
    conversions.forEach((c, i) => (c.onProgress = (p) => (progress[i] = p)));
    const startedAt = Date.now();
    const reporter = setInterval(() => {
      const p = progress.reduce((a, b) => a + b, 0) / progress.length;
      send({ type: "stream-progress", key, live: false, progress: p, seconds: (Date.now() - startedAt) / 1000, bytes });
    }, 1000);
    await output.start();
    try {
      await Promise.all(conversions.map((c) => c.execute()));
    } finally {
      clearInterval(reporter);
    }
    await output.finalize();

    const file = await handle.getFile();
    if (!file.size) throw new UserError("errNoData");
    const blobUrl = URL.createObjectURL(new Blob([file], { type: audioOnly ? AUDIO_BLOB_TYPE : "video/mp4" }));
    jobs.get(key).url = blobUrl;
    send({ type: "stream-done", key, files: [{ url: blobUrl, suffix: "", ext: audioOnly ? ".m4a" : ".mp4" }] });
  } catch (e) {
    console.error(e);
    await cleanup(key);
    send({ type: "stream-failed", key, error: errorPayload(userError(e)) });
  } finally {
    inputs.forEach((i) => i.dispose?.());
  }
}

// #if youtube
async function runYouTube(key, pageUrl, poBodies, liveFrom, quality) {
  const abort = new AbortController();
  const fileNames = [];
  jobs.set(key, { stop: () => abort.abort(), fileNames });
  try {
    const video = await openYouTube(pageUrl, poBodies);
    if (abort.signal.aborted) throw new UserError("errAborted");
    // Live: the DASH segments give the best quality and can reach back to the
    // start of DVR streams; the HLS manifest is the fallback.
    if (video.liveDash) {
      const from = liveFrom === "start" && video.dvr ? "start" : "now";
      return run(key, null, { liveFrom: "start", quality, openSource: () => youtubeLiveSource(video.liveDash, { from, quality }) });
    }
    if (video.liveManifest) return run(key, video.liveManifest, { quality });
    let progress = 0;
    let bytes = 0;
    const startedAt = Date.now();
    const reporter = setInterval(() => {
      send({ type: "stream-progress", key, live: false, progress, seconds: (Date.now() - startedAt) / 1000, bytes });
    }, 1000);
    let result;
    try {
      result = await downloadYouTube(video, {
        quality,
        dir: await opfs,
        newFile: () => {
          const name = `${crypto.randomUUID()}.part`;
          fileNames.push(name);
          return name;
        },
        onProgress: (done, total) => ((bytes = done), (progress = done / total)),
        signal: abort.signal,
      });
    } finally {
      clearInterval(reporter);
    }
    const file = await result.handle.getFile();
    if (!file.size) throw new UserError("errNoData");
    const audioOnly = !!quality?.audioOnly;
    const blobUrl = URL.createObjectURL(new Blob([file], { type: audioOnly ? AUDIO_BLOB_TYPE : "video/mp4" }));
    jobs.get(key).url = blobUrl;
    send({ type: "stream-done", key, files: [{ url: blobUrl, suffix: "", ext: audioOnly ? ".m4a" : ".mp4" }] });
  } catch (e) {
    console.error(e);
    await cleanup(key);
    send({ type: "stream-failed", key, error: errorPayload(new UserError("yt_errYouTube", e instanceof UserError ? e : String(e?.message ?? e))) });
  }
}
// #endif

async function cleanup(key) {
  const job = jobs.get(key);
  if (!job) return;
  jobs.delete(key);
  if (job.url) URL.revokeObjectURL(job.url);
  const dir = await opfs;
  for (const name of job.fileNames) await dir.removeEntry(name).catch(() => {});
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "offscreen") return;
  if (message.type === "stream") run(message.key, message.url, { liveFrom: message.liveFrom, quality: message.quality, plain: message.plain });
  // #if youtube
  if (message.type === "youtube") runYouTube(message.key, message.url, message.poBodies, message.liveFrom, message.quality);
  // #endif
  if (message.type === "media") runMedia(message.key, message.candidates, message.duration, message.quality);
  if (message.type === "stop") jobs.get(message.key)?.stop();
  if (message.type === "revoke") cleanup(message.key);
});
