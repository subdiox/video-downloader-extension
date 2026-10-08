// Download queue. State lives in chrome.storage.session so it survives
// service-worker suspension. Two kinds of job:
//
// file: a plain video file, downloaded by Chrome itself:
//   open a background tab -> add a DNR session rule scoped to that tab that
//   sets Referer and adds Content-Disposition: attachment -> navigate the tab
//   to the video -> the navigation turns into a download -> onDeterminingFilename
//   renames it.
//   chrome.downloads.download can't be used: its requests bypass DNR and
//   reject a Referer header, and many CDNs return 403 without one.
//
// stream: an HLS or DASH stream, converted to one MP4 by the offscreen
//   document (src/offscreen, built into dist/offscreen.js) with Referer/Origin
//   set by a DNR session rule, then saved from a blob: URL. Stream jobs share
//   that rule, so they only run together when their Referer matches. Live
//   streams record until stopped from the popup and don't take a concurrency
//   slot.

const CONCURRENCY = 2;
const STREAM_RULE_ID = 1;
const TAB_RULE_OFFSET = 2; // tab rule id = tabId + offset, never STREAM_RULE_ID

async function loadState() {
  const { queue = [], active = {} } = await chrome.storage.session.get(["queue", "active"]);
  return { queue, active };
}

async function saveState(state) {
  await chrome.storage.session.set(state);
  const entries = Object.values(state.active);
  const recording = entries.some((e) => e.live);
  const remaining = state.queue.length + entries.filter((e) => !e.live).length;
  await chrome.action.setBadgeText({ text: remaining ? String(remaining) : recording ? "REC" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: recording ? "#d32f2f" : "#555" });
  await chrome.action.setTitle({ title: chrome.i18n.getMessage(recording ? "actionTitleRecording" : "extName") });
}

// Serialize every state mutation so concurrent events don't clobber each other.
let lock = Promise.resolve();
function withState(fn) {
  const run = lock.then(async () => {
    const state = await loadState();
    const result = await fn(state);
    await saveState(state);
    return result;
  });
  lock = run.catch(() => {});
  return run;
}

function sanitize(name) {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120) || "video";
}

function filePath(job, ext) {
  return `${sanitize(job.title)}${ext}`;
}

// Jobs downloaded by the offscreen document (sharing its Referer/Origin rule).
const OFFSCREEN_KINDS = [
  "stream",
  "media",
  // #if youtube
  "youtube",
  // #endif
];
const isOffscreenJob = (job) => OFFSCREEN_KINDS.includes(job.kind);
const isStreamUrl = (url) => /\.(m3u8|mpd)(\?|#|$)/i.test(url);
const isStreamType = (contentType) => /mpegurl|dash\+xml/i.test(contentType);

// What the browser itself sends for a media request under the default
// strict-origin-when-cross-origin policy.
function referrerFor(mediaUrl, documentUrl) {
  try {
    const doc = new URL(documentUrl);
    if (!/^https?:$/.test(doc.protocol)) return null;
    doc.hash = "";
    return new URL(mediaUrl).origin === doc.origin ? doc.href : `${doc.origin}/`;
  } catch {
    return null;
  }
}

function tabRule(tabId, job) {
  const requestHeaders = job.referrer ? [{ header: "Referer", operation: "set", value: job.referrer }] : [];
  return {
    id: tabId + TAB_RULE_OFFSET,
    priority: 1,
    action: {
      type: "modifyHeaders",
      ...(requestHeaders.length && { requestHeaders }),
      responseHeaders: [{ header: "Content-Disposition", operation: "set", value: "attachment" }],
    },
    condition: { tabIds: [tabId], resourceTypes: ["main_frame"] },
  };
}

// Player requests are XHR/fetch from the page: page Referer plus a CORS Origin.
function streamRule(job) {
  return {
    id: STREAM_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: job.referrer },
        { header: "Origin", operation: "set", value: new URL(job.referrer).origin },
      ],
    },
    condition: {
      initiatorDomains: [chrome.runtime.id],
      tabIds: [chrome.tabs.TAB_ID_NONE],
      resourceTypes: ["xmlhttprequest"],
    },
  };
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Convert HLS/DASH streams to MP4 and hand them to chrome.downloads as blob URLs",
  });
}

