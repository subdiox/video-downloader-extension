# Video Downloader

ブラウザで再生している動画を保存する Chrome 拡張（Manifest V3）。

- 通常の動画ファイル（MP4 / WebM など）
- HLS（MPEG-TS / fMP4、AES-128、別音声トラック、ライブ）
- DASH（SegmentTemplate / SegmentList / SegmentBase、ライブ）
- YouTube（yt-dlp と同じ方式。最高画質の映像＋音声を結合。ライブ配信も録画できる）— full 版のみ

ストリームは映像と音声を 1 本の MP4 にまとめて保存する（再エンコードなし）。外部の ffmpeg は不要。

## エディション

同じソースから 2 種類をビルドする。

| エディション | 内容 | 配布 |
|---|---|---|
| full | すべての機能（YouTube を含む） | このリポジトリ（自分でビルドして読み込む） |
| store | YouTube 対応を除いたもの | Chrome ウェブストア |

YouTube 専用のコードは `// #if youtube` 〜 `// #endif`（HTML は `<!-- #if youtube -->` 〜 `<!-- #endif -->`）で囲んであり、store 版のビルドではこの範囲と YouTube 用のモジュール・sandbox ページを取り除く。

## セットアップ

```sh
npm install
npm run build     # extension/dist を作る（full 版）
```

`chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」で `extension/` を選ぶ。
`src/` を変更したら `npm run build`（または `npm run watch`）してから拡張を再読み込みする。

配布用の ZIP:

```sh
npm run package   # build/full, build/store と build/video-downloader-{full,store}-<version>.zip
```

## 使い方

ツールバーの拡張機能ボタンを押すと、今のページ（埋め込み iframe を含む）の動画が一覧で出る。

- 各動画にサムネイル・タイトル・種類（MP4 / HLS / DASH）・解像度・長さ・「再生中」を表示。項目にマウスを乗せると、ページ上の該当する動画が枠で強調される。
- タイトルはその場で編集でき、そのままファイル名になる。
- `blob:` で再生している（MSE）プレーヤーは、そのフレームが読み込んだ HLS / DASH マニフェストと組にして表示する。出てこないときは再生を始めてから開き直す。
- DRM 付きのストリームはボタンが押せない状態で表示される。
- ライブ配信は「今から録画」（ライブの先端から）と「さかのぼって録画」（DVR で遡れる範囲すべて。YouTube は配信の最初から）を選べる。「ダウンロード中」欄の「停止して保存」で保存する。
- 広告と思われる動画（広告配信 URL、本編に重なる短い動画）には「広告の可能性」が付き、一覧の下に回る。
- YouTube は、そのタブで動画を少し再生してから開く（公式プレーヤーが発行した PO トークンを使うため）。途中で拒否されたら、もう少し再生してからやり直す。
- 一覧ページでは「このページからリンクされている動画を全部ダウンロード…」でまとめて保存できる。

保存先: `ダウンロード/<タイトル>.mp4`（同名があれば番号が付く）

## 構成

| ファイル | 役割 |
|---|---|
| `extension/background.js` | キュー、DNR ルール（Referer 付与）、マニフェスト検出 |
| `extension/popup.html` / `popup.js` | ツールバーのポップアップ（動画一覧・進捗） |
| `extension/collect.js` | 一覧ページから動画ページを集める |
| `src/offscreen/main.js` | Mediabunny で HLS/DASH → MP4（OPFS に書き出し） |
| `src/offscreen/dash.js` | mpd-parser で MPD を仮想 HLS プレイリストに変換して Mediabunny に渡す |
| `src/offscreen/youtube.js` | youtubei.js で形式を取得、署名/n を解いて分割ダウンロード、Mediabunny で結合（ライブは ANDROID クライアントの HLS を録画） |
| `src/offscreen/youtube-live.js` | YouTube ライブを配信の最初から録画（yt-dlp の `--live-from-start` と同じ。DASH のセグメントを番号で取得） |
| `src/sandbox/main.js` | eval が使える sandbox ページ（YouTube のプレーヤー JS の署名変換を実行） |
| `scripts/build.mjs` | full / store の 2 エディションをビルド |

使用ライブラリ: [Mediabunny](https://mediabunny.dev)（MPL-2.0）、[mpd-parser](https://github.com/videojs/mpd-parser)、[mux.js](https://github.com/videojs/mux.js)（sidx 解析のみ）、[youtubei.js](https://github.com/LuanRT/YouTube.js)、[googlevideo](https://github.com/LuanRT/googlevideo)（プレーヤーのリクエストから PO トークンを読む）。

## 非対応

- DRM（Widevine / FairPlay / PlayReady、SAMPLE-AES、CENC）— 検出したら中止する
- 過去にさかのぼれない（DVR が無効な）YouTube のライブ配信を、さかのぼって録画すること
- 広告挿入などで途中から音声の形式が変わるストリームは、その区間の音声が乱れることがある（1 本の音声トラックにしか入れられないため）
- VP9 / AV1 の MP4 は QuickTime では再生できないことがある（Chrome・VLC・IINA では再生可）
