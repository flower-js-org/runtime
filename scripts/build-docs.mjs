// Assemble the static site in docs/. Each page file owns only the content
// between its markers; this script regenerates the head, header, sidebar,
// intro, pager and footer from scripts/docs/pages.mjs, highlights examples,
// writes redirect stubs for retired URLs, and checks every internal link.
// Usage: node scripts/build-docs.mjs [--check]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { highlight } from "./docs/highlight.mjs";
import { siteFooter, siteHeader } from "./docs/layout.mjs";
import { groups, legacy, pages } from "./docs/pages.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const site = resolve(root, "docs");
const origin = "https://flower.js.org/";
const redirects = JSON.parse(readFileSync(resolve(root, "scripts/docs/redirects.json"), "utf8"));
const START = "<!-- content:start -->";
const END = "<!-- content:end -->";

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const plain = (html) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const prefixOf = (path) => "../".repeat(path.split("/").length - 1);
const pretty = (path) => path.replace(/(^|\/)index\.html$/, "$1");
const two = (n) => String(n).padStart(2, "0");

// Asset URLs carry a content hash so browsers never mix old and new files.
const version = (file) => createHash("sha256").update(readFileSync(resolve(site, file))).digest("hex").slice(0, 12);
const asset = (prefix, file) => `${prefix}${file}?v=${version(file)}`;

export function content(file, html) {
  const start = html.indexOf(START), end = html.indexOf(END);
  if (start < 0 || end < start || html.indexOf(START, start + 1) >= 0) throw new Error(`${file} needs exactly one content marker pair`);
  return html.slice(start + START.length, end).trim();
}

// Top-level <section id> elements of the content become the on-page contents.
function sections(html) {
  const found = [];
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const [, close, name, attributes] = m;
    if (/^(?:img|br|meta|link|input|hr|source|wbr)$/i.test(name)) continue;
    if (!close && depth === 0 && name === "section") {
      const id = attributes.match(/\bid="([^"]+)"/)?.[1];
      const label = attributes.match(/\bdata-toc="([^"]+)"/)?.[1];
      const heading = html.slice(m.index).match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/)?.[1];
      if (!id || !heading) throw new Error(`Top-level section needs an id and an h2: ${attributes}`);
      found.push({ id, label: label ?? escape(plain(heading).replace(/\.$/, "")) });
    }
    depth += close ? -1 : 1;
  }
  return found;
}

// <code class="language-ts" data-src="../file.ts"></code> shows that file, so a
// page can never drift from the example people download.
function includes(file, html) {
  return html.replace(/(<code class="language-(?:ts|sh)" data-src="([^"]+)">)[\s\S]*?(<\/code>)/g, (_, open, src, close) => {
    const source = resolve(site, posix.dirname(file), src);
    if (!existsSync(source)) throw new Error(`${file}: data-src ${src} does not exist`);
    return open + readFileSync(source, "utf8").replace(/\n$/, "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) + close;
  });
}

