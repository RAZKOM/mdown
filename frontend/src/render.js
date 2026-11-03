import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import anchor from "markdown-it-anchor";
import frontMatter from "markdown-it-front-matter";
import DOMPurify from "dompurify";
import math from "./math.js";
import alerts from "./alerts.js";
import { showError, disposeAll } from "./blocks/lazy.js";
import { isModelUrl } from "./blocks/model.js";

// Stamps each block with the source line it starts on (data-line, 0-based), so the preview can
// follow the editor line by line and the outline can move the editor to a heading.
function sourceLines(md) {
  md.core.ruler.push("source_lines", (state) => {
    for (const t of state.tokens) {
      if (t.map && t.nesting >= 0 && t.type !== "inline") t.attrSet("data-line", String(t.map[0]));
    }
  });
}

const md = new MarkdownIt({ html: true, linkify: true, typographer: false })
  .use(math)
  .use(footnote)
  .use(taskLists, { enabled: false })
  .use(anchor, { tabIndex: false })
  .use(frontMatter, () => {})
  .use(alerts)
  .use(sourceLines);

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Relative URLs go through the asset routes, which the Rust side confines to the document's
// git repository (or its folder, outside one). The browser would fold leading "../" segments
// into the URL path, so they travel as a count: "../../img/a.png" becomes "/up/2/img/a.png".
// Relative references inside a model (a .gltf's textures) then still resolve as they should.
export function assetUrl(src) {
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return src;
  const path = src.split(/[?#]/)[0];
  if (path.startsWith("/")) return "/a/" + encodeURIComponent(decode(path)); // absolute: refused
  const parts = [];
  let up = 0;
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.length ? parts.pop() : up++;
    else parts.push(encodeURIComponent(decode(seg)));
  }
  return (up ? `/up/${up}/` : "/a/") + parts.join("/");
}

function rewriteAssets(el) {
  for (const img of el.querySelectorAll("img[src]")) {
    const url = assetUrl(img.getAttribute("src"));
    if (isModelUrl(url)) {
      // ![alt](part.glb) becomes an interactive viewer instead of a broken image.
      const box = document.createElement("div");
      box.className = "model";
      box.dataset.src = url;
      box.setAttribute("role", "img");
      box.setAttribute("aria-label", img.alt || "3D model");
      box.textContent = img.alt ? "Loading " + img.alt + "…" : "Loading 3D model…";
      img.replaceWith(box);
    } else {
      img.src = url;
      img.loading = "lazy";
    }
  }
}

let generation = 0;

// Paint the core markdown first; heavy blocks hydrate afterwards, each independently so a
// failing block (or failing library load) never takes the rest of the page down.
// `scroll` is { get(), set(y) } for whichever element currently scrolls the preview.
export async function renderInto(root, text, scroll) {
  const gen = ++generation;
  const html = DOMPurify.sanitize(md.render(text), { ADD_ATTR: ["target"] });
  const y = scroll.get();
  // Hold the old height until diagrams and charts are back, or the scroll position gets clamped.
  root.style.minHeight = root.offsetHeight + "px";
  disposeAll();
  root.innerHTML = html;
  // markdown-it puts a fence's attributes on <code>; the line belongs to the whole block.
  for (const code of root.querySelectorAll("pre > code[data-line]")) {
    code.parentElement.dataset.line = code.dataset.line;
    code.removeAttribute("data-line");
  }
  rewriteAssets(root);
  scroll.set(y);
  await hydrate(root, gen);
  if (gen === generation) {
    root.style.minHeight = "";
    scroll.set(y);
  }
}

function hydrate(root, gen) {
  const stale = () => gen !== generation;
  const fenced = (lang) => [...root.querySelectorAll(`pre > code.language-${lang}`)];
  const mermaidBlocks = fenced("mermaid");
  const chartBlocks = fenced("chart");
  const special = new Set([...mermaidBlocks, ...chartBlocks]);
  const codeBlocks = [...root.querySelectorAll("pre > code[class*='language-']")].filter((c) => !special.has(c));
  const mathNodes = [...root.querySelectorAll(".math")];
  const modelBoxes = [...root.querySelectorAll("div.model")];

  const run = (items, what, load) => {
    if (!items.length) return Promise.resolve();
    return load()
      .then((fn) => !stale() && fn(items))
      .catch((err) => items.forEach((el) => !stale() && el.isConnected && showError(el.closest("pre") || el, what, err)));
  };
  return Promise.allSettled([
    run(codeBlocks, "Code highlighting", async () => (await import("./blocks/code.js")).highlightAll),
    run(mathNodes, "Math", async () => (await import("./blocks/math.js")).renderMath),
    run(mermaidBlocks, "Mermaid", async () => (await import("./blocks/mermaid.js")).renderMermaid),
    run(chartBlocks, "Chart", async () => (await import("./blocks/chart.js")).renderCharts),
    run(modelBoxes, "3D viewer", async () => (await import("./blocks/model.js")).renderModels),
  ]);
}

export async function rethemeAll() {
  const jobs = [];
  if (document.querySelector("figure.mermaid")) jobs.push(import("./blocks/mermaid.js").then((m) => m.rethemeMermaid()));
  if (document.querySelector("figure.chart")) jobs.push(import("./blocks/chart.js").then((m) => m.rethemeCharts()));
  await Promise.allSettled(jobs);
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rethemeAll);
