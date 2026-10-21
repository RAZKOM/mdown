// Small in-page UI: a banner for on-disk changes, a close-confirmation dialog, a toast, and the
// right-click menu. Done in the page (not native dialogs or menus) so it looks right on both
// platforms with no extra crates.

const $ = (id) => document.getElementById(id);

function button(label, onClick, primary = false) {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = primary ? "primary" : "";
  b.addEventListener("click", onClick);
  return b;
}

export function showBanner(message, actions) {
  const el = $("banner");
  el.replaceChildren(Object.assign(document.createElement("span"), { textContent: message }));
  for (const [label, fn] of actions) el.appendChild(button(label, () => { hideBanner(); fn(); }));
  el.hidden = false;
}

export function hideBanner() {
  $("banner").hidden = true;
}

export function confirmDialog(title, body, actions) {
  const el = $("dialog");
  const box = document.createElement("div");
  box.className = "box";
  box.setAttribute("role", "alertdialog");
  const h = Object.assign(document.createElement("strong"), { textContent: title });
  const p = Object.assign(document.createElement("p"), { textContent: body });
  const row = document.createElement("div");
  row.className = "row";
  for (const [label, fn, primary] of actions) row.appendChild(button(label, () => { el.hidden = true; fn(); }, primary));
  box.append(h, p, row);
  el.replaceChildren(box);
  el.hidden = false;
  row.querySelector(".primary, button")?.focus();
}

export const dialogOpen = () => !$("dialog").hidden;

let toastTimer;
export function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = isError ? "error" : "";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---- context menu ----------------------------------------------------------------------
//
// An item is { label, hint?, checked?, disabled?, action? } or { label, hint?, items: [...] }
// for a flyout submenu; the string "-" is a separator. Mouse presses are swallowed so the
// text selection and the editor's focus survive a click on the menu.

let menu = null;
let active = null;

export function hideMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
  active = null;
  for (const [type, fn, capture] of listeners) window.removeEventListener(type, fn, capture);
}

const itemsOf = (level) => [...level.querySelectorAll(":scope > .item:not(.disabled)")];

function setActive(item) {
  active?.classList.remove("active");
  active = item;
  active?.classList.add("active");
}

// Shows `item`'s flyout (and hides its siblings'), nudged up if it would run off the bottom.
function openSub(item) {
  for (const sib of item.parentElement.querySelectorAll(":scope > .item.open")) if (sib !== item) sib.classList.remove("open");
  if (!item.classList.contains("sub")) return;
  item.classList.add("open");
  const flyout = item.querySelector(":scope > .menu");
  flyout.style.top = "";
  const over = flyout.getBoundingClientRect().bottom - (document.documentElement.clientHeight - 6);
  if (over > 0) flyout.style.top = `${-4 - over}px`;
}

function run(item) {
  if (item.classList.contains("sub")) return openSub(item);
  const { action } = item;
  hideMenu();
  action?.();
}

function build(items, isSub = false) {
  const el = document.createElement("div");
  el.className = isSub ? "menu flyout" : "menu";
  el.setAttribute("role", "menu");
  for (const it of items) {
    if (it === "-") {
      el.appendChild(Object.assign(document.createElement("hr"), { role: "separator" }));
      continue;
    }
    const row = document.createElement("div");
    row.className = "item" + (it.disabled ? " disabled" : "") + (it.items ? " sub" : "");
    row.setAttribute("role", it.checked !== undefined ? "menuitemradio" : "menuitem");
    if (it.checked !== undefined) row.setAttribute("aria-checked", String(it.checked));
    if (it.disabled) row.setAttribute("aria-disabled", "true");
    row.action = it.action;
    row.append(
      Object.assign(document.createElement("span"), { className: "check", textContent: it.checked ? "✓" : "" }),
      Object.assign(document.createElement("span"), { className: "label", textContent: it.label }),
      Object.assign(document.createElement("span"), { className: "hint", textContent: it.hint ?? "" }),
    );
    if (it.items) {
      row.appendChild(Object.assign(document.createElement("span"), { className: "arrow", textContent: "›" }));
      row.appendChild(build(it.items, true));
    }
    row.addEventListener("mouseover", (e) => {
      e.stopPropagation(); // the innermost item decides; its parents stay as they are
      if (it.disabled) return;
      setActive(row);
      openSub(row);
    });
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!it.disabled) run(row);
    });
    el.appendChild(row);
  }
  return el;
}

function onKey(e) {
  const level = active ? active.parentElement : menu;
  const list = itemsOf(level);
  const at = list.indexOf(active);
  if (e.key === "Escape") hideMenu();
  else if (e.key === "ArrowDown") setActive(list[(at + 1) % list.length]);
  else if (e.key === "ArrowUp") setActive(list[at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length]);
  else if (e.key === "ArrowRight" && active?.classList.contains("sub")) {
    openSub(active);
    setActive(itemsOf(active.querySelector(":scope > .menu"))[0] ?? active);
  } else if (e.key === "ArrowLeft" && active?.parentElement.classList.contains("flyout")) {
    const parent = active.parentElement.parentElement;
    parent.classList.remove("open");
    setActive(parent);
  } else if ((e.key === "Enter" || e.key === " ") && active) run(active);
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") return;
  else if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
    hideMenu(); // any other key is meant for the page, which it now reaches
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

const listeners = [
  ["keydown", onKey, true],
  ["mousedown", (e) => { if (!menu?.contains(e.target)) hideMenu(); else e.preventDefault(); }, true],
  ["blur", hideMenu, false],
  ["resize", hideMenu, false],
  ["wheel", hideMenu, { capture: true, passive: true }],
  // Right-clicking the menu itself must not open a fresh one.
  ["contextmenu", (e) => { if (menu?.contains(e.target)) { e.preventDefault(); e.stopPropagation(); } }, true],
];

export function showMenu(x, y, items) {
  hideMenu();
  menu = build(items);
  menu.id = "menu";
  document.body.appendChild(menu);
  // The layout viewport, which excludes the scrollbar that innerWidth/innerHeight include.
  const { clientWidth: vw, clientHeight: vh } = document.documentElement;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, vw - width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, vh - height - 4))}px`;
  // A flyout opens to the left when the widest one doesn't fit on the right.
  menu.classList.add("measure");
  const flyoutWidth = Math.max(0, ...[...menu.querySelectorAll(".flyout")].map((f) => f.getBoundingClientRect().width));
  menu.classList.remove("measure");
  menu.classList.toggle("flip", vw - menu.getBoundingClientRect().right < flyoutWidth + 6);
  for (const [type, fn, capture] of listeners) window.addEventListener(type, fn, capture);
}
