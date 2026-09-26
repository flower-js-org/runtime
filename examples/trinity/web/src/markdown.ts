// Markdown to HTML as GitHub renders it: CommonMark with GitHub's extensions (tables, task lists,
// strikethrough, autolinks, footnotes, alerts), math, emoji shortcodes and inline HTML. No DOM here,
// so Node tests import it. The view then loads what only some messages need: KaTeX for math,
// highlight.js for code and Mermaid for diagrams (session/Markdown.tsx).
//
// Model, user and tool text is untrusted. Everything it produces passes the sanitizer, whose default
// schema follows GitHub's; only what the plugins after it add (alerts, code block bars) escapes it.
// Images become links: a model steered by what it read could otherwise leak data through the
// address of an image the browser fetches on its own.
import type { Element, ElementContent, Root } from "hast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as Schema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGemoji from "remark-gemoji";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/** Links a view may render from untrusted data, as the sanitizer allows them. */
export const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

const schema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // remark-math marks math as code, for the view to typeset.
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
};

const classes = (element: Element) => (Array.isArray(element.properties.className) ? element.properties.className.map(String) : []);

/**
 * Visit elements depth first. A visitor may replace the element it is given (say, by a wrapper around
 * it) and returns the element whose children to visit next, if not the one it was given.
 */
function walk(parent: Root | Element, visit: (element: Element, parent: Root | Element, index: number) => Element | void): void {
  for (let index = 0; index < parent.children.length; index++) {
    const child = parent.children[index]!;
    if (child.type === "element") walk(visit(child, parent, index) ?? child, visit);
  }
}

const element = (tagName: string, properties: Element["properties"], children: ElementContent[]): Element => ({ type: "element", tagName, properties, children });
const text = (value: string): ElementContent => ({ type: "text", value });

/** Fit GitHub's HTML into a conversation: headings below the page's, links out in new tabs, bars on code blocks, scrolling tables. */
function rehypeConversation() {
  return (tree: Root) => {
    walk(tree, (node, parent, index) => {
      const heading = /^h([1-6])$/.exec(node.tagName);
      if (heading) node.tagName = `h${Math.min(6, Number(heading[1]) + 2)}`;
      else if (node.tagName === "img") {
        const src = String(node.properties.src ?? "");
        const alt = String(node.properties.alt ?? "") || src;
        parent.children[index] = SAFE_URL.test(src) ? element("a", { href: src, target: "_blank", rel: ["noopener", "noreferrer"] }, [text(alt)]) : text(alt);
      } else if (node.tagName === "a" && node.properties.href !== undefined) {
        const href = String(node.properties.href);
        // Relative links would only reach the gateway: there is no repository here to resolve them against.
        if (SAFE_URL.test(href)) {
          node.properties.target = "_blank";
          node.properties.rel = ["noopener", "noreferrer"];
        } else if (!href.startsWith("#")) delete node.properties.href;
      } else if (node.tagName === "table") {
        parent.children[index] = element("div", { className: ["table-wrap"] }, [node]);
        return node;
      } else if (node.tagName === "pre" && node.children[0]?.type === "element" && node.children[0].tagName === "code" && !classes(node.children[0]).includes("math-display")) {
        const language = classes(node.children[0]).find((name) => name.startsWith("language-"))?.slice("language-".length) ?? "";
        parent.children[index] = element("div", { className: language === "mermaid" ? ["codeblock", "diagram-source"] : ["codeblock"] }, [
          element("div", { className: ["codeblock-bar"] }, [
            element("span", {}, [text(language)]),
            element("button", { type: "button", className: ["copy"], dataAction: "copy" }, [text("Copy")]),
          ]),
          node,
        ]);
        return node;
      }
    });
  };
}

// GitHub's alert icons (Octicons, MIT): info, light-bulb, report, alert and stop.
const ALERTS: Record<string, string> = {
  note: "M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z",
  tip: "M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z",
  important: "M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z",
  warning: "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z",
  caution: "M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z",
};

/** GitHub's alerts: a blockquote whose first line is [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION]. */
function rehypeAlerts() {
  return (tree: Root) => {
    walk(tree, (node, parent, index) => {
      if (node.tagName !== "blockquote") return;
      const first = node.children.find((child): child is Element => child.type === "element");
      const lead = first?.tagName === "p" ? first.children[0] : undefined;
      const marker = lead?.type === "text" ? /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i.exec(lead.value) : null;
      if (!first || lead?.type !== "text" || !marker) return;
      const kind = marker[1]!.toLowerCase();
      lead.value = lead.value.slice(marker[0].length);
      if (lead.value === "" && first.children.length === 1) node.children.splice(node.children.indexOf(first), 1);
      const icon = element("svg", { className: ["octicon"], viewBox: "0 0 16 16", width: 16, height: 16, ariaHidden: "true" }, [element("path", { d: ALERTS[kind]! }, [])]);
      const title = element("p", { className: ["markdown-alert-title"] }, [icon, text(kind[0]!.toUpperCase() + kind.slice(1))]);
      parent.children[index] = element("div", { className: ["markdown-alert", `markdown-alert-${kind}`] }, [title, ...node.children]);
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkGemoji)
  // The sanitizer prefixes ids with "user-content-", as GitHub does; links keep the bare names (see anchorTarget).
  .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: "" })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(rehypeAlerts)
  .use(rehypeConversation)
  .use(rehypeStringify)
  .freeze();

/** The element an in-page link (a footnote, a heading) points to, among the elements of one rendered message. */
export const anchorTarget = (href: string) => `user-content-${decodeURIComponent(href.replace(/^#/, ""))}`;

/** Render Markdown to sanitized HTML. */
export function markdown(source: unknown): string {
  return String(processor.processSync(String(source ?? "")));
}
