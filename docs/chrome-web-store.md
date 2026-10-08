# Chrome Web Store submission notes (store edition)

Upload `build/video-downloader-store-<version>.zip`, created by `npm run package`.

## Listing

**Name**: Video Downloader

**Summary (max 132 characters)**
> Save videos playing on the current page: video files, HLS and DASH streams, and live-stream recording, merged into one MP4.

Japanese localization:
> 再生中の動画を保存。動画ファイル、HLS・DASH ストリーム、ライブ配信の録画に対応し、映像と音声を 1 本の MP4 にまとめます。

**Description**
> Click the toolbar button to see every video the current page can play, with thumbnail, title, resolution and length, and pick the one to save.
>
> - Video files such as MP4 and WebM
> - HLS (including AES-128) and DASH streams, saved as one MP4 with video and audio merged (no re-encoding)
> - Live-stream recording, from now or from as far back as the stream allows
> - Videos that look like ads are flagged, so the main video is easy to tell apart
> - Download every video linked from a listing page at once
>
> DRM-protected videos cannot be saved (the extension detects them and stops).
> Only use it for videos you own or are allowed to save.

**Category**: Productivity or Tools

**Screenshots**: 1280×800 or 640×400. Keep specific video sites' names, logos and copyrighted footage out of the description and screenshots; they are a common reason for rejection.

## Privacy practices tab

**Single purpose**
> Saving a video playing on the page the user is viewing to their computer, when the user asks for it.

**Permission justifications**

| Permission | Justification |
|---|---|
| `downloads` | Writes the saved video to the Downloads folder |
| `declarativeNetRequest` | Adds the page's Referer / Origin to the extension's own download requests, for video servers that require them |
| `offscreen` | Merges streams into an MP4 in a windowless extension page |
| `scripting` | When the popup opens, reads the page's video elements (URL, title, size) |
| `storage` | Keeps the download queue and progress for the browser session |
| `webRequest` | Finds the HLS / DASH manifest URLs a page loads (observe only; nothing is modified) |
| Host permission `<all_urls>` | Videos can be on any site, and the extension has to read that site's videos and manifests |

**Remote code**: No. All code ships in the package.

**Data usage**
- User data collected: none
- Data sent anywhere: none (videos are fetched only from the site the user is viewing)
- Certify: data is not sold or used for purposes unrelated to the single purpose, and not used for creditworthiness or lending

## Steps

1. Register at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time registration fee)
2. "New item" → upload the ZIP
3. Fill in the listing and privacy practices as above; add the 128px icon and screenshots
4. Submit for review
