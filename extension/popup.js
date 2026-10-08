// Toolbar popup: lists the videos on the current page (all frames) with a
// thumbnail, title and details so the right one can be picked, plus the
// downloads in progress.
//
// Videos with a plain file URL are downloaded as files. Videos played through
// MSE (blob: src) are paired with the HLS/DASH manifests their frame loaded,
// which the service worker records via webRequest.

// ?tabId= targets a specific tab when the popup is opened as a page (debugging).
const tabIdParam = Number(new URLSearchParams(location.search).get("tabId"));
const tab = tabIdParam ? await chrome.tabs.get(tabIdParam) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
const $ = (id) => document.getElementById(id);

// --- Page inspection (runs inside each frame) ---------------------------------

function inspectVideos() {
  const quality = (s) => {
    const label = ["title", "label", "res", "size", "data-quality"].map((a) => s.getAttribute(a) ?? "").join(" ");
    const height = Number(label.match(/(\d{3,4})p?/)?.[1]) || 0;
    return height || (/\b(4k|uhd)\b/i.test(label) ? 2160 : /\bfhd\b/i.test(label) ? 1080 : /\bhd\b/i.test(label) ? 720 : /\bsd\b/i.test(label) ? 480 : 0);
  };
  const clean = (text) => text?.replace(/\s+/g, " ").trim().slice(0, 150) || null;
  const docTitle = clean(document.querySelector('meta[property="og:title"]')?.content) || clean(document.title);

  // Player UIs label their containers ("Video Player", "Playing in
  // picture-in-picture"), so container aria-labels are never used and such
  // generic labels on the <video> itself are ignored.
  const generic = /^(video|video player|player|media|movie|動画|動画プレーヤー|プレーヤー)$|picture-in-picture|^playing\b/i;
  const label = (text) => {
    const t = clean(text);
    return t && !generic.test(t) ? t : null;
  };
  const ownTitle = (v) => label(v.getAttribute("title")) || label(v.getAttribute("aria-label")) || label(v.dataset.title);

  // The nearest caption/heading around the player, walking up a few levels.
  // Only used when a frame has several videos; otherwise the page title wins.
  function nearTitle(v) {
    let el = v.parentElement;
    for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
      const caption = el.querySelector("figcaption, h1, h2, h3, [class*='title' i]:not(script):not(style)");
      if (caption && !caption.contains(v)) {
        const text = label(caption.textContent);
        if (text) return text;
      }
    }
    return null;
  }

  function thumbnail(v) {
    if (v.poster) return v.poster;
    if (v.readyState < 2 || !v.videoWidth) return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 192;
      canvas.height = Math.round((192 * v.videoHeight) / v.videoWidth);
      canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.7);
    } catch {
      return null; // cross-origin video without CORS taints the canvas
    }
  }

  return [...document.querySelectorAll("video")].map((v, index) => {
    const best = [...v.querySelectorAll("source[src]")].sort((a, b) => quality(b) - quality(a))[0];
    const r = v.getBoundingClientRect();
    return {
      index,
      src: (best && quality(best) && best.src) || v.currentSrc || v.src || best?.src || "",
      ownTitle: ownTitle(v),
      nearTitle: nearTitle(v),
      docTitle,
      thumb: thumbnail(v),
      width: v.videoWidth,
      height: v.videoHeight,
      duration: Number.isFinite(v.duration) ? v.duration : v.duration === Infinity ? Infinity : null,
      playing: !v.paused && !v.ended,
      area: r.width * r.height,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      frameUrl: location.href,
    };
  });
}

// Marks a video on the page while its entry is hovered in the popup.
function highlightVideo(index, on) {
  document.getElementById("__bvdl_highlight")?.remove();
  cancelAnimationFrame(globalThis.__bvdlHighlightFrame);
  if (!on) return;
  const v = document.querySelectorAll("video")[index];
  if (!v) return;
  v.scrollIntoView({ block: "nearest", inline: "nearest" });
  const box = document.createElement("div");
  box.id = "__bvdl_highlight";
  box.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #2f6fde;border-radius:6px;box-shadow:0 0 0 9999px rgba(0,0,0,.35);transition:all .1s";
  document.documentElement.append(box);
  const follow = () => {
    const r = v.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    globalThis.__bvdlHighlightFrame = requestAnimationFrame(follow);
  };
  follow();
}

