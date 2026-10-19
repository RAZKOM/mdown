import { build } from "esbuild";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

rmSync("../dist", { recursive: true, force: true });
mkdirSync("../dist", { recursive: true });

const { metafile } = await build({
  entryPoints: { app: "src/main.js", "app-css": "src/style.css", katex: "src/katex.css" },
  bundle: true,
  minify: true,
  splitting: true,
  format: "esm",
  target: "es2022",
  outdir: "../dist",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  loader: { ".woff2": "file", ".woff": "empty", ".ttf": "empty" },
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
});

// Every chunk app.js needs before it can run. The browser only discovers them one import level
// at a time, so listing them as modulepreload turns a chain of requests into one parallel batch.
const url = (path) => path.replace(/^\.\.\/dist/, "");
const eager = new Set();
const collect = (path) => {
  for (const imp of metafile.outputs[path].imports) {
    if (imp.kind === "import-statement" && !eager.has(imp.path)) {
      eager.add(imp.path);
      collect(imp.path);
    }
  }
};
collect("../dist/app.js");
const preload = [...eager].map((p) => `<link rel="modulepreload" href="${url(p)}">`).join("");

// data-theme/width/zoom are placeholders the app replaces with the saved settings when serving
// the page (see src/assets.rs).
writeFileSync(
  "../dist/index.html",
  `<!doctype html><html data-theme="system" data-width="normal" data-zoom="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app-css.css"><link rel="modulepreload" href="/app.js">${preload}</head><body><div id="banner" hidden></div><div id="app"><div id="editor"></div><div id="preview"><main id="content"></main></div></div><div id="dialog" hidden></div><div id="toast" hidden></div><script type="module" src="/app.js"></script></body></html>`,
);
