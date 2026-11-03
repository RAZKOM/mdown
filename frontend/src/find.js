// Find in the rendered page (Ctrl/Cmd+F outside the editor, which has its own search).
// Matches are wrapped in <mark class="find"> elements. A match may span several text nodes
// ("foo **bar**" matches "foo bar"), but never two blocks, and nothing inside diagrams or
// KaTeX's hidden MathML is searched.

const SKIP = "svg, .katex-mathml, script, style, canvas";
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dt, dd, figcaption, summary, div, table, tr";
const MAX = 2000;

let $content;
let bar = null;
let input;
let count;
let matches = []; // one array of <mark> elements per match
let current = -1;
let timer;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const findOpen = () => !!bar && !bar.hidden;

function build() {
  bar = document.createElement("div");
  bar.id = "find";
  bar.setAttribute("role", "search");
  input = Object.assign(document.createElement("input"), { type: "text", placeholder: "Find", spellcheck: false });
  input.setAttribute("aria-label", "Find in document");
  count = Object.assign(document.createElement("span"), { className: "count" });
  count.setAttribute("aria-live", "polite");
  const button = (label, title, fn) => {
    const b = Object.assign(document.createElement("button"), { textContent: label, title });
    b.setAttribute("aria-label", title);
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
    b.addEventListener("click", fn);
    return b;
  };
  bar.append(
    input,
    count,
    button("↑", "Previous match (Shift+Enter)", () => step(-1)),
    button("↓", "Next match (Enter)", () => step(1)),
    button("✕", "Close (Esc)", closeFind),
  );
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => search({ fromView: true }), 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(timer);
      if (pendingSearch()) search({ fromView: true });
      else step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  });
  document.body.appendChild(bar);
}

let lastQuery = "";
const pendingSearch = () => input.value !== lastQuery;

export function openFind(content, prefill) {
  $content = content;
  if (!bar) build();
  bar.hidden = false;
  if (prefill && !prefill.includes("\n")) input.value = prefill;
  input.focus();
  input.select();
  if (pendingSearch() || !matches.length) search({ fromView: true });
}

export function closeFind() {
  if (!bar) return;
  bar.hidden = true;
  clear();
  lastQuery = "";
  count.textContent = "";
}

// The page was re-rendered (file changed, or typing in the editor): the old marks are gone.
// Search again, staying on the same match number and without scrolling.
export function refreshFind() {
  if (!findOpen()) return;
  const keep = current;
  matches = [];
  search({ keep });
}

/** F3 / Shift+F3 and Ctrl/Cmd+G while the bar is open. */
export function step(dir) {
  if (!matches.length) return;
  select((current + dir + matches.length) % matches.length, true);
}

function clear() {
  const parents = new Set();
  for (const marks of matches) {
    for (const m of marks) {
      if (!m.isConnected) continue;
      parents.add(m.parentNode);
      m.replaceWith(...m.childNodes);
    }
  }
  for (const p of parents) p.normalize();
  matches = [];
  current = -1;
}

function textIndex(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && !n.parentElement.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  let text = "";
  let block = null;
  for (let n; (n = walker.nextNode()); ) {
    const b = n.parentElement.closest(BLOCK);
    if (b !== block && text) text += "\u0000"; // never matches, so no match crosses blocks
    block = b;
    nodes.push({ node: n, start: text.length, len: n.nodeValue.length });
    text += n.nodeValue;
  }
  return { nodes, text };
}

function search({ fromView = false, keep = -1 } = {}) {
  clear();
  const query = input.value;
  lastQuery = query;
  if (!query) {
    count.textContent = "";
    return;
  }
  const { nodes, text } = textIndex($content);
  const found = [];
  const re = new RegExp(escape(query), "gi");
  for (let m; (m = re.exec(text)) && found.length < MAX; ) found.push([m.index, m.index + m[0].length]);

  // Wrap from the last match back, so splitting a text node never moves an earlier match.
  let k = nodes.length - 1;
  for (let i = found.length - 1; i >= 0; i--) {
    const [s, e] = found[i];
    const marks = [];
    while (k > 0 && nodes[k].start >= e) k--;
    for (let j = k; j >= 0 && nodes[j].start + nodes[j].len > s; j--) {
      const { node, start, len } = nodes[j];
      const a = Math.max(s, start) - start;
      const b = Math.min(e, start + len) - start;
      if (b <= a) continue;
      if (b < node.nodeValue.length) node.splitText(b);
      const piece = a > 0 ? node.splitText(a) : node;
      const mark = Object.assign(document.createElement("mark"), { className: "find" });
      piece.replaceWith(mark);
      mark.appendChild(piece);
      marks.unshift(mark);
    }
    matches.unshift(marks);
  }

  if (!matches.length) {
    count.textContent = "No results";
    bar.classList.add("none");
    return;
  }
  bar.classList.remove("none");
  if (keep >= 0) return select(Math.min(keep, matches.length - 1), false);
  // Start from the first match on screen, not the top of the document.
  const first = fromView ? matches.findIndex((marks) => marks[0].getBoundingClientRect().bottom > 0) : 0;
  select(first < 0 ? 0 : first, true);
}

function select(i, scroll) {
  for (const m of matches[current] ?? []) m.classList.remove("current");
  current = i;
  for (const m of matches[current]) m.classList.add("current");
  count.textContent = `${current + 1} of ${matches.length}${matches.length >= MAX ? "+" : ""}`;
  if (scroll) matches[current][0].scrollIntoView({ block: "center", inline: "nearest" });
}
