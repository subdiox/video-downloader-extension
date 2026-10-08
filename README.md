# Video Downloader

A Chrome extension (Manifest V3) that saves the videos playing on the current page.

- Plain video files (MP4, WebM, …)
- HLS (MPEG-TS / fMP4, AES-128, separate audio tracks, live)
- DASH (SegmentTemplate / SegmentList / SegmentBase, live)
- Players without a manifest that fetch whole media files in pieces (TikTok, Instagram, Facebook, bilibili, …): the video and audio files they fetched are merged
- YouTube, the way yt-dlp does it: best video + best audio merged, live streams included (full edition only)

Streams are saved as a single MP4 with video and audio merged, copied without re-encoding. No ffmpeg needed.

The UI is in English and Japanese, following the browser's language (`chrome.i18n`; messages in `extension/_locales`). The store build drops the YouTube-only `yt_*` messages.

## Editions

Two editions are built from the same source.

| Edition | Contents | Distribution |
|---|---|---|
| full | Everything, including YouTube | This repository (build it and load it unpacked) |
| store | Everything except YouTube | Chrome Web Store |

YouTube-only code is wrapped in `// #if youtube` … `// #endif` (`<!-- #if youtube -->` … `<!-- #endif -->` in HTML). The store build drops those blocks, the YouTube modules and the sandbox page.

## Setup

```sh
npm install
npm run build     # builds extension/dist (full edition)
```

Open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `extension/`.
After changing `src/`, run `npm run build` (or keep `npm run watch` running) and reload the extension.

Distributable ZIPs:

```sh
npm run package   # build/full, build/store and build/video-downloader-{full,store}-<version>.zip
```

## Usage

Click the toolbar button to list the videos on the current page, including embedded iframes.

- Each video shows a thumbnail, title, type (MP4 / HLS / DASH), resolution, length and whether it is playing. Hovering an item outlines that video on the page.
- The title is editable and becomes the file name.
- Pick a quality per download: best, a maximum resolution (1080p, 720p, …; the shorter side, so a 1080×1920 portrait video is 1080p) or audio only (saved as `.m4a`). The last choice is remembered. Players without a manifest can only save what they fetched.
- Players fed through `blob:` or `srcObject` (MSE) are paired with the HLS / DASH manifests their frame loaded, or else with the media files it fetched (only files as long as that player's video are used, so preloaded neighbours and ads are left out). If nothing is found, start playback and reopen the popup.
- DRM-protected streams are listed with their buttons disabled.
- Live streams can be recorded from now (the live edge) or rewound as far as the stream allows (its DVR window; YouTube DVR streams from their very start). Stop and save from the downloads section.
- Videos that look like ads (ad-server URLs, short clips covering the main player) are tagged and listed last.
- YouTube: play the video in the tab for a moment before opening the popup; the extension reuses the PO token YouTube's own player minted. If YouTube refuses partway, play a little longer and try again.
- Errors, recordings and finished downloads are reported as system notifications; clicking "Saved" shows the file.
- Failed requests (network errors, 5xx, 429) are retried a few times with backoff.

Files are saved to `Downloads/<title>.mp4` (Chrome numbers duplicates).

## Layout

| File | Role |
|---|---|
| `extension/background.js` | Queue, DNR rules (Referer/Origin), manifest detection |
| `extension/popup.html` / `popup.js` | Toolbar popup (video list, progress) |
| `src/offscreen/main.js` | HLS/DASH → MP4 with Mediabunny, written to OPFS |
| `src/offscreen/dash.js` | Turns an MPD into virtual HLS playlists for Mediabunny (mpd-parser) |
| `src/offscreen/youtube.js` | YouTube via youtubei.js: formats, signature/n deciphering, ranged downloads, merge (live: the ANDROID client's HLS) |
| `src/offscreen/youtube-live.js` | YouTube live from the start, like yt-dlp's `--live-from-start` (DASH segments by sequence number) |
| `src/sandbox/main.js` | Sandbox page where eval is allowed (runs YouTube's player JS for deciphering) |
| `scripts/build.mjs` | Builds the full and store editions |

## Development bridge

`extension/` (not the packaged editions) carries a small bridge for testing in a real, logged-in Chrome profile: pages on `localhost` / `127.0.0.1` can call `chrome.runtime.sendMessage(<extension id>, { cmd, ... })` to reload the extension, open the popup for a tab and press its buttons, read the queue, progress and recent downloads, stop a recording, and delete test downloads. See the `#if dev` block in `extension/background.js`. The packaged builds drop it, together with the manifest's `externally_connectable`.

Libraries: [Mediabunny](https://mediabunny.dev) (MPL-2.0), [mpd-parser](https://github.com/videojs/mpd-parser) and [mux.js](https://github.com/videojs/mux.js) (Apache-2.0; mux.js only for sidx parsing), [youtubei.js](https://github.com/LuanRT/YouTube.js) and [googlevideo](https://github.com/LuanRT/googlevideo) (MIT; googlevideo reads the PO token from the player's requests). Each build writes `dist/THIRD_PARTY_LICENSES.txt` with the license of every bundled package.

## Supported sites

Tested by hand (October 2026). Other sites using the same kinds of players usually work too.

- YouTube (full edition only)
- X
- Instagram
- Facebook
- TikTok
- bilibili
- Twitch (live and VODs)
- Niconico
- TVer
- Dailymotion
- Vimeo
- Reddit

## Not supported

- DRM (Widevine / FairPlay / PlayReady, SAMPLE-AES, CENC): detected and refused. This rules out, for example:
  - ABEMA (checked)
  - Netflix, Amazon Prime Video, Disney+, Hulu, U-NEXT, DAZN, Apple TV+, Lemino, FOD, Crunchyroll (known to use DRM; not tried)
- Rewinding YouTube live streams that have DVR disabled
- Streams whose audio format changes midway (e.g. inserted ads) may have garbled audio in that section, since everything goes into one audio track

## License

[MIT](LICENSE). Bundled third-party packages keep their own licenses; see `dist/THIRD_PARTY_LICENSES.txt` in a build.
