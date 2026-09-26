// A message's Markdown, finished in the browser: math typeset, code highlighted and diagrams drawn.
// KaTeX, highlight.js and Mermaid are large, so each loads with the first message that needs it.
import { createEffect, createMemo } from "solid-js";
import { anchorTarget, markdown } from "../markdown.ts";

type Katex = (typeof import("katex"))["default"];
type Highlighter = (typeof import("highlight.js/lib/common"))["default"];
type Mermaid = (typeof import("mermaid"))["default"];

let katex: Promise<Katex> | null = null;
let highlighter: Promise<Highlighter> | null = null;
let mermaid: Promise<Mermaid> | null = null;

const loadKatex = () => katex ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([loaded]) => loaded.default);
const loadHighlighter = () => highlighter ??= import("highlight.js/lib/common").then((loaded) => loaded.default);
const loadMermaid = () => mermaid ??= import("mermaid").then(({ default: loaded }) => {
  // Strict: labels are text, and diagrams cannot bind clicks or run script.
  loaded.initialize({ startOnLoad: false, securityLevel: "strict", theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
  return loaded;
});

/** Typeset math. KaTeX escapes what it is given and, untrusted by default, renders no links or HTML. */
async function typeset(root: HTMLElement): Promise<void> {
  const math = [...root.querySelectorAll<HTMLElement>("code.math-inline, code.math-display")];
  if (math.length === 0) return;
  const loaded = await loadKatex();
  for (const code of math) {
    if (!code.isConnected) continue;
    const display = code.classList.contains("math-display");
    const typeset = document.createElement(display ? "div" : "span");
    typeset.className = display ? "math-display" : "math-inline";
    typeset.innerHTML = loaded.renderToString(code.textContent ?? "", { displayMode: display, throwOnError: false });
    (display ? code.closest("pre") ?? code : code).replaceWith(typeset);
  }
}

/** Highlight code blocks in languages highlight.js knows; the others stay plain, as on GitHub. */
async function highlight(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>(".codeblock:not(.diagram-source) code[class*='language-']:not(.hljs)")];
  if (blocks.length === 0) return;
  const loaded = await loadHighlighter();
  for (const code of blocks) {
    const language = [...code.classList].find((name) => name.startsWith("language-"))?.slice("language-".length);
    if (code.isConnected && language && loaded.getLanguage(language)) loaded.highlightElement(code);
  }
}

const svgs = new Map<string, Promise<string | null>>();
let diagramIds = 0;

/** The SVG for a diagram's source, or null when it does not parse. Each source is drawn once. */
function svgFor(source: string): Promise<string | null> {
  let svg = svgs.get(source);
  if (svg === undefined) {
    svg = loadMermaid()
      .then(async (loaded) => ((await loaded.parse(source, { suppressErrors: true })) ? (await loaded.render(`diagram-${++diagramIds}`, source)).svg : null))
      .catch(() => null);
    svgs.set(source, svg);
  }
  return svg;
}

/** Put each diagram above its source, which stays (hidden) for the Copy button. A source that does not parse shows as code. */
async function drawDiagrams(root: HTMLElement): Promise<void> {
  for (const block of root.querySelectorAll<HTMLElement>(".diagram-source:not(.drawn)")) {
    const svg = await svgFor(block.querySelector("code")?.textContent ?? "");
    if (svg === null || !block.isConnected || block.classList.contains("drawn")) continue;
    const figure = document.createElement("div");
    figure.className = "diagram";
    figure.innerHTML = svg;
    block.querySelector(".codeblock-bar")?.after(figure);
    block.classList.add("drawn");
  }
}

/** In-page links (footnotes) scroll within their message instead of reaching the hash router. */
function followAnchor(event: MouseEvent): void {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href^='#']");
  const href = link?.getAttribute("href");
  if (!link || !href || href.startsWith("#/")) return;
  event.preventDefault();
  const message = event.currentTarget as HTMLElement;
  message.querySelector(`[id="${CSS.escape(anchorTarget(href))}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** `live` marks text still streaming: diagrams wait until it is complete, since half a diagram does not parse. */
export function Markdown(props: { text: string; live?: boolean }) {
  let root!: HTMLDivElement;
  const html = createMemo(() => markdown(props.text));
  createEffect(() => ({ html: html(), live: props.live === true }), ({ live }) => {
    void typeset(root);
    void highlight(root);
    if (!live) void drawDiagrams(root);
  });
  return <div ref={root} class="md" innerHTML={html()} onClick={followAnchor} />;
}
