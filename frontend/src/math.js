// Dependency-free markdown-it rules for $inline$ and $$display$$ math. They only emit
// placeholders carrying the TeX source; KaTeX is loaded later, and only if one exists.

function inlineMath(state, silent) {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24 /* $ */) return false;
  const next = src.charCodeAt(start + 1);
  if (next === 0x24 || next === 0x20 || next === 0x0a || Number.isNaN(next)) return false;
  let end = start + 1;
  while ((end = src.indexOf("$", end)) !== -1) {
    // Skip escaped dollars.
    let bs = 0;
    while (src.charCodeAt(end - 1 - bs) === 0x5c) bs++;
    if (bs % 2 === 0) break;
    end++;
  }
  if (end === -1 || end === start + 1) return false;
  const prev = src.charCodeAt(end - 1);
  const after = src.charCodeAt(end + 1);
  // "$5 and $6" is prices, not math: no space before the closer, no digit right after it.
  if (prev === 0x20 || prev === 0x0a || (after >= 0x30 && after <= 0x39)) return false;
  if (!silent) {
    const t = state.push("math_inline", "span", 0);
    t.content = src.slice(start + 1, end);
  }
  state.pos = end + 1;
  return true;
}

function blockMath(state, startLine, endLine, silent) {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (state.src.slice(pos, pos + 2) !== "$$") return false;
  pos += 2;
  const firstLine = state.src.slice(pos, max);
  if (silent) return true;
  let content = "";
  let line = startLine;
  let found = false;
  if (firstLine.trim().endsWith("$$")) {
    content = firstLine.trim().slice(0, -2);
    found = true;
  } else {
    content = firstLine.trim() ? firstLine + "\n" : "";
    while (++line < endLine) {
      pos = state.bMarks[line] + state.tShift[line];
      max = state.eMarks[line];
      const text = state.src.slice(pos, max);
      if (text.trim().endsWith("$$")) {
        content += text.trim().slice(0, -2);
        found = true;
        break;
      }
      content += text + "\n";
    }
  }
  if (!found) return false;
  state.line = line + 1;
  const t = state.push("math_block", "div", 0);
  t.content = content.trim();
  t.map = [startLine, state.line];
  return true;
}

export default function math(md) {
  md.inline.ruler.after("escape", "math_inline", inlineMath);
  md.block.ruler.after("blockquote", "math_block", blockMath, { alt: ["paragraph", "reference", "blockquote", "list"] });
  const e = md.utils.escapeHtml;
  md.renderer.rules.math_inline = (t, i) => `<span class="math" data-math="inline">${e(t[i].content)}</span>`;
  md.renderer.rules.math_block = (t, i, o, env, self) =>
    `<div class="math" data-math="display"${self.renderAttrs(t[i])}>${e(t[i].content)}</div>\n`;
}
