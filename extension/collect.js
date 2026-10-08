// Injected by the popup's "download every linked video" button: treats the
// current page as a listing (favorites, search results, uploads…), follows
// its pagination, opens every linked video page and queues the best plain
// video file of each.
// Works for sites that put the video URL in the page HTML (<video>/<source>,
// og:video); streaming-only (blob:) players are skipped.

(() => {
  if (globalThis.__bvdlCollecting) return;
  globalThis.__bvdlCollecting = true;

  const MAX_PAGES = 20;
  const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv)(\?|$)/i;

  let statusEl;
  function setStatus(text, { hideAfter } = {}) {
    statusEl ??= Object.assign(document.createElement("div"), {
      style: "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;background:#000d;color:#fff;padding:8px 14px;border-radius:6px;font:13px system-ui,sans-serif",
    });
    statusEl.textContent = text;
    document.documentElement.append(statusEl);
    if (hideAfter) setTimeout(() => statusEl.remove(), hideAfter);
  }

  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return new DOMParser().parseFromString(await res.text(), "text/html");
  }

  const sameOriginLinks = (doc) =>
    [...doc.querySelectorAll("a[href]")]
      .map((a) => {
        try {
          return { a, url: new URL(a.getAttribute("href"), location.href) };
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.url.origin === location.origin);

  // "/video/123/some-title" -> "/video/:n/*": numeric segments and slugs collapse,
  // so all items of one listing share a shape.
  const shapeOf = (pathname) =>
    pathname
      .split("/")
      .map((seg, i) => (/^\d+$/.test(seg) ? ":n" : i > 1 && seg ? "*" : seg))
      .join("/");

  // Video links = the most common shape among thumbnail links on this page.
  function videoShape(doc) {
    const counts = new Map();
    for (const { a, url } of sameOriginLinks(doc)) {
      if (!a.querySelector("img") || url.pathname === location.pathname) continue;
      const shape = shapeOf(url.pathname);
      counts.set(shape, (counts.get(shape) ?? 0) + 1);
    }
    const [shape, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    return count >= 2 ? shape : null;
  }

  function videoLinks(doc, shape) {
    const urls = sameOriginLinks(doc)
      .filter(({ url }) => shapeOf(url.pathname) === shape)
      .map(({ url }) => url.origin + url.pathname);
    return [...new Set(urls)];
  }

  // Finds "?page=N"-style or "/page/N"-style pagination links for this listing.
  function pagination(doc) {
    const base = location.pathname.replace(/\/(page\/)?\d+\/?$/, "");
    const byKey = new Map();
    for (const { url } of sameOriginLinks(doc)) {
      if (url.pathname === location.pathname || url.pathname === base) {
        for (const [key, value] of url.searchParams) {
          if (/^\d+$/.test(value)) (byKey.get(`?${key}`) ?? byKey.set(`?${key}`, []).get(`?${key}`)).push(Number(value));
        }
      }
      const m = url.pathname.match(/^(.*?)\/(page\/)?(\d+)\/?$/);
      if (m && m[1] === base) {
        const key = `/${m[2] ?? ""}`;
        (byKey.get(key) ?? byKey.set(key, []).get(key)).push(Number(m[3]));
      }
    }
    const [key, numbers] = [...byKey].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    if (!key) return null;
    const pageUrl = (n) => {
      const u = new URL(location.href);
      u.hash = "";
      if (key.startsWith("?")) {
        u.searchParams.set(key.slice(1), n);
      } else {
        u.pathname = `${base}${key}${n}`;
      }
      return u.href;
    };
    return { last: Math.max(...numbers), pageUrl };
  }

  function quality(s) {
    const label = ["title", "label", "res", "size", "data-quality"].map((a) => s.getAttribute(a) ?? "").join(" ");
    const height = Number(label.match(/(\d{3,4})p?/)?.[1]) || 0;
    return height || (/\b(4k|uhd)\b/i.test(label) ? 2160 : /\bfhd\b/i.test(label) ? 1080 : /\bhd\b/i.test(label) ? 720 : /\bsd\b/i.test(label) ? 480 : 0);
  }

  function parseVideoPage(doc, pageUrl) {
    const abs = (u) => (u ? new URL(u, pageUrl).href : null);
    const sources = [...doc.querySelectorAll("video source[src]")].sort((a, b) => quality(b) - quality(a));
    const ogVideo = ["og:video:secure_url", "og:video:url", "og:video"]
      .map((p) => doc.querySelector(`meta[property="${p}"]`)?.content)
      .find((u) => u && VIDEO_EXT.test(u));
    // Last resort for players configured from a script (`file: "…/index.m3u8"`),
    // including JSON-escaped slashes.
    const streamInScript = doc.documentElement.innerHTML
      .replace(/\\\//g, "/")
      .match(/https?:\/\/[^"'\s<>\\]+?\.(m3u8|mpd)[^"'\s<>\\]*/)?.[0]
      ?.replace(/&amp;/g, "&");
    const src =
      abs(sources[0]?.getAttribute("src")) ??
      abs(doc.querySelector("video[src]")?.getAttribute("src")) ??
      abs(ogVideo) ??
      streamInScript;
    if (!src || !/^https?:/.test(src)) return null;
    const title =
      doc.querySelector('meta[property="og:title"]')?.content?.trim() || doc.title.trim() || new URL(pageUrl).pathname;
    const id = new URL(pageUrl).pathname.match(/\/(\d+)(\/|$)/)?.[1];
    return { url: src, title: id && !title.includes(id) ? `${id} ${title}` : title, pageUrl };
  }

  async function run() {
    const shape = videoShape(document);
    if (!shape) return setStatus("このページに動画へのリンクが見つかりません", { hideAfter: 5000 });

    const pages = pagination(document);
    const followPages = pages && pages.last <= MAX_PAGES;
    const links = new Set(videoLinks(document, shape));
    if (followPages) {
      for (let n = 1; n <= pages.last; n++) {
        setStatus(`一覧を取得中… ${n}/${pages.last}`);
        videoLinks(await fetchDoc(pages.pageUrl(n)), shape).forEach((u) => links.add(u));
      }
    }

    const note = pages && !followPages ? `（${pages.last}ページあるため、このページのみ）` : "";
    setStatus("");
    statusEl.remove();
    if (!confirm(`${links.size}件の動画ページが見つかりました${note}。ダウンロードしますか？`)) return;

    const jobs = [];
    const failed = [];
    let i = 0;
    for (const url of links) {
      setStatus(`動画ページを解析中… ${++i}/${links.size}`);
      try {
        const job = parseVideoPage(await fetchDoc(url), url);
        job ? jobs.push(job) : failed.push(url);
      } catch (e) {
        console.error(e);
        failed.push(url);
      }
    }
    const { added } = await chrome.runtime.sendMessage({ type: "enqueue", jobs });
    setStatus(`${added}件をキューに追加` + (failed.length ? ` / 動画が取れなかったページ ${failed.length}件（コンソール参照）` : ""), { hideAfter: 6000 });
    if (failed.length) console.warn("[Video Downloader] no plain video found on", failed);
  }

  run()
    .catch((e) => {
      console.error(e);
      setStatus(`エラー: ${e.message}`, { hideAfter: 8000 });
    })
    .finally(() => {
      globalThis.__bvdlCollecting = false;
    });
})();