// A message from the offscreen document: { key, substitutions } (which may
// nest) or plain text.
const t = (m) => (typeof m === "string" ? m : chrome.i18n.getMessage(m.key, m.substitutions.map(t)) || m.key);

// System notifications reach the user on any page (a script injected into the
// page could not run on the Web Store, PDFs or chrome:// pages). A "saved"
// notification is named after its download, so a click can reveal the file.
function notify(message, downloadId) {
  const id = downloadId != null ? `saved:${downloadId}` : "";
  chrome.notifications.create(id, { type: "basic", iconUrl: "icons/icon128.png", title: chrome.i18n.getMessage("extName"), message });
}

chrome.notifications.onClicked.addListener((id) => {
  const downloadId = Number(id.match(/^saved:(\d+)$/)?.[1]);
  if (downloadId) chrome.downloads.show(downloadId);
  chrome.notifications.clear(id);
});

// --- Queue ---------------------------------------------------------------

async function enqueue(jobs) {
  return withState(async (state) => {
    const known = new Set([...state.queue.map((j) => j.url), ...Object.keys(state.active)]);
    const added = jobs.filter((j) => !known.has(j.url) && known.add(j.url));
    state.queue.push(...added);
    await pump(state);
    return added.length;
  });
}

// state.active is keyed by the job URL. For file jobs that is also what
// DownloadItem.url reports (the URL before redirects).
async function pump(state) {
  const busy = () => Object.values(state.active).filter((e) => !e.live).length;
  for (let i = 0; i < state.queue.length && busy() < CONCURRENCY; ) {
    const job = state.queue[i];
    const streams = Object.values(state.active).filter((e) => isOffscreenJob(e.job));
    if (isOffscreenJob(job) && streams.some((e) => e.job.referrer !== job.referrer)) {
      i++;
      continue;
    }
    state.queue.splice(i, 1);
    await (isOffscreenJob(job) ? startStream(state, job, streams.length > 0) : startFile(state, job));
  }
}

async function startFile(state, job) {
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const rule = tabRule(tab.id, job);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule.id], addRules: [rule] });
  state.active[job.url] = { job, tabId: tab.id };
  await chrome.tabs.update(tab.id, { url: job.url });
}

async function startStream(state, job, ruleInPlace) {
  if (!ruleInPlace) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [STREAM_RULE_ID],
      addRules: job.referrer ? [streamRule(job)] : [],
    });
  }
  await ensureOffscreen();
  state.active[job.url] = { job, downloadIds: [] };
  let poBodies;
  // #if youtube
  if (job.kind === "youtube") {
    const { ytBodies = {} } = await chrome.storage.session.get("ytBodies");
    poBodies = (ytBodies[job.sourceTabId] ?? []).filter((b) => b.page === job.pageUrl).map((b) => b.body);
  }
  // #endif
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: job.kind,
    key: job.url,
    url: job.url,
    liveFrom: job.liveFrom,
    quality: job.quality,
    plain: job.plain,
    candidates: job.candidates,
    duration: job.duration,
    poBodies,
  });
}

async function releaseTab(entry) {
  if (entry.tabId == null) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [entry.tabId + TAB_RULE_OFFSET] }).catch(() => {});
  await chrome.tabs.remove(entry.tabId).catch(() => {});
  entry.tabId = null;
}

async function finish(state, url) {
  const entry = state.active[url];
  delete state.active[url];
  if (entry && isOffscreenJob(entry.job)) {
    chrome.runtime.sendMessage({ target: "offscreen", type: "revoke", key: url }).catch(() => {});
    if (!Object.values(state.active).some((e) => isOffscreenJob(e.job))) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [STREAM_RULE_ID] }).catch(() => {});
    }
  } else if (entry) {
    await releaseTab(entry);
  }
  await pump(state);
}

function findActive(state, pred) {
  return Object.entries(state.active).find(([, entry]) => pred(entry))?.[0];
}

// blob: URL -> filename for stream output. A listener here overrides the
// filename given to chrome.downloads.download, so it has to be suggested
// again. Kept in memory: the worker is busy handling the download meanwhile.
const blobFilenames = new Map();

