import { renderInto, rethemeAll } from "./render.js";
import { showBanner, hideBanner, confirmDialog, dialogOpen, toast, showMenu } from "./ui.js";
import { theme } from "./blocks/lazy.js";
import { openFind, closeFind, refreshFind, findOpen, step as findStep } from "./find.js";
import { toggleOutline, refreshOutline, outlineOpen } from "./outline.js";

const $preview = document.getElementById("preview");
const $content = document.getElementById("content");
const $editor = document.getElementById("editor");
const isMac = /Mac/.test(navigator.platform);
const send = (msg) => window.ipc.postMessage(JSON.stringify(msg));

// Three texts, kept apart so nothing is ever overwritten silently:
//   diskText   what we last read from, or wrote to, the file
//   bufferText what the preview shows (differs from diskText only while there are edits)
// Both are exactly what is (or will be) on disk, byte-order mark and CRLF line endings included.
// The editor only ever sees "\n", so its text goes through fromDisk/toDisk on the way in and out.
let diskText = null;
let bufferText = null;
let pendingDisk = null; // newer on-disk text we are holding back while there are edits
let dirty = false;
let editor = null;
let savingText = null;
let closeAfterSave = false;

const editing = () => document.body.classList.contains("editing");
const scroll = {
  get: () => (editing() ? $preview.scrollTop : window.scrollY),
  set: (y) => (editing() ? ($preview.scrollTop = y) : window.scrollTo(0, y)),
};
const BOM = "\uFEFF";
async function paint(text) {
  await renderInto($content, text.startsWith(BOM) ? text.slice(1) : text, scroll);
  refreshFind();
  refreshOutline();
}

function setDirty(v) {
  if (v === dirty) return;
  dirty = v;
  send({ t: "dirty", v });
}

// How the file is written, so a save puts back what the editor normalised away. `lossy` means
// the file isn't valid UTF-8: it can be shown, but saving would replace the bad bytes for good.
let format = { bom: false, crlf: false, lossy: false };

function detectFormat(text, lossy) {
  const eol = /\r?\n/.exec(text);
  format = { bom: text.startsWith(BOM), crlf: eol?.[0] === "\r\n", lossy };
}

const fromDisk = (text) => (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n?/g, "\n");
const toDisk = (text) => (format.bom ? BOM : "") + (format.crlf ? text.replace(/\n/g, "\r\n") : text);

async function fetchDoc() {
  const res = await fetch("/doc", { cache: "no-store" });
  // A file caught mid-save can be briefly missing; keep showing what we have.
  if (!res.ok) return null;
  const bytes = await res.arrayBuffer();
  // res.text() would drop a byte-order mark and quietly patch invalid bytes; keep both visible.
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), lossy: false };
  } catch {
    return { text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), lossy: true };
  }
}

// Called at startup and by the Rust file watcher.
async function reload() {
  const got = await fetchDoc();
  if (got === null) return;
  const { text, lossy } = got;
  if (diskText === null) {
    diskText = bufferText = text;
    detectFormat(text, lossy);
    return paint(text);
  }
  if (text === diskText) return;
  if (text === bufferText) {
    // Our own save landing on disk.
    diskText = text;
    return setDirty(false);
  }
  if (!dirty) return adopt(text, lossy);
  // Edits in progress: never clobber them. Offer a choice instead.
  pendingDisk = got;
  showBanner("This file changed on disk.", [
    ["Reload", () => adopt(pendingDisk.text, pendingDisk.lossy)],
    ["Keep mine", () => { diskText = pendingDisk.text; }],
  ]);
}

function adopt(text, lossy) {
  diskText = bufferText = text;
  detectFormat(text, lossy);
  pendingDisk = null;
  editor?.setDoc(fromDisk(text));
  setDirty(false);
  hideBanner();
  return paint(text);
}

// ---- edit mode -------------------------------------------------------------------------

let syncTimer;
function onEdit() {
  setDirty(true);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncBuffer, 200);
}

function syncBuffer() {
  bufferText = toDisk(editor.getDoc());
  setDirty(bufferText !== diskText); // undoing back to the saved text is clean again
  paint(bufferText);
}

