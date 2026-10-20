import { printing } from "./blocks/lazy.js";
import { rethemeAll } from "./render.js";

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

// Paper is white, so diagrams and charts are redrawn with the light theme, and canvases
// (charts, 3D viewers) get a static <img> twin that the print stylesheet shows instead.
export async function preparePrint() {
  printing.on = true;
  await rethemeAll();
  await frame();
  for (const canvas of document.querySelectorAll("figure.chart canvas, div.model canvas")) {
    let img = canvas.nextElementSibling;
    if (!img || !img.classList.contains("snap")) {
      img = document.createElement("img");
      img.className = "snap";
      canvas.after(img);
    }
    try {
      img.src = canvas.toDataURL("image/png");
    } catch {
      img.remove();
    }
  }
}

export async function restoreAfterPrint() {
  if (!printing.on) return;
  printing.on = false;
  await rethemeAll();
}
