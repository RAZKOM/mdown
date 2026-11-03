const loaded = new Map();

export function loadCss(href) {
  if (!loaded.has(href)) {
    loaded.set(href, new Promise((resolve, reject) => {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.onload = resolve;
      l.onerror = () => reject(new Error("failed to load " + href));
      document.head.appendChild(l);
    }));
  }
  return loaded.get(href);
}

// Replaces a failed block in place; the rest of the page is untouched.
export function showError(el, what, err) {
  const box = document.createElement("div");
  box.className = "block-error";
  const msg = String(err && err.message ? err.message : err).split("\n").slice(0, 6).join("\n");
  box.innerHTML = "<strong></strong><pre></pre>";
  box.firstChild.textContent = what + " failed";
  box.lastChild.textContent = msg;
  if (el.dataset?.line) box.dataset.line = el.dataset.line; // keeps scroll sync anchored
  el.replaceWith(box);
}

// Live reload replaces the whole page body; anything holding GPU or canvas resources
// (3D viewers, charts) registers a disposer here so those are freed first.
const disposers = new Set();
export const registerDisposer = (fn) => disposers.add(fn);
export function disposeAll() {
  for (const fn of disposers) {
    try { fn(); } catch {}
  }
  disposers.clear();
}

// The user's choice ("system" | "light" | "dark"); the server stamps it on <html> before first paint.
export const theme = { mode: document.documentElement.dataset.theme || "system" };
// While printing, everything renders with the light theme regardless of any setting.
export const printing = { on: false };
export const isDark = () =>
  !printing.on && (theme.mode === "dark" || (theme.mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches));