// Fetches manifests from the frame that loaded them, so Referer, cookies and
// CORS are what the player had. Players usually fetch without credentials
// (CDNs often answer CORS with "*", which rejects credentialed requests), so
// that goes first; cookie-gated manifests get a second try with credentials.
async function fetchManifests(urls) {
  const get = async (url, credentials) => {
    try {
      const res = await fetch(url, { credentials, signal: AbortSignal.timeout(8000) });
      return res.ok ? (await res.text()).slice(0, 500_000) : null;
    } catch {
      return null;
    }
  };
  return Promise.all(urls.map(async (url) => (await get(url, "same-origin")) ?? (await get(url, "include"))));
}

// Frame fetch failed or the frame is gone: try from the popup, whose host
// permissions bypass CORS (no page Referer, though).
async function fetchMissing(urls, texts) {
  const missing = urls.map((url, i) => (texts?.[i] == null ? url : null));
  const fetched = await fetchManifests(missing.map((u) => u ?? "data:,"));
  return urls.map((_, i) => texts?.[i] ?? (missing[i] ? fetched[i] : null));
}

// --- Manifest parsing ----------------------------------------------------------

const DRM_KEY = /#EXT-X-(SESSION-)?KEY:[^\n]*(METHOD=SAMPLE-AES|KEYFORMAT="(?!identity")[^"]*")/;

function parseIsoDuration(value) {
  const m = value?.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : null;
}

function parseManifest(url, text) {
  const isDash = /\.mpd(\?|#|$)/i.test(url) || /<MPD[\s>]/.test(text ?? "");
  const info = { url, type: isDash ? "DASH" : "HLS", children: [] };
  if (!text) return { ...info, unknown: true };

  if (isDash) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const mpd = doc.documentElement;
    const heights = [...doc.getElementsByTagNameNS("*", "Representation")].map((r) => Number(r.getAttribute("height")) || 0);
    return {
      ...info,
      live: mpd.getAttribute("type") === "dynamic",
      drm: doc.getElementsByTagNameNS("*", "ContentProtection").length > 0,
      height: Math.max(0, ...heights) || null,
      duration: parseIsoDuration(mpd.getAttribute("mediaPresentationDuration")),
    };
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (text.includes("#EXT-X-STREAM-INF")) {
    const heights = [];
    lines.forEach((line, i) => {
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        heights.push(Number(line.match(/RESOLUTION=\d+x(\d+)/)?.[1]) || 0);
        const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
        if (uri) info.children.push(new URL(uri, url).href);
      }
      const media = line.startsWith("#EXT-X-MEDIA:") && line.match(/URI="([^"]+)"/);
      if (media) info.children.push(new URL(media[1], url).href);
    });
    return { ...info, master: true, height: Math.max(0, ...heights) || null, drm: DRM_KEY.test(text) };
  }

  const duration = [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  return {
    ...info,
    live: !text.includes("#EXT-X-ENDLIST") && !text.includes("#EXT-X-PLAYLIST-TYPE:VOD"),
    drm: DRM_KEY.test(text),
    aes: /METHOD=AES-128/.test(text),
    duration,
  };
}

// --- Collecting entries -----------------------------------------------------

// #if youtube
// YouTube serves no manifest (SABR); the offscreen document downloads it the
// way yt-dlp does, given just the page URL.
const isYouTube = (pageUrl) => /^https:\/\/(www|m)\.youtube\.com\//.test(pageUrl);
function youtubeVideoId(pageUrl) {
  try {
    const u = new URL(pageUrl);
    if (!/(^|\.)youtube\.com$|^youtu\.be$/.test(u.hostname)) return null;
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (u.pathname === "/watch") return u.searchParams.get("v");
    return u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/)?.[2] ?? null;
  } catch {
    return null;
  }
}
// #endif

