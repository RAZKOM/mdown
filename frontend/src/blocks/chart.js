import { isDark, printing, registerDisposer, showError } from "./lazy.js";

let Chart;
let defaultAnimation;

async function engine() {
  Chart ??= (await import("chart.js/auto")).default;
  defaultAnimation ??= Chart.defaults.animation;
  // Print snapshots are taken right after drawing, so skip the grow-in animation then.
  Chart.defaults.animation = printing.on ? false : defaultAnimation;
  const dark = isDark();
  Chart.defaults.color = dark ? "#9198a1" : "#59636e";
  // Not Chart.defaults.borderColor: that also feeds dataset defaults and disables auto-colours.
  Chart.defaults.scale.grid.color = dark ? "#3d444d" : "#d1d9e0";
  return Chart;
}

export async function renderCharts(codes) {
  const C = await engine();
  for (const code of codes) {
    let config;
    try {
      config = JSON.parse(code.textContent);
    } catch (err) {
      showError(code.parentElement, "Chart (invalid JSON)", err);
      continue;
    }
    const fig = document.createElement("figure");
    fig.className = "chart";
    const canvas = document.createElement("canvas");
    fig.appendChild(canvas);
    fig._config = config;
    if (code.parentElement.dataset.line) fig.dataset.line = code.parentElement.dataset.line;
    code.parentElement.replaceWith(fig);
    try {
      fig._chart = new C(canvas, structuredClone(config));
      registerDisposer(() => fig._chart?.destroy());
    } catch (err) {
      showError(fig, "Chart", err);
    }
  }
}

export async function rethemeCharts() {
  const figs = [...document.querySelectorAll("figure.chart")].filter((f) => f._chart);
  if (!figs.length) return;
  const C = await engine();
  for (const fig of figs) {
    fig._chart.destroy();
    fig._chart = new C(fig.querySelector("canvas"), structuredClone(fig._config));
  }
}
