// A table of contents in a side panel (Ctrl/Cmd+Shift+O): every heading, indented by level,
// with the section being read highlighted. It belongs to the window and isn't saved.

let panel = null;
let list;
let $content;
let onJump;
let items = []; // [heading element, link] pairs
let frame = 0;

export const outlineOpen = () => document.body.classList.contains("outline-open");

function build() {
  panel = document.createElement("nav");
  panel.id = "outline";
  panel.setAttribute("aria-label", "Contents");
  const title = Object.assign(document.createElement("div"), { className: "title", textContent: "Contents" });
  list = document.createElement("ol");
  panel.append(title, list);
  panel.addEventListener("click", (e) => {
    const link = e.target.closest("a");
    if (!link) return;
    e.preventDefault();
    const heading = items[Number(link.dataset.i)]?.[0];
    if (heading) onJump(heading);
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") toggleOutline();
  });
  document.body.appendChild(panel);
  // Scroll events don't bubble, but a capturing listener sees the window's and the preview's.
  window.addEventListener("scroll", () => {
    if (outlineOpen() && !frame) frame = requestAnimationFrame(markCurrent);
  }, true);
}

/** `jump(heading)` scrolls to a heading; main.js decides how, since edit mode differs. */
export function toggleOutline(content, jump) {
  if (content) [$content, onJump] = [content, jump];
  if (!panel) build();
  const open = !outlineOpen();
  document.body.classList.toggle("outline-open", open);
  if (open) refreshOutline();
}

// Rebuilds the list from the page's headings (after every render).
export function refreshOutline() {
  if (!outlineOpen()) return;
  const headings = [...$content.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter((h) => !h.closest(".footnotes"));
  const top = Math.min(6, ...headings.map((h) => Number(h.tagName[1])));
  items = headings.map((h, i) => {
    const link = document.createElement("a");
    link.href = h.id ? "#" + h.id : "#";
    link.dataset.i = i;
    link.textContent = h.textContent.trim() || "(untitled)";
    link.title = link.textContent;
    link.style.paddingLeft = `${8 + (Number(h.tagName[1]) - top) * 14}px`;
    const li = document.createElement("li");
    li.appendChild(link);
    return [h, link];
  });
  list.replaceChildren(...items.map(([, link]) => link.parentElement));
  if (!items.length) list.appendChild(Object.assign(document.createElement("li"), { className: "empty", textContent: "No headings" }));
  markCurrent();
}

// The current section is the last heading that has scrolled past the top of the view.
function markCurrent() {
  frame = 0;
  if (!items.length) return;
  const scroller = document.body.classList.contains("editing") ? document.getElementById("preview") : null;
  const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
  let at = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i][0].getBoundingClientRect().top - viewTop <= 40) at = i;
    else break;
  }
  for (const [, link] of items) link.classList.remove("active");
  const link = items[at][1];
  link.classList.add("active");
  // Keep it visible in the panel (scrollIntoView could also move the page).
  const r = link.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  if (r.top < p.top + 30) panel.scrollTop -= p.top + 30 - r.top;
  else if (r.bottom > p.bottom) panel.scrollTop += r.bottom - p.bottom + 8;
}
