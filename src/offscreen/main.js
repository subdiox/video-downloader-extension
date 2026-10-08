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
import { DrmError, dashSource, isMpd } from "./dash.js";
// #if youtube
import { downloadYouTube, openYouTube } from "./youtube.js";
import { youtubeLiveSource } from "./youtube-live.js";
// #endif

const FETCH_INIT = { credentials: "include" };

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

const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});

async function openInput(url) {
  const res = await fetch(url, FETCH_INIT);
  if (!res.ok) throw new Error(`マニフェストを取得できません (HTTP ${res.status})`);
  const text = await res.text();
  const source = isMpd(text) ? dashSource(res.url, text, FETCH_INIT) : new UrlSource(res.url, { requestInit: FETCH_INIT });
  return new Input({ source, formats: ALL_FORMATS });
}

function describeError(e) {
  if (e instanceof DrmError) return e.message;
  const message = String(e?.message ?? e);
  if (/decrypt|encrypt|key|drm|protect/i.test(message)) return `暗号化/DRMのため取得できません: ${message}`;
  return `ダウンロード失敗: ${message}`;
}

// `openSource`, if given, supplies the input in place of fetching `url`.
async function run(key, url, liveFrom = "now", openSource = null) {
  const pause = new AbortController();
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
    const input = openSource ? new Input({ source: await openSource(), formats: ALL_FORMATS }) : await openInput(url);
    const target = new StreamTarget(await handle.createWritable(), { chunked: true });
    let bytes = 0;
    target.on("write", ({ end }) => (bytes = Math.max(bytes, end)));
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
    // Live: by default record from the live edge (when the user pressed
    // record); "start" keeps everything the stream's DVR window still holds.
    // Copying starts at the preceding key frame.
    // Every track must say live: before hydration an HLS VOD's audio track can
    // report live, which would trim a VOD down to its last seconds.
    const primary = [await input.getPrimaryVideoTrack(), await input.getPrimaryAudioTrack()].filter(Boolean);
    const live = primary.length > 0 && (await Promise.all(primary.map((t) => t.isLive()))).every(Boolean);
    const trim = live && liveFrom !== "start" ? { start: await input.computeDuration(primary, { skipLiveWait: true }) } : undefined;

    // Composable: we own the output's lifecycle, so a paused (stopped) live
    // recording can still be finalized into a valid file.
    conversion = await Conversion.init({ input, output, composable: true, showWarnings: false, trim });
    if (!conversion.isValid || !conversion.utilizedTracks.length) {
      throw new Error(conversion.discardedTracks.map((d) => d.reason).join(", ") || "変換できるトラックがありません");
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
    if (!file.size) throw new Error("データがありません");
    const blobUrl = URL.createObjectURL(new Blob([file], { type: "video/mp4" }));
    jobs.get(key).url = blobUrl;
    send({ type: "stream-done", key, files: [{ url: blobUrl, suffix: "", ext: ".mp4" }] });
  } catch (e) {
    console.error(e);
    await cleanup(key);
    send({ type: "stream-failed", key, error: describeError(e) });
  }
}

// #if youtube
async function runYouTube(key, pageUrl, poBodies, liveFrom) {
  const abort = new AbortController();
  const fileNames = [];
  jobs.set(key, { stop: () => abort.abort(), fileNames });
  try {
    const video = await openYouTube(pageUrl, poBodies);
    if (abort.signal.aborted) throw new Error("中止しました");
    if (video.liveDash && liveFrom === "start") return run(key, null, "start", () => youtubeLiveSource(video.liveDash));
    if (video.liveManifest) return run(key, video.liveManifest, "now");
    let progress = 0;
    let bytes = 0;
    const startedAt = Date.now();
    const reporter = setInterval(() => {
      send({ type: "stream-progress", key, live: false, progress, seconds: (Date.now() - startedAt) / 1000, bytes });
    }, 1000);
    let result;
    try {
      result = await downloadYouTube(video, {
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
    if (!file.size) throw new Error("データがありません");
    const blobUrl = URL.createObjectURL(new Blob([file], { type: "video/mp4" }));
    jobs.get(key).url = blobUrl;
    send({ type: "stream-done", key, files: [{ url: blobUrl, suffix: "", ext: ".mp4" }] });
  } catch (e) {
    console.error(e);
    await cleanup(key);
    send({ type: "stream-failed", key, error: `YouTube: ${e?.message ?? e}` });
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
  if (message.type === "stream") run(message.key, message.url, message.liveFrom);
  // #if youtube
  if (message.type === "youtube") runYouTube(message.key, message.url, message.poBodies, message.liveFrom);
  // #endif
  if (message.type === "stop") jobs.get(message.key)?.stop();
  if (message.type === "revoke") cleanup(message.key);
});