chrome.downloads.onDeterminingFilename.addListener((download, suggest) => {
  const blobName = blobFilenames.get(download.url);
  if (blobName) {
    blobFilenames.delete(download.url);
    suggest({ filename: blobName, conflictAction: "uniquify" });
    return;
  }
  withState(async (state) => {
    const entry = state.active[download.url];
    if (!entry) return suggest();
    entry.downloadId = download.id;
    await releaseTab(entry);
    if (download.mime.startsWith("text/")) {
      // The server answered with a page (error, login wall) rather than a video.
      console.error("not a video", entry.job, download.mime);
      suggest();
      await chrome.downloads.cancel(download.id);
      await chrome.downloads.erase({ id: download.id });
      return finish(state, download.url);
    }
    const ext = download.filename.match(/\.(mp4|m4v|webm|mov|mkv|ogv)$/i)?.[0] ?? (download.mime === "video/webm" ? ".webm" : ".mp4");
    suggest({ filename: filePath(entry.job, ext), conflictAction: "uniquify" });
  }).catch((e) => {
    console.error(e);
    suggest();
  });
  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  const current = delta.state?.current;
  if (current !== "complete" && current !== "interrupted") return;
  withState(async (state) => {
    const url = findActive(state, (e) => e.downloadId === delta.id || e.downloadIds?.includes(delta.id));
    if (!url) return;
    const entry = state.active[url];
    if (current === "interrupted") console.warn("download interrupted", entry.job, delta.error?.current);
    else notify(chrome.i18n.getMessage("notifySaved", entry.job.title), delta.id);
    if (entry.downloadIds) {
      entry.downloadIds = entry.downloadIds.filter((id) => id !== delta.id);
      if (entry.downloadIds.length) return;
    }
    await finish(state, url);
  });
});

// A tab that commits an http(s) page never became a download: the server
// rejected the request (403 etc.). about:blank never reports an http URL.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !/^https?:/.test(tab.url ?? "")) return;
  withState(async (state) => {
    const url = findActive(state, (e) => e.tabId === tabId && e.downloadId == null);
    if (!url) return;
    console.error("not a download", state.active[url].job, tab.url);
    notify(chrome.i18n.getMessage("notifyRefused"));
    await finish(state, url);
  });
});

// Messages from the offscreen stream converter.
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "stream-progress":
      if (!message.live) chrome.action.setBadgeText({ text: `${Math.floor(message.progress * 100)}%` });
      break;

    case "stream-live":
      withState(async (state) => {
        const entry = state.active[message.key];
        if (!entry) return;
        entry.live = true;
        notify(chrome.i18n.getMessage("notifyRecording"));
        await pump(state);
      });
      break;

    case "stream-done":
      withState(async (state) => {
        const entry = state.active[message.key];
        if (!entry) return;
        entry.live = false;
        for (const f of message.files) {
          const filename = filePath(entry.job, `${f.suffix}${f.ext}`);
          blobFilenames.set(f.url, filename);
          entry.downloadIds.push(await chrome.downloads.download({ url: f.url, filename, conflictAction: "uniquify", saveAs: false }));
        }
      });
      break;

    case "stream-failed":
      withState(async (state) => {
        const entry = state.active[message.key];
        if (!entry) return;
        console.error("stream failed", entry.job, message.error);
        notify(t(message.error));
        await finish(state, message.key);
      });
      break;
  }
});

// --- Stream detection ---------------------------------------------------
// Players that use MSE expose only a blob: URL, so remember every HLS/DASH
// manifest each tab loads and pick one when the user asks for a download.
//
// Players without a manifest (TikTok, bilibili, Instagram, …) fetch whole
// media files piece by piece, by Range header or by byte-range query
// parameters. Those files are remembered too ("media"), with their total
// size; the offscreen document later picks the ones matching the player.

const sessionLocks = {};
// Read-modify-write of one storage.session key, serialized per key.
function withSession(key, fn) {
  const run = (sessionLocks[key] ?? Promise.resolve()).then(async () => {
    const { [key]: value = {} } = await chrome.storage.session.get(key);
    fn(value);
    await chrome.storage.session.set({ [key]: value });
  });
  sessionLocks[key] = run.catch(() => {});
  return run;
}
const withStreams = (fn) => withSession("streams", fn);
const withMedia = (fn) => withSession("media", fn);

// Query parameters some CDNs (Facebook, Instagram) use instead of a Range header.
const BYTE_RANGE_PARAMS = ["bytestart", "byteend", "range"];
// Small enough for a short clip's audio track; segments that slip through are
// dropped later because their length does not match the player's.
const MIN_MEDIA_FILE = 32 * 1024;