async function toggleEdit() {
  if (editing()) {
    document.body.classList.remove("editing");
    return;
  }
  if (!editor) {
    const { createEditor } = await import("./editor.js");
    editor = createEditor($editor, {
      doc: fromDisk(bufferText ?? ""),
      onChange: onEdit,
      onScroll: followEditor,
    });
    window.__editor = editor; // handy for tests and debugging
  }
  document.body.classList.add("editing");
  editor.focus();
  if (format.lossy) toast("This file isn't UTF-8 text. You can edit it, but saving is turned off.", true);
}

// Keeps the preview on the part of the document the editor shows. Blocks carry the source line
// they start on (data-line); the position between two of them is interpolated, so a long
// paragraph or a tall diagram still scrolls smoothly.
function followEditor({ line, lines, atTop, atEnd }) {
  if (atTop) return ($preview.scrollTop = 0);
  if (atEnd) return ($preview.scrollTop = $preview.scrollHeight);
  let before = null;
  let after = null;
  for (const el of $content.querySelectorAll("[data-line]")) {
    if (el.closest(".footnotes")) continue; // rendered at the end, whatever their source line
    if (Number(el.dataset.line) <= line) before = el;
    else {
      after = el;
      break;
    }
  }
  const base = $preview.getBoundingClientRect().top - $preview.scrollTop;
  const y = (el) => el.getBoundingClientRect().top - base;
  const from = before ? { line: Number(before.dataset.line), y: y(before) } : { line: 0, y: 0 };
  const to = after ? { line: Number(after.dataset.line), y: y(after) } : { line: lines, y: $content.scrollHeight };
  const t = to.line > from.line ? (line - from.line) / (to.line - from.line) : 0;
  $preview.scrollTop = from.y + Math.min(1, Math.max(0, t)) * (to.y - from.y);
}

// Outline clicks: in edit mode the editor moves and the preview follows it.
function jumpTo(heading) {
  if (editing() && editor && heading.dataset.line) editor.scrollToLine(Number(heading.dataset.line));
  else heading.scrollIntoView({ block: "start" });
}

const find = () => openFind($content, String(getSelection()).trim());
const outline = () => toggleOutline($content, jumpTo);

// ---- image zoom ------------------------------------------------------------------------
//
// An image shown smaller than its real size opens full size in an overlay; any click or key
// closes it.

const zoomable = (img) =>
  img.matches("#content img:not(.snap)") && !img.closest("a") && (img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1);

function zoomImage(img) {
  const box = document.createElement("div");
  box.id = "lightbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", img.alt || "Image");
  box.appendChild(Object.assign(document.createElement("img"), { src: img.currentSrc || img.src, alt: img.alt }));
  const close = () => {
    box.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  box.addEventListener("click", close);
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(box);
}

document.addEventListener("mouseover", (e) => {
  if (e.target.tagName === "IMG") e.target.classList.toggle("zoomable", zoomable(e.target));
});

function save() {
  if (!editor) return;
  if (format.lossy) {
    closeAfterSave = false;
    toast("This file isn't UTF-8 text, so mdown won't save over it.", true);
    return;
  }
  clearTimeout(syncTimer);
  bufferText = savingText = toDisk(editor.getDoc());
  send({ t: "save", text: savingText });
}

window.__saved = () => {
  diskText = savingText;
  setDirty(bufferText !== diskText);
  hideBanner();
  if (closeAfterSave) send({ t: "close" });
};
window.__saveFailed = (message) => {
  closeAfterSave = false;
  toast("Could not save: " + message, true);
};

// ---- settings --------------------------------------------------------------------------
//
// Theme, page width and text size are saved globally by the app. A change made here is sent
// up, saved, and echoed to every window (this one included) through __applySettings.

const root = document.documentElement;
const THEMES = ["system", "light", "dark"];
const prefs = { width: root.dataset.width, zoom: Number(root.dataset.zoom) };

// Applies a theme to this window. Diagrams and charts bake their colours in, so they redraw.
function applyTheme(mode) {
  if (!THEMES.includes(mode) || mode === theme.mode) return;
  theme.mode = mode;
  root.dataset.theme = mode;
  rethemeAll();
}

