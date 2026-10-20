import { loadCss } from "./lazy.js";

export async function renderMath(nodes) {
  const [{ default: katex }] = await Promise.all([import("katex"), loadCss("/katex.css")]);
  for (const el of nodes) {
    try {
      katex.render(el.textContent, el, {
        displayMode: el.dataset.math === "display",
        throwOnError: true,
        output: "htmlAndMathml",
      });
    } catch (err) {
      // A bad formula stays as its source text with an error tint, not a replaced block.
      el.classList.add("math-error");
      el.title = String(err.message || err);
    }
  }
}