// A frame that never answers (e.g. a stalled ad iframe) must not hang the popup.
const withTimeout = (promise, ms = 10_000) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

async function inFrame(frameId, func, args = []) {
  const [result] = await withTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, func, args }));
  return result?.result;
}

// --- Ads -------------------------------------------------------------------
// Pre-roll ads are separate videos/streams on the same page. They are flagged
// and sorted last rather than hidden, since the guess can be wrong.

const AD_URL =
  /(^|[./])(2mdn\.net|doubleclick\.net|googlesyndication\.com|googleadservices\.com|imasdk\.googleapis\.com|adnxs\.com|amazon-adsystem\.com|fwmrm\.net|springserve|spotxchange|innovid|teads|tremorhub|smartadserver)|[/._-](cm-ad|ads?|adserver|vast|preroll)[/._-]/i;
const urlLooksLikeAd = (...urls) => urls.some((u) => u && AD_URL.test(u));

// Live sorts above everything; unknown length sorts below known lengths.
const lengthKey = (seconds) => (seconds === Infinity ? 1e12 : seconds ?? 0);

async function loadStreams() {
  const { streams = {} } = await chrome.storage.session.get("streams");
  // The same manifest re-requested with a fresh token (?…) is one stream; keep the latest URL.
  const latest = new Map();
  for (const s of (streams[tab.id] ?? []).sort((a, b) => a.time - b.time)) {
    const key = `${s.frameId}|${s.url.replace(/[?#].*/, "")}`;
    latest.set(key, { ...s, time: latest.get(key)?.time ?? s.time });
  }
  const captured = [...latest.values()].sort((a, b) => a.time - b.time);
  const byFrame = Map.groupBy(captured, (s) => s.frameId);
  const parsed = [];
  for (const [frameId, list] of byFrame) {
    const urls = list.map((s) => s.url);
    const texts = await fetchMissing(urls, await inFrame(frameId, fetchManifests, [urls]).catch(() => null));
    const manifests = urls.map((url, i) => ({ ...parseManifest(url, texts?.[i]), frameId }));
    // A master playlist's details (live, duration, encryption) live in its variants.
    for (const m of manifests.filter((m) => m.master && m.children.length)) {
      const [text] = await fetchMissing([m.children[0]], await inFrame(frameId, fetchManifests, [[m.children[0]]]).catch(() => null));
      const variant = parseManifest(m.children[0], text);
      Object.assign(m, { live: variant.live, duration: variant.duration, aes: variant.aes, drm: m.drm || variant.drm });
    }
    parsed.push(...manifests);
  }
  // Variant/rendition playlists are parts of a master, not separate videos.
  // Live sites (e.g. Twitch) rotate variant URLs, so later ones no longer
  // match the master's list: in a frame with a master, hide every other HLS
  // playlist.
  const children = new Set(parsed.flatMap((m) => m.children));
  const masterFrames = new Set(parsed.filter((m) => m.master).map((m) => m.frameId));
  return parsed.filter((m) => {
    if (children.has(m.url)) return false;
    if (m.type === "HLS" && !m.master && masterFrames.has(m.frameId)) return false;
    return true;
  });
}