function applyWidth(width) {
  root.dataset.width = prefs.width = width;
}

// `value` for zoom may be a step: "in", "out" or "reset".
function setSetting(key, value) {
  if (key === "theme") applyTheme(value); // don't wait for the round trip
  if (key === "width") applyWidth(value);
  send({ t: "setting", key, value });
}

const announce = {
  theme: () => "Theme: " + theme.mode,
  width: () => "Page width: " + prefs.width,
  zoom: () => `Text size: ${Math.round(prefs.zoom * 100)}%`,
};

// `changed` names the setting this window just changed; the other windows get null.
window.__applySettings = (s, changed) => {
  applyTheme(s.theme);
  applyWidth(s.width);
  prefs.zoom = s.zoom;
  if (changed) toast(announce[changed]());
};

function cycleTheme() {
  setSetting("theme", THEMES[(THEMES.indexOf(theme.mode) + 1) % THEMES.length]);
}

// ---- context menu ----------------------------------------------------------------------

const mod = isMac ? "⌘" : "Ctrl+";

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = Object.assign(document.createElement("textarea"), { value: text });
    box.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(box);
    box.select();
    document.execCommand("copy");
    box.remove();
  }
  if (message) toast(message);
}

async function paste() {
  try {
    editor.replaceSelection(await navigator.clipboard.readText());
  } catch {
    toast(`Paste isn't available here. Use ${mod}V.`, true);
  }
}

// What the menu offers depends on what was clicked; the document-wide items follow.
function menuItems(e) {
  const hit = e.target.closest ? e.target : e.target.parentElement;
  const inEditor = editor !== null && !!hit.closest("#editor");
  const link = hit.closest("a[href]");
  const code = hit.closest("pre");
  const selected = inEditor ? editor.getSelection() : String(getSelection());
  const items = [];
  if (inEditor) {
    items.push(
      { label: "Cut", hint: mod + "X", disabled: !selected, action: () => { copyText(selected); editor.replaceSelection(""); } },
      { label: "Copy", hint: mod + "C", disabled: !selected, action: () => copyText(selected) },
      { label: "Paste", hint: mod + "V", action: paste },
      { label: "Select all", hint: mod + "A", action: () => editor.selectAll() },
    );
  } else {
    items.push({ label: "Copy", hint: mod + "C", disabled: !selected, action: () => copyText(selected) });
    if (link) items.push({ label: "Copy link address", action: () => copyText(link.getAttribute("href"), "Link copied") });
    if (code) items.push({ label: "Copy code", action: () => copyText((code.querySelector("code") ?? code).textContent.replace(/\n$/, ""), "Code copied") });
    items.push({ label: "Select all", hint: mod + "A", action: () => getSelection().selectAllChildren($content) });
    items.push({ label: "Find…", hint: mod + "F", action: find });
  }
  items.push("-", { label: editing() ? "View mode" : "Edit mode", hint: mod + "E", action: toggleEdit });
  if (editor) items.push({ label: "Save", hint: mod + "S", disabled: !dirty, action: save });
  items.push({ label: "Print / Save as PDF…", hint: mod + "P", action: printPage }, "-");
  items.push({ label: "Contents", hint: mod + (isMac ? "⇧O" : "Shift+O"), checked: outlineOpen(), action: outline });

  const pct = Math.round(prefs.zoom * 100);
  items.push(
    {
      label: "Theme",
      items: THEMES.map((m) => ({ label: m[0].toUpperCase() + m.slice(1), checked: theme.mode === m, action: () => setSetting("theme", m) })),
    },
    {
      label: "Text size",
      hint: pct === 100 ? "" : pct + "%",
      items: [
        { label: "Larger", hint: mod + "+", disabled: pct >= 300, action: () => setSetting("zoom", "in") },
        { label: "Smaller", hint: mod + "-", disabled: pct <= 50, action: () => setSetting("zoom", "out") },
        { label: "Actual size", hint: mod + "0", disabled: pct === 100, action: () => setSetting("zoom", "reset") },
      ],
    },
    {
      label: "Page width",
      items: ["normal", "wide"].map((w) => ({ label: w[0].toUpperCase() + w.slice(1), checked: prefs.width === w, action: () => setSetting("width", w) })),
    },
    "-",
    { label: isMac ? "Reveal in Finder" : "Show in File Explorer", action: () => send({ t: "reveal" }) },
    { label: "Copy file path", action: async () => copyText((await (await fetch("/meta")).json()).path, "Path copied") },
  );
  return items;
}

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (!dialogOpen()) showMenu(e.clientX, e.clientY, menuItems(e));
});

