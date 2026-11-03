// Loaded only the first time edit mode is entered, so view mode never pays for CodeMirror.
import { EditorState, Annotation } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { search, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

// Colours come from the page's CSS variables, so the editor follows OS light/dark for free.
const theme = EditorView.theme({
  "&": { color: "var(--fg)", backgroundColor: "var(--bg)", height: "100%", fontSize: "14px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", lineHeight: "1.55" },
  ".cm-content": { padding: "16px 0", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0 20px" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--fg) 5%, transparent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--link) 28%, transparent)",
  },
  ".cm-panels": { backgroundColor: "var(--code)", color: "var(--fg)", borderColor: "var(--border)" },
  ".cm-panels input, .cm-panels button": { font: "inherit", color: "var(--fg)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "4px" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, #d4a72c 35%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, #d4a72c 65%, transparent)" },
});

const highlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--fg)", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--link)" },
  { tag: t.monospace, color: "var(--h-str)" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--h-com)" },
  { tag: t.list, color: "var(--h-kw)" },
  { tag: t.keyword, color: "var(--h-kw)" },
  { tag: [t.string, t.attributeValue], color: "var(--h-str)" },
  { tag: t.comment, color: "var(--h-com)" },
]);

const fromOutside = Annotation.define();

export function createEditor(parent, { doc, onChange, onScroll }) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        search({ top: true }),
        markdown(),
        EditorView.lineWrapping,
        keymap.of([...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
        theme,
        syntaxHighlighting(highlight),
        EditorView.updateListener.of((u) => {
          // Programmatic replacements (reload from disk) are not user edits.
          if (u.docChanged && !u.transactions.some((tr) => tr.annotation(fromOutside))) onChange();
        }),
      ],
    }),
  });
  // Reports the (fractional, 0-based) source line at the top of the view, for the preview to follow.
  view.scrollDOM.addEventListener("scroll", () => {
    const { scrollTop, scrollHeight, clientHeight } = view.scrollDOM;
    const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    const block = view.lineBlockAtHeight(height);
    const within = block.height > 0 ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0;
    onScroll({
      line: view.state.doc.lineAt(block.from).number - 1 + within,
      lines: view.state.doc.lines,
      atTop: scrollTop <= 0,
      atEnd: scrollTop >= scrollHeight - clientHeight - 1,
    });
  });
  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(text) {
      if (text === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: fromOutside.of(true),
      });
    },
    focus: () => view.focus(),
    // Puts a (0-based) source line at the top of the editor.
    scrollToLine(line) {
      const pos = view.state.doc.line(Math.min(view.state.doc.lines, line + 1)).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start" }) });
    },
    // Used by the context menu, which can't rely on the browser's own clipboard commands.
    getSelection: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    replaceSelection(text) {
      view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input" });
      view.focus();
    },
    selectAll() {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      view.focus();
    },
  };
}
