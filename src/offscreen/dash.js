// DASH support for Mediabunny, which reads HLS but not DASH: mpd-parser turns
// the MPD into HLS-style playlists, which are served to Mediabunny as virtual
// .m3u8 files through a CustomPathedSource. Segment URLs stay the real ones.
// Live (dynamic) MPDs are re-parsed whenever Mediabunny refreshes a playlist.

import { CustomPathedSource, BufferSource, UrlSource } from "mediabunny";
import { parse, addSidxSegmentsToPlaylist } from "mpd-parser";
import parseSidx from "mux.js/lib/tools/parse-sidx";
import { UserError } from "./errors.js";

const VIRTUAL = "https://bvdl.invalid/";

class DrmError extends UserError {
  constructor() {
    super("errDrm");
  }
}

export const isMpd = (text) => /<MPD[\s>]/.test(text.slice(0, 4096));

// The best video no taller than `maxHeight` (else the smallest) and the best
// audio; `audioOnly` keeps just the audio when there is a separate one.
function pickVariants(manifest, { maxHeight = Infinity, audioOnly = false } = {}) {
  const height = (p) => p.attributes.RESOLUTION?.height ?? 0;
  const byBandwidth = [...manifest.playlists].sort((a, b) => (b.attributes.BANDWIDTH ?? 0) - (a.attributes.BANDWIDTH ?? 0));
  let video = byBandwidth.find((p) => height(p) <= maxHeight) ?? byBandwidth.sort((a, b) => height(a) - height(b))[0];
  const audioPlaylists = Object.values(manifest.mediaGroups?.AUDIO ?? {})
    .flatMap((group) => Object.values(group))
    .sort((a, b) => Number(b.default) - Number(a.default))
    .flatMap((rendition) => rendition.playlists ?? []);
  const audio = audioPlaylists.sort((a, b) => (b.attributes.BANDWIDTH ?? 0) - (a.attributes.BANDWIDTH ?? 0))[0];
  if (audioOnly && audio) video = undefined;
  for (const p of [video, audio]) {
    if (p?.contentProtection && Object.keys(p.contentProtection).length) throw new DrmError();
  }
  return { video, audio };
}

// SegmentBase representations list their segments in a sidx box.
async function resolveSidx(playlist, fetchInit) {
  if (!playlist?.sidx || playlist.segments?.length) return;
  const { resolvedUri, byterange } = playlist.sidx;
  const res = await fetch(resolvedUri, {
    ...fetchInit,
    headers: { Range: `bytes=${byterange.offset}-${byterange.offset + byterange.length - 1}` },
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  addSidxSegmentsToPlaylist(playlist, parseSidx(bytes.subarray(8)), resolvedUri);
}

const attr = (value) => `"${String(value).replace(/"/g, "")}"`;
const range = (r) => `${r.length}@${r.offset ?? 0}`;

function masterPlaylist({ video, audio }) {
  const lines = ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS"];
  if (audio && video) {
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"`);
  }
  const main = video ?? audio;
  const a = main.attributes;
  const inf = [`BANDWIDTH=${a.BANDWIDTH ?? 1}`];
  const codecs = [a.CODECS, video && audio?.attributes.CODECS].filter(Boolean).join(",");
  if (codecs) inf.push(`CODECS=${attr(codecs)}`);
  if (a.RESOLUTION) inf.push(`RESOLUTION=${a.RESOLUTION.width}x${a.RESOLUTION.height}`);
  if (audio && video) inf.push(`AUDIO="audio"`);
  lines.push(`#EXT-X-STREAM-INF:${inf.join(",")}`, video ? "video.m3u8" : "audio.m3u8");
  return lines.join("\n") + "\n";
}

// mpd-parser numbers live segments from 0 within the current window, so the
// window slides without its numbers changing and an HLS reader would never see
// new segments. Each segment URL instead keeps the number it got when first seen.
function mediaPlaylist(playlist, sequences) {
  const segments = playlist.segments ?? [];
  for (const s of segments) {
    if (!sequences.has(s.resolvedUri)) sequences.set(s.resolvedUri, sequences.size);
  }
  const target = Math.ceil(Math.max(1, ...segments.map((s) => s.duration)));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${target}`,
    `#EXT-X-MEDIA-SEQUENCE:${segments.length ? sequences.get(segments[0].resolvedUri) : 0}`,
  ];
  let map = null;
  for (const s of segments) {
    if (s.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
    const mapKey = s.map && `${s.map.resolvedUri}|${s.map.byterange ? range(s.map.byterange) : ""}`;
    if (mapKey && mapKey !== map) {
      map = mapKey;
      lines.push(`#EXT-X-MAP:URI=${attr(s.map.resolvedUri)}${s.map.byterange ? `,BYTERANGE=${attr(range(s.map.byterange))}` : ""}`);
    }
    lines.push(`#EXTINF:${s.duration.toFixed(6)},`);
    if (s.byterange) lines.push(`#EXT-X-BYTERANGE:${range(s.byterange)}`);
    lines.push(s.resolvedUri);
  }
  if (playlist.endList) lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

export function dashSource(mpdUrl, firstText, fetchInit, sourceOptions, quality) {
  let text = firstText;
  let fetchedAt = Date.now();
  let serverOffset = 0;
  const sequences = { video: new Map(), audio: new Map() };

  async function load() {
    if (Date.now() - fetchedAt > 1000) {
      const res = await fetch(mpdUrl, fetchInit);
      text = await res.text();
      fetchedAt = Date.now();
      const date = Date.parse(res.headers.get("date") ?? "");
      if (date) serverOffset = date - fetchedAt;
    }
    const manifest = parse(text, { manifestUri: mpdUrl, NOW: Date.now(), clientOffset: serverOffset });
    const variants = pickVariants(manifest, quality);
    if (!variants.video && !variants.audio) throw new UserError("errMpdNoTracks");
    await Promise.all([resolveSidx(variants.video, fetchInit), resolveSidx(variants.audio, fetchInit)]);
    return variants;
  }

  const playlistBytes = (s) => new BufferSource(new TextEncoder().encode(s));

  return new CustomPathedSource(`${VIRTUAL}master.m3u8`, async ({ path }) => {
    if (!path.startsWith(VIRTUAL)) return new UrlSource(path, sourceOptions);
    const variants = await load();
    switch (path.slice(VIRTUAL.length)) {
      case "master.m3u8":
        return playlistBytes(masterPlaylist(variants));
      case "video.m3u8":
        return playlistBytes(mediaPlaylist(variants.video ?? variants.audio, sequences.video));
      case "audio.m3u8":
        return playlistBytes(mediaPlaylist(variants.audio, sequences.audio));
      default:
        throw new Error(`unknown virtual path ${path}`);
    }
  });
}
