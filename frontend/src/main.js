import { renderInto, rethemeAll } from "./render.js";
import { showBanner, hideBanner, confirmDialog, dialogOpen, toast, showMenu } from "./ui.js";
import { theme } from "./blocks/lazy.js";

const $preview = document.getElementById("preview");
const $content = document.getElementById("content");
const $editor = document.getElementById("editor");
const isMac = /Mac/.test(navigator.platform);
const send = (msg) => window.ipc.postMessage(JSON.stringify(msg));

// Three texts, kept apart so nothing is ever overwritten silently:
//   diskText   what we last read from, or wrote to, the file
//   bufferText what the preview shows (differs from diskText only while there are edits)
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
const paint = (text) => renderInto($content, text, scroll);

function setDirty(v) {
  if (v === dirty) return;
  dirty = v;
  send({ t: "dirty", v });
}

async function fetchDoc() {
  const res = await fetch("/doc", { cache: "no-store" });
  // A file caught mid-save can be briefly missing; keep showing what we have.
  return res.ok ? res.text() : null;
}

// Called at startup and by the Rust file watcher.
async function reload() {
  const text = await fetchDoc();
  if (text === null) return;
  if (diskText === null) {
    diskText = bufferText = text;
    return paint(text);
  }
  if (text === diskText) return;
  if (text === bufferText) {
    // Our own save landing on disk.
    diskText = text;
    return setDirty(false);
  }
  if (!dirty) return adopt(text);
  // Edits in progress: never clobber them. Offer a choice instead.
  pendingDisk = text;
  showBanner("This file changed on disk.", [
    ["Reload", () => adopt(pendingDisk)],
    ["Keep mine", () => { diskText = pendingDisk; }],
  ]);
}

function adopt(text) {
  diskText = bufferText = text;
  pendingDisk = null;
  editor?.setDoc(text);
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
  bufferText = editor.getDoc();
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
      doc: bufferText ?? "",
      onChange: onEdit,
      onScroll: (ratio) => {
        $preview.scrollTop = ratio * ($preview.scrollHeight - $preview.clientHeight);
      },
    });
    window.__editor = editor; // handy for tests and debugging
  }
  document.body.classList.add("editing");
  editor.focus();
}

function save() {
  if (!editor) return;
  clearTimeout(syncTimer);
  bufferText = savingText = editor.getDoc();
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
  }
  items.push("-", { label: editing() ? "View mode" : "Edit mode", hint: mod + "E", action: toggleEdit });
  if (editor) items.push({ label: "Save", hint: mod + "S", disabled: !dirty, action: save });
  items.push({ label: "Print / Save as PDF…", hint: mod + "P", action: printPage }, "-");

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
    if (cmd && e.shiftKey && !e.altKey && key === "l") {
      e.preventDefault();
      cycleTheme();
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
// Lets automated checks render the print view without opening the system print dialog.
window.__print = {
  prepare: async () => (await import("./print.js")).preparePrint(),
  restore: async () => (await import("./print.js")).restoreAfterPrint(),
};
reload();
