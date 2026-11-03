import { isDark, showError } from "./lazy.js";

let mermaid;
let counter = 0;
let darkAtInit;

async function engine() {
  mermaid ??= (await import("mermaid")).default;
  if (darkAtInit !== isDark()) {
    darkAtInit = isDark();
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: darkAtInit ? "dark" : "default" });
  }
  return mermaid;
}

// Each figure keeps its source so it can be redrawn when the OS theme flips.
export async function renderMermaid(codes) {
  const m = await engine();
  for (const code of codes) {
    const fig = document.createElement("figure");
    fig.className = "mermaid";
    fig.dataset.src = code.textContent;
    if (code.parentElement.dataset.line) fig.dataset.line = code.parentElement.dataset.line;
    code.parentElement.replaceWith(fig);
    await draw(m, fig);
  }
}

// Re-rendering while typing hits the same diagrams repeatedly, so remember them per theme.
const cache = new Map();

async function draw(m, fig) {
  const key = darkAtInit + "\n" + fig.dataset.src;
  if (cache.has(key)) {
    fig.innerHTML = cache.get(key);
    return;
  }
  const id = "mmd" + counter++;
  try {
    const { svg } = await m.render(id, fig.dataset.src);
    if (cache.size > 50) cache.clear();
    cache.set(key, svg);
    fig.innerHTML = svg;
  } catch (err) {
    // Mermaid leaves a stray error element in <body> when parsing fails.
    document.getElementById("d" + id)?.remove();
    showError(fig, "Mermaid diagram", err);
  }
}

export async function rethemeMermaid() {
  const figs = document.querySelectorAll("figure.mermaid");
  if (!figs.length) return;
  const m = await engine();
  for (const fig of figs) await draw(m, fig);
}