function mediaFile(d, type) {
  if (/mpegurl|dash\+xml|mp2t/i.test(type)) return null;
  const url = new URL(d.url);
  const isMedia = /^(video|audio)\//i.test(type) || (/octet-stream/i.test(type) && /\.(mp4|m4s|m4a|m4v|webm)$/i.test(url.pathname));
  if (!isMedia || /\.ts$/i.test(url.pathname)) return null;
  const header = (name) => d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
  const size = Number(header("content-range")?.split("/")[1]) || (d.statusCode === 200 ? Number(header("content-length")) : 0);
  if (!(size >= MIN_MEDIA_FILE)) return null;
  for (const p of BYTE_RANGE_PARAMS) url.searchParams.delete(p);
  return { url: url.href, frameId: d.frameId, size, type: type.split(";")[0], time: d.timeStamp };
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const type = d.responseHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
    if (isStreamType(type) || isStreamUrl(d.url)) {
      withStreams((streams) => {
        const list = (streams[d.tabId] ??= []);
        // A refetch (live playlists) keeps its place but counts as recent.
        const seen = list.find((s) => s.url === d.url);
        if (seen) return void (seen.time = d.timeStamp);
        list.push({ url: d.url, frameId: d.frameId, initiator: d.initiator, time: d.timeStamp });
        if (list.length > 30) list.splice(0, list.length - 30);
      });
      return;
    }
    const file = mediaFile(d, type);
    if (!file) return;
    withMedia((media) => {
      // Most recently fetched first: the playing video keeps fetching.
      const list = (media[d.tabId] ?? []).filter((m) => m.url !== file.url);
      media[d.tabId] = [file, ...list].slice(0, 30);
    });
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] },
  ["responseHeaders"]
);

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    withStreams((streams) => delete streams[d.tabId]);
    withMedia((media) => delete media[d.tabId]);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

// Single-page apps (X, Instagram, …) change the URL without loading a
// page: forget what the previous view fetched. A couple of seconds of slack
// keeps a new view's own requests, which may land just before the URL changes.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  const since = Date.now() - 2000;
  const keep = (lists) => {
    if (lists[tabId]) lists[tabId] = lists[tabId].filter((s) => s.time >= since);
  };
  withStreams(keep);
  withMedia(keep);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withStreams((streams) => delete streams[tabId]);
  withMedia((media) => delete media[tabId]);
  // #if youtube
  withYouTubeBodies((bodies) => delete bodies[tabId]);
  // #endif
});

// #if youtube
// --- YouTube PO tokens ---------------------------------------------------
// YouTube's own player mints a PO token for the video it plays and sends it
// inside its SABR requests (POST googlevideo.com/videoplayback). Keep the
// latest few request bodies per tab; the offscreen document decodes them and
// reuses that token for the download. Nothing is forged.

let ytLock = Promise.resolve();
function withYouTubeBodies(fn) {
  const run = ytLock.then(async () => {
    const { ytBodies = {} } = await chrome.storage.session.get("ytBodies");
    fn(ytBodies);
    await chrome.storage.session.set({ ytBodies });
  });
  ytLock = run.catch(() => {});
  return run;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    const raw = d.requestBody?.raw?.[0]?.bytes;
    if (d.tabId < 0 || d.method !== "POST" || !raw || raw.byteLength > 65536) return;
    const body = toBase64(raw);
    // Kept per page URL (YouTube navigates in place; /@channel/live has no
    // video ID in it).
    chrome.tabs.get(d.tabId).then((tab) => {
      const page = tab.url ?? "";
      if (!/^https:\/\/(www|m)\.youtube\.com\//.test(page)) return;
      withYouTubeBodies((bodies) => {
        const list = (bodies[d.tabId] ?? []).filter((b) => b.page === page);
        list.push({ page, body });
        bodies[d.tabId] = list.slice(-4);
      });
    }, () => {});
  },
  { urls: ["https://*.googlevideo.com/videoplayback*"] },
  ["requestBody"]
);
// #endif

// --- Entry points --------------------------------------------------------