function head({ path, title, description, prefix, styles, scripts, extra = "" }) {
  const url = origin + pretty(path);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f8f5ec">
<meta name="description" content="${escape(description)}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<link rel="canonical" href="${url}">
<title>${escape(title)}</title>
<link rel="icon" href="${prefix}assets/flower.svg" type="image/svg+xml">
${styles.map((file) => `<link rel="stylesheet" href="${asset(prefix, file)}">`).join("\n")}
${scripts.map((file) => `<script src="${asset(prefix, file)}" defer></script>`).join("\n")}${extra}
</head>`;
}

function sidebar(page, prefix, toc) {
  const nav = groups.map((group) => {
    const items = pages.filter((p) => p.group === group.id).map((p, i) => {
      const here = p === page;
      const href = here ? "#top" : prefix + pretty(p.path) || "./";
      const inner = here && toc.length
        ? `<ol id="section-nav" aria-label="On this page">${toc.map((s) => `<li><a href="#${s.id}">${s.label}</a></li>`).join("")}</ol>` : "";
      return `<li${here ? ' class="current"' : ""}><a href="${href}"${here ? ' aria-current="page"' : ""}><span>${two(i + 1)}</span>${p.label}</a>${inner}</li>`;
    }).join("");
    return `<div class="nav-group"><p class="toc-label">${group.label}</p><ol>${items}</ol></div>`;
  }).join("");
  const note = groups.find((g) => g.id === page.group).note;
  return `<aside class="sidebar"><nav id="site-nav" aria-label="Documentation">${nav}</nav>` +
    `<div class="sidebar-note"><img src="${prefix}assets/flower.svg" width="30" height="30" alt="" aria-hidden="true"><p>${note}</p></div></aside>`;
}

function pager(page, prefix) {
  const i = pages.indexOf(page);
  const link = (p, rel, word) => p ? `<a rel="${rel}" href="${prefix}${pretty(p.path) || ""}"><small>${word} · ${groups.find((g) => g.id === p.group).label}</small>${p.label}</a>` : "<span></span>";
  return `<nav class="pager" aria-label="Previous and next page">${link(pages[i - 1], "prev", "Previous")}${link(pages[i + 1], "next", "Next")}</nav>`;
}

// Group landing pages list their siblings, so the index cannot drift.
function catalogue(page, prefix) {
  if (!page.catalogue) return "";
  const cards = pages.filter((p) => p.group === page.group && p !== page).map((p) =>
    `<a class="card" href="${prefix}${p.path}"><strong>${p.label}</strong><span>${p.lead}</span></a>`).join("");
  return `\n<section id="catalogue" data-toc="Every page"><h2>${page.catalogue}</h2><div class="card-grid">${cards}</div></section>`;
}

function renderPage(page, body) {
  const prefix = prefixOf(page.path);
  const group = groups.find((g) => g.id === page.group);
  const number = pages.filter((p) => p.group === page.group).indexOf(page) + 1;
  const tail = catalogue(page, prefix);
  const toc = sections(body + tail);
  return `${head({ path: page.path, title: `${plain(page.label)} · Flower`, description: page.description, prefix,
    styles: ["chrome.css", "site.css"], scripts: ["site.js"] })}
<body class="doc-page">
<a class="skip-link" href="#main">Skip to content</a>
${siteHeader(prefix, page.group, { menu: true })}
<div class="documentation">
${sidebar(page, prefix, toc)}
<main id="main" tabindex="-1">
<header class="page-intro" id="top"><p class="eyebrow">${group.label} · ${two(number)}</p><h1>${page.title}</h1><p class="lead">${page.lead}</p></header>
<div class="page-content">
${START}
${body}
${END}${tail}
</div>
${pager(page, prefix)}
</main>
</div>
${siteFooter(prefix)}
<p class="sr-only" id="copy-status" role="status" aria-live="polite"></p>
</body>
</html>
`;
}

function renderHome(body) {
  return `${head({ path: "index.html", title: "Flower — A little logic. A lot of bloom.",
    description: "Flower is a reactive TypeScript database built on Rust, QuickJS, and Raft. Plant a little TypeScript logic and let the reactive values grow.",
    prefix: "", styles: ["chrome.css", "site.css", "home.css"], scripts: ["site.js", "redirects.js"] })}
<body class="home-page">
<a class="skip-link" href="#main">Skip to the example</a>
${siteHeader("", null)}
<div class="wrap">
${START}
${body}
${END}
</div>
${siteFooter("")}
<p class="sr-only" id="copy-status" role="status" aria-live="polite"></p>
</body>
</html>
`;
}

// Retired single-page URLs forward their fragments, with a visible fallback.
function renderLegacy(entry) {
  const target = entry.target;
  const group = groups.find((g) => target.startsWith(g.href)) ?? groups[0];
  const list = pages.filter((p) => p.group === group.id).map((p) => `<li><a href="${pretty(p.path)}">${p.label}</a></li>`).join("");
  return `${head({ path: entry.path, title: `${entry.title} has moved — Flower`, description: `The ${entry.title.toLowerCase()} now lives at ${origin}${target}.`,
    prefix: "", styles: ["chrome.css", "site.css"], scripts: [],
    extra: `\n<meta name="robots" content="noindex">\n<script src="${asset("", "redirects.js")}" data-fallback="${target}"></script>\n<noscript><meta http-equiv="refresh" content="0; url=${target}"></noscript>` })}
<body class="doc-page">
${siteHeader("", group.id)}
<main id="main" class="moved">
<header class="page-intro"><p class="eyebrow">Moved</p><h1>This bed has been replanted.</h1><p class="lead">The ${escape(entry.title.toLowerCase())} is now several shorter pages. You should be forwarded to <a href="${target}">${origin}${target}</a>.</p></header>
<ol class="moved-list">${list}</ol>
</main>
${siteFooter("")}
</body>
</html>
`;
}

// Every relative href/src must name a file that exists, and every fragment an id in it.
function checkLinks(outputs) {
  const read = (file) => outputs.get(file) ?? (existsSync(resolve(site, file)) ? readFileSync(resolve(site, file), "utf8") : null);
  const ids = new Map();
  const idsOf = (file) => {
    if (!ids.has(file)) ids.set(file, new Set([...(read(file) ?? "").matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])));
    return ids.get(file);
  };
  const problems = [];
  for (const [file, html] of outputs) {
    for (const m of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const value = m[1].replaceAll("&amp;", "&");
      if (/^[a-z][a-z\d+.-]*:/i.test(value)) continue;
      const [pathPart, hash] = value.split("#");
      let target = posix.normalize(posix.join(posix.dirname(file), pathPart.split("?")[0] || posix.basename(file)));
      if (pathPart.endsWith("/") || pathPart === "." || pathPart === "./" || pathPart === "..") target = posix.join(target, "index.html");
      if (target.startsWith("..")) { problems.push(`${file}: ${value} leaves the site`); continue; }
      if (read(target) === null) { problems.push(`${file}: ${value} → missing ${target}`); continue; }
      if (hash && hash !== "top" && target.endsWith(".html") && !idsOf(target).has(hash)) problems.push(`${file}: ${value} → no #${hash} in ${target}`);
    }
  }
  if (problems.length) throw new Error(`Broken documentation links:\n  ${problems.join("\n  ")}`);
}

