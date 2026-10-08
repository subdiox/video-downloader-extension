// YouTube, the way yt-dlp does it (via youtubei.js):
//   PO token -> InnerTube /player as the MWEB client -> best video + best
//   audio formats -> signature/n transformed by YouTube's player JS (in the
//   sandbox) -> ranged downloads into OPFS -> merged into one MP4 with
//   Mediabunny (copied, not re-encoded).
// Live streams use the player response's HLS manifest instead, recorded like
// any other live HLS stream; recording from the start goes through
// youtube-live.js.
// The PO token is the one YouTube's own player minted for this video in the
// user's tab: the service worker keeps that player's SABR request bodies and
// the token is read out of them here. Without it, googlevideo stops serving
// after the first ~1 MB.

import { Innertube, Platform } from "youtubei.js/web";
import { VideoPlaybackAbrRequest } from "googlevideo/protos";
import { ALL_FORMATS, BlobSource, Conversion, Input, Mp4OutputFormat, Output, StreamTarget } from "mediabunny";
import { callSandbox } from "./sandbox-bridge.js";

// youtubei.js ships no evaluator for browsers; the sandbox page may eval.
Platform.shim.eval = (data) => callSandbox("eval", { code: data.output });

// Like yt-dlp's http_chunk_size: googlevideo throttles long single requests.
const CHUNK = 10 * 1024 * 1024;
const CLIENT = "MWEB";
const LIVE_CLIENT = "ANDROID";

// The longest token wins. Before its real token is ready the player sends a
// short cold-start placeholder; for a short video it may never mint a real
// one. A placeholder still unlocks the first ~1-2 MB, enough for short videos.
function poTokenFromBodies(bodies = []) {
  let best = null;
  for (const b64 of bodies) {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const token = VideoPlaybackAbrRequest.decode(bytes).streamerContext?.poToken;
      if (token?.length && (!best || token.length > best.length)) best = token;
    } catch {}
  }
  if (!best) return null;
  return btoa(String.fromCharCode(...best)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function youtubeVideoId(pageUrl) {
  const u = new URL(pageUrl);
  if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (u.pathname === "/watch") return u.searchParams.get("v");
  return u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/)?.[2] ?? null;
}

async function contentLength(url, signal) {
  const res = await fetch(url, { headers: { Range: "bytes=0-0" }, signal });
  const total = Number(res.headers.get("content-range")?.split("/")[1]);
  await res.body?.cancel();
  if (!total) throw new Error(`ファイルサイズを取得できません (HTTP ${res.status})`);
  return total;
}

async function downloadFormat(url, total, handle, onBytes, signal) {
  const writable = await handle.createWritable();
  try {
    for (let start = 0; start < total; start += CHUNK) {
      const end = Math.min(start + CHUNK, total) - 1;
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
      if (res.status === 403) {
        throw new Error("YouTubeに途中で拒否されました。このタブで動画をしばらく再生してから、もう一度試してください");
      }
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status} (${start}-${end})`);
      const data = new Uint8Array(await res.arrayBuffer());
      await writable.write(data);
      onBytes(data.byteLength);
    }
  } finally {
    await writable.close();
  }
}

/**
 * Looks up `pageUrl`'s video. `poBodies` are base64 SABR request bodies from
 * the tab's player. For a live stream, `liveManifest` is its HLS manifest URL
 * and `liveDash()` returns a fresh DASH manifest URL (set only if the stream
 * can be recorded from its start).
 */
export async function openYouTube(pageUrl, poBodies) {
  const videoId = youtubeVideoId(pageUrl);
  if (!videoId) throw new Error("YouTubeの動画IDが見つかりません");

  const poToken = poTokenFromBodies(poBodies) ?? undefined;
  const yt = await Innertube.create({ po_token: poToken, retrieve_player: true, fetch: (input, init) => fetch(input, init) });
  const info = await yt.getBasicInfo(videoId, { client: CLIENT });
  const status = info.playability_status;
  if (status?.status !== "OK") throw new Error(`再生できない動画です: ${status?.reason ?? status?.status}`);

  let liveManifest = null;
  let liveDash = null;
  if (info.basic_info.is_live) {
    // The MWEB/WEB live manifests' segments are refused (403) or missing;
    // ANDROID's are served.
    const live = await yt.getBasicInfo(videoId, { client: LIVE_CLIENT });
    liveManifest = live.streaming_data?.hls_manifest_url;
    if (!liveManifest) throw new Error("ライブ配信のマニフェストがありません");
    // Like yt-dlp: the PO token goes into the manifest URL's path.
    if (poToken) liveManifest = `${liveManifest.replace(/\/$/, "")}/pot/${poToken}`;
    if (info.page[0].video_details?.is_live_dvr_enabled && live.streaming_data?.dash_manifest_url) {
      let first = live.streaming_data.dash_manifest_url;
      liveDash = async () => {
        const url = first ?? (await yt.getBasicInfo(videoId, { client: LIVE_CLIENT })).streaming_data?.dash_manifest_url;
        first = null;
        if (!url) throw new Error("ライブ配信のマニフェストがありません");
        return url;
      };
    }
  }
  return { yt, info, liveManifest, liveDash };
}

/**
 * Downloads an `openYouTube()` video (not live) into OPFS files named by
 * `newFile()` and returns the handle of the merged MP4. `onProgress(done,
 * total)` reports bytes.
 */
export async function downloadYouTube({ yt, info }, { dir, newFile, onProgress, signal }) {

  const video = info.chooseFormat({ type: "video", quality: "best", format: "any" });
  // Old videos' best format may already be muxed (video + audio in one file).
  const formats = video.has_audio ? [video] : [video, info.chooseFormat({ type: "audio", quality: "best", format: "any" })];
  const urls = await Promise.all(formats.map((f) => f.decipher(yt.session.player)));
  // Some (mostly older) formats omit contentLength; ask the server instead.
  const sizes = await Promise.all(formats.map((f, i) => Number(f.content_length) || contentLength(urls[i], signal)));

  const total = sizes.reduce((a, b) => a + b, 0);
  let done = 0;
  const parts = [];
  for (let i = 0; i < formats.length; i++) {
    const handle = await dir.getFileHandle(newFile(), { create: true });
    await downloadFormat(urls[i], sizes[i], handle, (n) => onProgress((done += n), total), signal);
    parts.push(handle);
  }

  // One conversion per input (video-only, audio-only) into the same output.
  const outHandle = await dir.getFileHandle(newFile(), { create: true });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(await outHandle.createWritable(), { chunked: true }) });
  const inputs = await Promise.all(parts.map(async (h) => new Input({ source: new BlobSource(await h.getFile()), formats: ALL_FORMATS })));
  const conversions = [];
  for (const input of inputs) conversions.push(await Conversion.init({ input, output, composable: true, showWarnings: false }));
  await output.start();
  await Promise.all(conversions.map((c) => c.execute()));
  await output.finalize();
  inputs.forEach((i) => i.dispose?.());
  return { handle: outHandle, title: info.basic_info.title };
}
