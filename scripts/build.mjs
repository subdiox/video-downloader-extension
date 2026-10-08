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
// along with the YouTube modules, the sandbox page and its manifest entry,
// and the yt_* messages in _locales.
// Blocks marked `#if dev` (the development bridge, see background.js) and
// the manifest's externally_connectable exist only in extension/ itself;
// both packaged editions drop them.
//
// Every build also writes dist/THIRD_PARTY_LICENSES.txt: the license of each
// npm package bundled into that edition, as their licenses require.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const extDir = path.join(root, "extension");

const BLOCK = /^[ \t]*(?:\/\/ #if (\w+)|<!-- #if (\w+) -->)[ \t]*\n([\s\S]*?)^[ \t]*(?:\/\/ #endif|<!-- #endif -->)[ \t]*\n/gm;

// Keeps the blocks whose flag is set (without their markers), drops the rest.
function preprocess(text, flags) {
  const out = text.replace(BLOCK, (_, js, html, body) => (flags[js ?? html] ? body : ""));
  if (/#if \w+|#endif/.test(out)) throw new Error("unbalanced or nested #if / #endif");
  return out;
}

// Applies preprocess() to our own sources as esbuild loads them.
const editionPlugin = (flags) => ({
  name: "edition",
  setup(build) {
    const src = path.join(root, "src") + path.sep;
    build.onLoad({ filter: /\.js$/ }, (args) =>
      args.path.startsWith(src) ? { contents: preprocess(fs.readFileSync(args.path, "utf8"), flags), loader: "js" } : undefined
    );
  },
});

function bundleOptions(outdir, { youtube, dev }) {
  return {
    entryPoints: youtube
      ? { offscreen: "src/offscreen/main.js", sandbox: "src/sandbox/main.js" }
      : { offscreen: "src/offscreen/main.js" },
    absWorkingDir: root,
    bundle: true,
    format: "iife",
    target: "chrome120",
    minify: true,
    legalComments: "none",
    metafile: true,
    outdir,
    plugins: [editionPlugin({ youtube, dev })],
    logLevel: "info",
  };
}

// The bundled npm packages, from esbuild's metafile, with their license texts.
function thirdPartyLicenses(metafile) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    // "(disabled):" inputs are modules a package's browser field turns off.
    const m = input.match(/^(node_modules\/(?:.*\/node_modules\/)?(?:@[^/]+\/)?[^/]+)\//);
    if (m) dirs.add(path.join(root, m[1]));
  }
  const sections = [...dirs]
    .map((dir) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      const repo = (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url)
        ?.replace(/^git\+/, "")
        .replace(/\.git$/, "");
      const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
      const text = file
        ? fs.readFileSync(path.join(dir, file), "utf8").trim()
        : `The package ships no license file; see ${repo ?? pkg.homepage ?? "its repository"} for the full text.`;
      const header = [`${pkg.name} ${pkg.version}`, `License: ${pkg.license}`, repo && `Source: ${repo}`].filter(Boolean);
      return { name: pkg.name, text: `${header.join("\n")}\n\n${text}` };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const rule = "\n\n" + "=".repeat(78) + "\n\n";
  return (
    "Video Downloader bundles the following third-party packages, unmodified.\n" +
    "Mediabunny is MPL-2.0; its source code is available at the Source URL below." +
    rule +
    sections.map((s) => s.text).join(rule) +
    "\n"
  );
}

async function bundle(outdir, flags) {
  const result = await esbuild.build(bundleOptions(outdir, flags));
  fs.writeFileSync(path.join(outdir, "THIRD_PARTY_LICENSES.txt"), thirdPartyLicenses(result.metafile));
}

function writeEdition(name, youtube) {
  const out = path.join(root, "build", name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name.startsWith(".")) continue;
    if (!youtube && entry.name === "sandbox.html") continue;
    const from = path.join(extDir, entry.name);
    const to = path.join(out, entry.name);
    if (entry.name === "_locales") {
      // Messages whose key starts with yt_ belong to the YouTube support.
      for (const lang of fs.readdirSync(from)) {
        const messages = JSON.parse(fs.readFileSync(path.join(from, lang, "messages.json"), "utf8"));
        const kept = Object.fromEntries(Object.entries(messages).filter(([key]) => youtube || !key.startsWith("yt_")));
        fs.mkdirSync(path.join(to, lang), { recursive: true });
        fs.writeFileSync(path.join(to, lang, "messages.json"), JSON.stringify(kept, null, 2) + "\n");
      }
    } else if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true, filter: (f) => !f.endsWith(".svg") });
    else if (entry.name === "manifest.json") {
      const manifest = JSON.parse(fs.readFileSync(from, "utf8"));
      delete manifest.externally_connectable;
      if (!youtube) {
        delete manifest.sandbox;
        manifest.description = "__MSG_extDescription__";
      }
      fs.writeFileSync(to, JSON.stringify(manifest, null, 2) + "\n");
    } else if (/\.(js|html)$/.test(entry.name)) {
      fs.writeFileSync(to, preprocess(fs.readFileSync(from, "utf8"), { youtube, dev: false }));
    } else fs.copyFileSync(from, to);
  }
  return out;
}

const args = process.argv.slice(2);
if (args[0] === "package") {
  const { version } = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  for (const [name, youtube] of [["full", true], ["store", false]]) {
    const out = writeEdition(name, youtube);
    await bundle(path.join(out, "dist"), { youtube, dev: false });
    const zip = path.join(root, "build", `video-downloader-${name}-${version}.zip`);
    fs.rmSync(zip, { force: true });
    execFileSync("zip", ["-qr", zip, "."], { cwd: out });
    console.log(`${name}: ${path.relative(root, zip)}`);
  }
} else {
  const outdir = path.join(extDir, "dist");
  const flags = { youtube: true, dev: true };
  if (args.includes("--watch")) await (await esbuild.context(bundleOptions(outdir, flags))).watch();
  else await bundle(outdir, flags);
}