async function collectEntries() {
  const frames = await withTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: inspectVideos })).catch(
    () => []
  );
  const videos = frames.flatMap((f) => (f.result ?? []).map((v) => ({ ...v, frameId: f.frameId })));
  const streams = await loadStreams();
  const entries = [];

  for (const frameId of new Set([...videos.map((v) => v.frameId), ...streams.map((s) => s.frameId)])) {
    // A frame may load an ad stream before the real one; pair players with
    // non-ad, longest streams first.
    const frameStreams = streams
      .filter((s) => s.frameId === frameId)
      .sort((a, b) => urlLooksLikeAd(a.url) - urlLooksLikeAd(b.url) || lengthKey(b.live ? Infinity : b.duration) - lengthKey(a.live ? Infinity : a.duration));
    for (const v of videos.filter((v) => v.frameId === frameId)) {
      if (/^https?:/.test(v.src) && !/\.(m3u8|mpd)(\?|#|$)/i.test(v.src)) {
        entries.push({ kind: "file", video: v, url: v.src });
      } else if (/^https?:/.test(v.src)) {
        entries.push({ kind: "stream", video: v, url: v.src, manifest: parseManifest(v.src, null) });
      // #if youtube
      } else if (v.src.startsWith("blob:") && frameId === 0 && isYouTube(tab.url) && !entries.some((e) => e.kind === "youtube")) {
        entries.push({ kind: "youtube", video: v, url: tab.url });
      // #endif
      } else if (v.src.startsWith("blob:")) {
        // MSE players: pair the frame's videos with its manifests in load order.
        const manifest = frameStreams.shift();
        entries.push(manifest ? { kind: "stream", video: v, url: manifest.url, manifest } : { kind: "missing", video: v });
      }
    }
    for (const manifest of frameStreams) entries.push({ kind: "stream", url: manifest.url, manifest });
  }

  // #if youtube
  // YouTube's player knows which video it plays and whether it is live; the
  // page URL (e.g. /@channel/live) and its <video> may not say.
  const youtube = entries.find((e) => e.kind === "youtube");
  if (youtube) {
    const data = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          const player = document.getElementById("movie_player");
          const d = player?.getVideoData?.();
          const dvr = player?.getPlayerResponse?.()?.videoDetails?.isLiveDvrEnabled === true;
          return d && { id: d.video_id, live: d.isLive === true, dvr };
        },
      })
    ).then(([r]) => r?.result, () => null);
    const id = data?.id || youtubeVideoId(tab.url);
    if (id) {
      youtube.url = `https://www.youtube.com/watch?v=${id}`;
      youtube.live = data?.live;
      youtube.dvr = data?.dvr;
    } else {
      Object.assign(youtube, { kind: "missing", url: undefined });
    }
  }
  // #endif

  let topTitle = videos.find((v) => v.frameId === 0)?.docTitle || tab.title;
  // #if youtube
  topTitle = topTitle?.replace(/ - YouTube$/, "");
  // #endif
  // Hidden and ad players don't count: a page with one real video plus an ad
  // still takes the page title.
  const realVideos = videos.filter((v) => v.area > 0 && !urlLooksLikeAd(v.src, v.frameUrl));
  const videosInFrame = Map.groupBy(realVideos, (v) => v.frameId);
  for (const e of entries) {
    const v = e.video;
    const crowded = v && (videosInFrame.get(v.frameId)?.length ?? 0) > 1;
    e.title = v?.ownTitle || (crowded ? v.nearTitle : null) || (v && v.frameId !== 0 ? v.docTitle : null) || topTitle || "video";
  }
  // Same title for several entries: number them so they can be told apart.
  const counts = Map.groupBy(entries, (e) => e.title);
  for (const group of counts.values()) if (group.length > 1) group.forEach((e, i) => (e.title = `${e.title} (${i + 1})`));

  // A stream's own length beats the <video> element's: during an in-player
  // pre-roll the element reports the ad's duration.
  for (const e of entries) {
    const m = e.manifest;
    e.duration = m?.live || e.live ? Infinity : m?.duration || (Number.isFinite(e.video?.duration) || e.video?.duration === Infinity ? e.video.duration : null);
  }
  // A pre-roll plays on top of the main player: a short video covering a much
  // longer one in the same frame. Short clips elsewhere on the page are not ads.
  const overlap = (a, b) => {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 && (w * h) / Math.min(a.w * a.h, b.w * b.h) > 0.5;
  };
  const coversLonger = (e) =>
    e.duration != null &&
    e.duration <= 60 &&
    e.video?.area > 0 &&
    entries.some(
      (o) =>
        o !== e &&
        o.video?.frameId === e.video.frameId &&
        o.video.area > 0 &&
        lengthKey(o.duration) >= 3 * e.duration &&
        overlap(e.video.rect, o.video.rect)
    );
  for (const e of entries) e.ad = urlLooksLikeAd(e.url, e.video?.src, e.video?.frameUrl) || coversLonger(e);
  // Main content first: not an ad, then live/longest, then playing, then largest.
  entries.sort(
    (a, b) =>
      a.ad - b.ad ||
      lengthKey(b.duration) - lengthKey(a.duration) ||
      (b.video?.playing ?? 0) - (a.video?.playing ?? 0) ||
      (b.video?.area ?? 0) - (a.video?.area ?? 0)
  );
  return entries;
}

