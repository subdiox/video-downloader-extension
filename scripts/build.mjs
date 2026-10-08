// Builds the extension.
//
//   node scripts/build.mjs           extension/dist for loading extension/ unpacked (full edition)
//   node scripts/build.mjs --watch   the same, rebuilding on change
//   node scripts/build.mjs package   build/full + build/store, each also zipped
//
// Two editions come from the same source. "full" includes YouTube support.
// "store" is for the Chrome Web Store: it drops every block marked
//   // #if youtube ... // #endif        (JS)
//   <!-- #if youtube --> ... <!-- #endif -->   (HTML)
// along with the YouTube modules, the sandbox page and its manifest entry.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const extDir = path.join(root, "extension");

const BLOCK = /^[ \t]*(?:\/\/ #if youtube|<!-- #if youtube -->)[ \t]*\n[\s\S]*?^[ \t]*(?:\/\/ #endif|<!-- #endif -->)[ \t]*\n/gm;
const MARKER = /^[ \t]*(?:\/\/ #if youtube|\/\/ #endif|<!-- #if youtube -->|<!-- #endif -->)[ \t]*\n/gm;

function preprocess(text, youtube) {
  const out = youtube ? text.replace(MARKER, "") : text.replace(BLOCK, "");
  if (/#if youtube|#endif/.test(out)) throw new Error("unbalanced #if youtube / #endif");
  return out;
}

// Applies preprocess() to our own sources as esbuild loads them.
const editionPlugin = (youtube) => ({
  name: "edition",
  setup(build) {
    const src = path.join(root, "src") + path.sep;
    build.onLoad({ filter: /\.js$/ }, (args) =>
      args.path.startsWith(src) ? { contents: preprocess(fs.readFileSync(args.path, "utf8"), youtube), loader: "js" } : undefined
    );
  },
});

function bundleOptions(outdir, youtube) {
  return {
    entryPoints: youtube
      ? { offscreen: "src/offscreen/main.js", sandbox: "src/sandbox/main.js" }
      : { offscreen: "src/offscreen/main.js" },
    absWorkingDir: root,
    bundle: true,
    format: "iife",
    target: "chrome120",
    minify: true,
    legalComments: "external",
    outdir,
    plugins: [editionPlugin(youtube)],
    logLevel: "info",
  };
}

const STORE_DESCRIPTION =
  "Save videos playing on the current page: video files, HLS and DASH streams, and live-stream recording, merged into one MP4.";

function writeEdition(name, youtube) {
  const out = path.join(root, "build", name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name.startsWith(".")) continue;
    if (!youtube && entry.name === "sandbox.html") continue;
    const from = path.join(extDir, entry.name);
    const to = path.join(out, entry.name);
    if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true, filter: (f) => !f.endsWith(".svg") });
    else if (entry.name === "manifest.json") {
      const manifest = JSON.parse(fs.readFileSync(from, "utf8"));
      if (!youtube) {
        delete manifest.sandbox;
        manifest.description = STORE_DESCRIPTION;
      }
      fs.writeFileSync(to, JSON.stringify(manifest, null, 2) + "\n");
    } else if (/\.(js|html)$/.test(entry.name)) {
      fs.writeFileSync(to, preprocess(fs.readFileSync(from, "utf8"), youtube));
    } else fs.copyFileSync(from, to);
  }
  return out;
}

const args = process.argv.slice(2);
if (args[0] === "package") {
  const { version } = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  for (const [name, youtube] of [["full", true], ["store", false]]) {
    const out = writeEdition(name, youtube);
    await esbuild.build(bundleOptions(path.join(out, "dist"), youtube));
    const zip = path.join(root, "build", `video-downloader-${name}-${version}.zip`);
    fs.rmSync(zip, { force: true });
    execFileSync("zip", ["-qr", zip, "."], { cwd: out });
    console.log(`${name}: ${path.relative(root, zip)}`);
  }
} else {
  const ctx = await esbuild.context(bundleOptions(path.join(extDir, "dist"), true));
  if (args.includes("--watch")) await ctx.watch();
  else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}