// Ctrl+wheel (and a trackpad pinch, which arrives the same way) changes the text size.
let lastWheelZoom = 0;
document.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (e.timeStamp - lastWheelZoom < 150) return;
    lastWheelZoom = e.timeStamp;
    setSetting("zoom", e.deltaY < 0 ? "in" : "out");
  },
  { passive: false },
);

// The window asked to close while there are unsaved edits.
window.__askClose = () => {
  confirmDialog("Save changes before closing?", "Your edits to this file have not been saved.", [
    ["Save", () => { closeAfterSave = true; save(); }, true],
    ["Don't save", () => send({ t: "close" })],
    ["Cancel", () => {}],
  ]);
};

// ---- printing --------------------------------------------------------------------------

async function printPage() {
  const { preparePrint } = await import("./print.js");
  await preparePrint();
  send({ t: "print" });
  // The print UI is outside the page; restore once it is done, or at the latest after a minute.
  const done = async () => {
    window.removeEventListener("afterprint", done);
    window.removeEventListener("focus", onFocus);
    (await import("./print.js")).restoreAfterPrint();
  };
  const onFocus = () => setTimeout(done, 1500);
  window.addEventListener("afterprint", done);
  setTimeout(() => window.addEventListener("focus", onFocus), 1000);
  setTimeout(done, 60000);
}

// ---- keys, links, drops ----------------------------------------------------------------

document.addEventListener(
  "keydown",
  (e) => {
    const cmd = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    const inEditor = !!e.target.closest?.("#editor");
    if (cmd && e.shiftKey && !e.altKey && key === "l") {
      e.preventDefault();
      cycleTheme();
    } else if (cmd && e.shiftKey && !e.altKey && key === "o") {
      e.preventDefault();
      outline();
    } else if (cmd && !e.shiftKey && !e.altKey && key === "f" && !inEditor) {
      // In the editor, CodeMirror's own search panel takes Ctrl/Cmd+F.
      e.preventDefault();
      find();
    } else if (findOpen() && (e.key === "F3" || (cmd && !e.altKey && key === "g"))) {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    } else if (findOpen() && e.key === "Escape" && !inEditor && !e.target.closest?.("#find")) {
      closeFind();
    } else if (cmd && !e.altKey && ["e", "s", "p", "r"].includes(key)) {
      e.preventDefault();
      if (e.shiftKey) return;
      if (key === "e") toggleEdit();
      else if (key === "s") save();
      else if (key === "p") printPage();
    } else if (cmd && !e.altKey && ["=", "+", "-", "_", "0"].includes(e.key)) {
      e.preventDefault();
      setSetting("zoom", e.key === "0" ? "reset" : e.key === "-" || e.key === "_" ? "out" : "in");
    } else if (e.key === "F5") {
      e.preventDefault(); // a webview reload would throw away unsaved edits
    }
  },
  true,
);

document.addEventListener("click", (e) => {
  if (e.target.tagName === "IMG" && zoomable(e.target)) return zoomImage(e.target);
  const a = e.target.closest("a[href]");
  if (!a) return;
  const href = a.getAttribute("href");
  if (href.startsWith("#")) return;
  e.preventDefault();
  send({ t: "link", href });
});

// Dropping a file on the window would otherwise navigate the webview away from the page.
for (const type of ["dragover", "drop"]) document.addEventListener(type, (e) => e.preventDefault());

window.__reload = reload;
window.__toast = toast; // for messages from the app, such as a dropped file it can't open
// Lets automated checks render the print view without opening the system print dialog.
window.__print = {
  prepare: async () => (await import("./print.js")).preparePrint(),
  restore: async () => (await import("./print.js")).restoreAfterPrint(),
};
reload();