// --- Rendering -------------------------------------------------------------------

function formatTime(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function formatBytes(bytes) {
  if (!bytes) return null;
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

function tags(entry) {
  const v = entry.video;
  const m = entry.manifest;
  const out = [];
  // #if youtube
  if (entry.kind === "youtube") out.push(["YouTube"]);
  // #endif
  if (entry.kind === "file") out.push([new URL(entry.url).pathname.match(/\.(\w{2,4})$/)?.[1]?.toUpperCase() ?? "動画"]);
  if (m) out.push([m.type]);
  const height = v?.height || m?.height;
  if (height) out.push([`${height}p`]);
  if (entry.duration === Infinity) out.push(["ライブ", "warn"]);
  else {
    const time = formatTime(entry.duration);
    if (time) out.push([time]);
  }
  if (entry.ad) out.push(["広告の可能性", "warn"]);
  if (m?.aes) out.push(["AES-128"]);
  if (m?.drm) out.push(["DRM（非対応）", "warn"]);
  if (v?.playing) out.push(["再生中", "playing"]);
  if (v && v.frameId !== 0) out.push([`埋め込み: ${new URL(v.frameUrl).hostname}`]);
  return out.map(([text, cls]) => el("span", { className: `tag ${cls ?? ""}`, textContent: text }));
}

function renderEntry(entry) {
  const v = entry.video;
  const thumb = el("div", { className: "thumb" });
  const placeholder = () => thumb.replaceChildren(entry.manifest?.type ?? "VIDEO");
  if (v?.thumb) {
    thumb.style.backgroundImage = `url("${v.thumb.replace(/"/g, "%22")}")`;
  } else if (entry.kind === "file") {
    // Cross-origin frames can't be copied out of the page, but the popup can
    // show the file itself. Falls back to the placeholder if it won't load.
    const preview = el("video", { muted: true, preload: "metadata", src: `${entry.url}#t=1` });
    preview.addEventListener("error", placeholder);
    thumb.append(preview);
  } else {
    placeholder();
  }

  const title = el("input", { className: "title", value: entry.title, title: "保存するファイル名（編集できます）" });
  const live = entry.duration === Infinity;
  // Live streams: record from now, or from the oldest part the stream still
  // keeps (its DVR window, which may not reach the very start).
  let rewind = true;
  // #if youtube
  // YouTube streams without DVR can't be rewound.
  rewind = entry.kind !== "youtube" || entry.dvr;
  // #endif
  const buttons = live
    ? [
        el("button", { textContent: "今から録画", title: "押した時点から録画します" }),
        el("button", {
          className: "secondary",
          textContent: "さかのぼって録画",
          title: "配信をさかのぼれる範囲の一番古いところから録画します（サイトによっては配信の最初まで戻れません）",
        }),
      ].slice(0, rewind ? 2 : 1)
    : [el("button", { textContent: "ダウンロード" })];
  const note = el("span", { className: "note" });
  if (entry.kind === "missing") {
    note.textContent = "ストリームを検出できません。再生を始めてから開き直してください";
  }
  if (entry.kind === "missing" || entry.manifest?.drm) buttons.forEach((b) => (b.disabled = true));

  buttons.forEach((button, i) =>
    button.addEventListener("click", async () => {
      buttons.forEach((b) => (b.disabled = true));
      const { added } = await chrome.runtime.sendMessage({
        type: "enqueue-one",
        job: {
          kind: entry.kind,
          url: entry.url,
          documentUrl: v?.frameUrl ?? tab.url,
          pageUrl: tab.url,
          title: title.value.trim() || entry.title,
          sourceTabId: tab.id,
          liveFrom: live ? (i === 0 ? "now" : "start") : undefined,
        },
      });
      note.textContent = added ? "追加しました" : "すでに追加されています";
    })
  );

  const item = el(
    "div",
    { className: "item" },
    thumb,
    el("div", { className: "body" }, title, el("div", { className: "meta" }, ...tags(entry)), el("div", { className: "actions" }, ...buttons, note))
  );
  if (v) {
    item.addEventListener("mouseenter", () => inFrame(v.frameId, highlightVideo, [v.index, true]).catch(() => {}));
    item.addEventListener("mouseleave", () => inFrame(v.frameId, highlightVideo, [v.index, false]).catch(() => {}));
  }
  return item;
}

async function renderVideos() {
  const list = $("videos");
  const entries = await collectEntries();
  $("videos-heading").textContent = `このページの動画（${entries.length}）`;
  list.replaceChildren(...(entries.length ? entries.map(renderEntry) : [el("div", { className: "empty", textContent: "動画が見つかりません。再生を始めてから開き直してください" })]));
}

// --- Jobs ------------------------------------------------------------------

const progress = new Map(); // job url -> latest stream-progress message

async function renderJobs() {
  const { queue = [], active = {} } = await chrome.storage.session.get(["queue", "active"]);
  const rows = [
    ...Object.entries(active).map(([key, entry]) => ({ key, job: entry.job, entry })),
    ...queue.map((job) => ({ key: job.url, job, waiting: true })),
  ];
  $("jobs-section").hidden = !rows.length;
  const nodes = [];
  for (const row of rows) {
    const bar = el("div", { className: "bar" }, el("div"));
    const status = el("span", { className: "note" });
    let action = null;
    if (row.waiting) {
      bar.classList.add("waiting");
      status.textContent = "待機中";
    } else if (row.entry.live) {
      bar.classList.add("live");
      const p = progress.get(row.key);
      status.textContent = ["録画中", formatTime(p?.seconds ?? 0), formatBytes(p?.bytes)].filter(Boolean).join(" · ");
      action = el("button", { className: "stop", textContent: "停止して保存" });
      action.addEventListener("click", () => {
        action.disabled = true;
        chrome.runtime.sendMessage({ type: "stop-live", key: row.key });
      });
    } else if (row.entry.downloadId != null) {
      const [d] = await chrome.downloads.search({ id: row.entry.downloadId });
      const ratio = d?.totalBytes > 0 ? d.bytesReceived / d.totalBytes : 0;
      bar.firstChild.style.width = `${Math.round(ratio * 100)}%`;
      status.textContent = d?.totalBytes > 0 ? `${Math.round(ratio * 100)}%` : "保存中";
    } else {
      const p = progress.get(row.key);
      bar.firstChild.style.width = `${Math.round((p?.progress ?? 0) * 100)}%`;
      status.textContent = p ? [`${Math.round(p.progress * 100)}%`, formatBytes(p.bytes)].filter(Boolean).join(" · ") : "準備中";
    }
    const right = action ? el("div", { className: "actions" }, status, action) : status;
    nodes.push(el("div", { className: "job" }, el("span", { className: "name", textContent: row.job.title, title: row.job.title }), right, bar));
  }
  $("jobs").replaceChildren(...nodes);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "stream-progress") {
    progress.set(message.key, message);
    renderJobs();
  }
});
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.active || changes.queue) renderJobs();
});
setInterval(renderJobs, 1000); // file download progress comes from chrome.downloads

$("collect").addEventListener("click", async () => {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["collect.js"] });
  window.close(); // collect.js shows its own confirmation and progress in the page
});

renderJobs();
renderVideos().catch((e) => {
  console.error(e);
  $("videos").replaceChildren(el("div", { className: "empty", textContent: "このページでは使えません" }));
});
