// YouTube live from the start, like yt-dlp's --live-from-start: the ANDROID
// client's live DASH manifest names each representation's base URL, and
// segment N is `<base>sq/N` (self-contained: each carries its own moov). The
// server keeps segments back to the start of a DVR-enabled stream, beyond the
// window the MPD lists, and reports the newest in the x-head-seqnum header.
// The segments are served to Mediabunny as virtual HLS playlists, which grow
// as the stream does. Without a PO token googlevideo refuses a base URL after
// ~300 MB; like yt-dlp, a fresh manifest then gives new URLs to carry on with.

import { BufferSource, CustomPathedSource } from "mediabunny";
import { UserError } from "./errors.js";

const VIRTUAL = "https://bvdl.invalid/";

function representations(mpd) {
  const doc = new DOMParser().parseFromString(mpd, "application/xml");
  const reps = [];
  for (const set of doc.getElementsByTagName("AdaptationSet")) {
    const mime = set.getAttribute("mimeType") ?? "";
    for (const rep of set.getElementsByTagName("Representation")) {
      const base = rep.getElementsByTagName("BaseURL")[0]?.textContent;
      if (!base || !mime.endsWith("/mp4")) continue;
      reps.push({
        kind: mime.split("/")[0],
        base,
        bandwidth: Number(rep.getAttribute("bandwidth")) || 0,
        codecs: rep.getAttribute("codecs"),
        width: rep.getAttribute("width"),
        height: rep.getAttribute("height"),
      });
    }
  }
  const best = (kind) => reps.filter((r) => r.kind === kind).sort((a, b) => b.bandwidth - a.bandwidth)[0];
  return { video: best("video"), audio: best("audio") };
}

const itag = (url) => url.match(/\/itag\/(\d+)\//)?.[1];

function segmentSeconds(mpd) {
  const timescale = Number(mpd.match(/<SegmentList[^>]*timescale="(\d+)"/)?.[1]) || 1000;
  const d = Number(mpd.match(/<S d="(\d+)"/)?.[1]);
  return d ? d / timescale : 1;
}

/** `getMpdUrl()` returns a fresh live DASH manifest URL. */
export async function youtubeLiveSource(getMpdUrl) {
  let mpd = await (await fetch(await getMpdUrl())).text();
  let reps = representations(mpd);
  const { video, audio } = reps;
  if (!video || !audio) throw new UserError("yt_errLiveTracks");
  const seconds = segmentSeconds(mpd);

  let refreshing = null;
  const refresh = () =>
    (refreshing ??= (async () => {
      mpd = await (await fetch(await getMpdUrl())).text();
      const next = representations(mpd);
      // Keep the same representations; only their URLs change.
      for (const kind of ["video", "audio"]) {
        const same = [...mpd.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/g)].map((m) => m[1]).find((u) => itag(u) === itag(reps[kind].base));
        reps[kind] = { ...reps[kind], base: same ?? next[kind].base };
      }
    })().finally(() => (refreshing = null)));

  async function segment(kind, sq) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${reps[kind].base}sq/${sq}`).catch((e) => ({ ok: false, status: 0, error: e }));
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      await res.body?.cancel();
      if (attempt >= 5) throw new UserError("yt_errLiveSegment", sq, res.status);
      if (res.status === 403) await refresh();
      else await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  let head = -1;
  let checkedAt = 0;
  async function headSeq() {
    if (Date.now() - checkedAt > seconds * 1000) {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${reps.video.base}sq/${Math.max(head, 0)}`, { headers: { Range: "bytes=0-0" } });
        await res.body?.cancel();
        const seq = Number(res.headers.get("x-head-seqnum"));
        if (res.ok && Number.isFinite(seq)) {
          head = seq;
          break;
        }
        if (res.status !== 403 || attempt >= 2) throw new UserError("yt_errLivePosition", res.status);
        await refresh();
      }
      checkedAt = Date.now();
    }
    return head;
  }

  const master = [
    "#EXTM3U",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=${video.bandwidth + audio.bandwidth},CODECS="${video.codecs},${audio.codecs}",RESOLUTION=${video.width}x${video.height},AUDIO="audio"`,
    "video.m3u8",
  ].join("\n");

  async function mediaPlaylist(kind) {
    const last = await headSeq();
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${Math.ceil(seconds)}`, "#EXT-X-MEDIA-SEQUENCE:0"];
    for (let sq = 0; sq <= last; sq++) lines.push(`#EXTINF:${seconds.toFixed(3)},`, `${kind}/${sq}.mp4`);
    return lines.join("\n") + "\n";
  }

  const bytes = (s) => new BufferSource(new TextEncoder().encode(s));
  return new CustomPathedSource(`${VIRTUAL}master.m3u8`, async ({ path }) => {
    const name = path.slice(VIRTUAL.length);
    const seg = name.match(/^(video|audio)\/(\d+)\.mp4$/);
    if (seg) return new BufferSource(await segment(seg[1], Number(seg[2])));
    switch (name) {
      case "master.m3u8":
        return bytes(master);
      case "video.m3u8":
        return bytes(await mediaPlaylist("video"));
      case "audio.m3u8":
        return bytes(await mediaPlaylist("audio"));
      default:
        throw new Error(`unknown virtual path ${path}`);
    }
  });
}
