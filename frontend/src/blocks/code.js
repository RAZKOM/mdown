const LANGS = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  shell: () => import("highlight.js/lib/languages/shell"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const ALIASES = {
  sh: "bash", zsh: "bash", console: "shell", js: "javascript", jsx: "javascript", mjs: "javascript",
  ts: "typescript", tsx: "typescript", py: "python", rb: "ruby", rs: "rust", cs: "csharp", "c++": "cpp",
  html: "xml", svg: "xml", vue: "xml", xhtml: "xml", yml: "yaml", toml: "ini", ps1: "powershell",
  pwsh: "powershell", md: "markdown", golang: "go", kt: "kotlin", docker: "dockerfile", make: "makefile",
};

let core;

export async function highlightAll(blocks) {
  const wanted = new Map();
  for (const code of blocks) {
    const raw = (/language-([\w+#.-]+)/.exec(code.className) || [])[1]?.toLowerCase();
    const lang = ALIASES[raw] || raw;
    if (lang && LANGS[lang]) wanted.set(code, lang);
  }
  if (!wanted.size) return;
  core ??= (await import("highlight.js/lib/core")).default;
  await Promise.all(
    [...new Set(wanted.values())].map(async (lang) => {
      if (!core.getLanguage(lang)) core.registerLanguage(lang, (await LANGS[lang]()).default);
    }),
  );
  for (const [code, lang] of wanted) {
    const { value } = core.highlight(code.textContent, { language: lang, ignoreIllegals: true });
    code.innerHTML = value;
    code.classList.add("hljs");
  }
}