function renderRedirects() {
  return `"use strict";
// Generated by scripts/build-docs.mjs. Forwards fragments of retired single-page
// URLs to the shorter pages that replaced them.
(function () {
  var map = ${JSON.stringify(redirects)};
  var script = document.currentScript;
  var page = location.pathname.split("/").pop() || "index.html";
  var id = decodeURIComponent(location.hash.slice(1));
  var target = (map[page] || {})[id];
  if (page === "index.html" && (!target || document.getElementById(id))) return;
  if (target || script.dataset.fallback) location.replace(target || script.dataset.fallback + location.search);
})();
`;
}

export function buildDocs({ check = false } = {}) {
  const outputs = new Map();
  outputs.set("redirects.js", renderRedirects());
  writeIfChanged("redirects.js", outputs.get("redirects.js"), check);
  for (const page of pages) {
    const file = resolve(site, page.path);
    const body = highlight(includes(page.path, content(page.path, readFileSync(file, "utf8"))), page.path);
    outputs.set(page.path, renderPage(page, body));
  }
  outputs.set("index.html", renderHome(highlight(content("index.html", readFileSync(resolve(site, "index.html"), "utf8")), "index.html")));
  for (const entry of legacy) outputs.set(entry.path, renderLegacy(entry));
  // Retired URLs must keep forwarding to real pages and anchors.
  for (const [file, targets] of Object.entries(redirects)) {
    for (const [id, target] of Object.entries(targets)) {
      const [path, hash] = target.split("#");
      const html = outputs.get(!path || path.endsWith("/") ? `${path}index.html` : path);
      if (!html || (hash && !html.includes(`id="${hash}"`))) throw new Error(`Redirect ${file}#${id} → ${target} has no target`);
    }
  }
  // Every page in docs/ must be generated here or by the benchmark publisher.
  const known = new Set([...outputs.keys()]);
  for (const file of walk(site)) {
    if (file.endsWith(".html") && !known.has(file) && !file.startsWith("bench/")) throw new Error(`${file} is not listed in scripts/docs/pages.mjs`);
  }
  checkLinks(new Map([...outputs, ...[...walk(site)].filter((f) => f.startsWith("bench/") && f.endsWith(".html")).map((f) => [f, readFileSync(resolve(site, f), "utf8")])]));
  let changed = 0;
  for (const [file, html] of outputs) changed += writeIfChanged(file, html, check);
  return { pages: outputs.size, changed };
}

function writeIfChanged(file, html, check) {
  const path = resolve(site, file);
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (before === html) return 0;
  if (check) throw new Error(`Run node scripts/build-docs.mjs to refresh docs/${file}`);
  writeFileSync(path, html);
  return 1;
}

function* walk(directory, base = directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path, base);
    else yield relative(base, path).split("\\").join("/");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const result = buildDocs({ check });
  console.log(`${check ? "Verified" : "Built"} ${result.pages} documentation files (${result.changed} changed)`);
}
