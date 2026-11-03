// GitHub-style alerts: a blockquote whose first line is [!NOTE], [!TIP], [!IMPORTANT],
// [!WARNING] or [!CAUTION] becomes a coloured callout with a title. Anything else after the
// marker on that line means it isn't an alert, as on GitHub.

const KINDS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };
const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

function findAlerts(state) {
  const tokens = state.tokens;
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i].type !== "blockquote_open") continue;
    const [open, inline] = [tokens[i + 1], tokens[i + 2]];
    if (open.type !== "paragraph_open" || inline.type !== "inline") continue;
    const m = MARKER.exec(inline.content);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    tokens[i].meta = { ...tokens[i].meta, alert: kind };
    tokens[i].attrJoin("class", `alert alert-${kind}`);
    inline.content = inline.content.slice(m[0].length);
    if (!inline.content.trim()) {
      // "> [!NOTE]" alone on its line, the text following in its own paragraph.
      open.hidden = true;
      const close = tokens.slice(i + 3).find((t) => t.type === "paragraph_close");
      if (close) close.hidden = true;
    }
  }
}

export default function alerts(md) {
  // Before inline parsing, so the marker is gone before the rest of the line is rendered.
  md.core.ruler.before("inline", "github_alerts", findAlerts);
  const fallback = md.renderer.rules.blockquote_open ?? ((t, i, o, e, self) => self.renderToken(t, i, o));
  md.renderer.rules.blockquote_open = (tokens, i, options, env, self) => {
    const out = fallback(tokens, i, options, env, self);
    const kind = tokens[i].meta?.alert;
    return kind ? `${out}<p class="alert-title">${KINDS[kind]}</p>\n` : out;
  };
}