function makeJob({ url, documentUrl, pageUrl, title, sourceTabId }) {
  return {
    kind: isStreamUrl(url) ? "stream" : "file",
    url,
    referrer: referrerFor(url, documentUrl),
    pageUrl,
    title,
    sourceTabId,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    // collect.js: jobs are { url, title, pageUrl } for each linked video page.
    case "enqueue": {
      const jobs = message.jobs.map((j) =>
        makeJob({ url: j.url, documentUrl: j.pageUrl, pageUrl: j.pageUrl, title: j.title, sourceTabId: sender.tab?.id })
      );
      enqueue(jobs).then((added) => sendResponse({ added }));
      return true;
    }
    // Popup: one entry the user picked. Its kind is known (a blob: player's
    // manifest may not end in .m3u8/.mpd).
    case "enqueue-one": {
      const j = message.job;
      const job = { ...makeJob(j), kind: j.kind, liveFrom: j.liveFrom, quality: j.quality, candidates: j.candidates, duration: j.duration };
      // Audio from a plain file: the offscreen document extracts it.
      if (job.kind === "file" && job.quality?.audioOnly) Object.assign(job, { kind: "stream", plain: true });
      enqueue([job]).then((added) => sendResponse({ added }));
      return true;
    }
    case "stop-live":
      chrome.runtime.sendMessage({ target: "offscreen", type: "stop", key: message.key }).catch(() => {});
      break;
  }
});

// #if dev
// --- Development bridge --------------------------------------------------
// extension/ only; packaged builds drop it. Pages on localhost drive the
// extension through chrome.runtime.sendMessage(<extension id>, { cmd, ... }),
// so it can be tested in a real, logged-in profile:
//   reload                              reload the extension
//   popup { tabId, click? }             open the popup for a tab, report its list;
//                                       click: { index, button, quality }
//   state { limit?, logs? }             queue, active jobs, latest downloads, notifications,
//                                       progress, offscreen devLog() lines
//   stop { key }                        stop a live recording and save it
//   remove-downloads { ids }            delete test downloads (file and entry)

const devPopups = new Map(); // id -> resolve(result)
const devProgress = {}; // job key -> latest stream-progress message
const devLogs = []; // offscreen devLog() lines and stream failures, newest last

chrome.runtime.onMessageExternal.addListener((m, sender, sendResponse) => {
  (async () => {
    switch (m.cmd) {
      case "reload":
        setTimeout(() => chrome.runtime.reload(), 100);
        return { ok: true };
      case "popup": {
        const id = crypto.randomUUID();
        const params = new URLSearchParams({ tabId: m.tabId, dev: id, click: JSON.stringify(m.click ?? null) });
        const result = new Promise((resolve) => devPopups.set(id, resolve));
        const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?${params}`), active: false });
        const timeout = new Promise((resolve) => setTimeout(() => resolve({ error: "popup timeout" }), 60_000));
        const out = await Promise.race([result, timeout]);
        devPopups.delete(id);
        chrome.tabs.remove(tab.id).catch(() => {});
        return out;
      }
      case "state": {
        const downloads = await chrome.downloads.search({ orderBy: ["-startTime"], limit: m.limit ?? 10 });
        return {
          ...(await chrome.storage.session.get(["queue", "active"])),
          downloads: downloads.map((d) => ({ id: d.id, state: d.state, error: d.error, filename: d.filename, mime: d.mime, bytes: d.bytesReceived })),
          notifications: await chrome.notifications.getAll(),
          progress: devProgress,
          logs: devLogs.slice(-(m.logs ?? 20)),
        };
      }
      case "stop":
        await chrome.runtime.sendMessage({ target: "offscreen", type: "stop", key: m.key }).catch(() => {});
        return { ok: true };
      case "remove-downloads":
        for (const id of m.ids) {
          await chrome.downloads.removeFile(id).catch(() => {});
          await chrome.downloads.erase({ id });
        }
        return { ok: true };
      default:
        return { error: `unknown cmd ${m.cmd}` };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "stream-progress") devProgress[m.key] = { progress: m.progress, seconds: Math.round(m.seconds), bytes: m.bytes };
  if (m.type === "dev-log") devLogs.push(m.text);
  if (m.type === "stream-failed") devLogs.push(`failed: ${JSON.stringify(m.error)}`);
  if (devLogs.length > 200) devLogs.splice(0, devLogs.length - 200);
  if (m.type === "dev-popup") devPopups.get(m.id)?.(m.result);
});
// #endif
