// Publish a measured multi-group run without copying logs, binaries, or stale
// renderer output. --check verifies the checked-in public JSON and HTML offline.
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { summarizeGroups } from "../bench/multi-group.mjs";
import { renderGroupsReport } from "../bench/multi-group-report.mjs";
import { renderReport } from "../bench/report.mjs";
import { siteFooter, siteHeader } from "./docs/layout.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const markerStart = "<!-- latest-benchmark:start -->";
const markerEnd = "<!-- latest-benchmark:end -->";
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const number = (value, digits = 0) => value.toLocaleString("en-US", { maximumFractionDigits: digits });
const measuredP99 = (histogram) => Number.isSafeInteger(histogram?.samples) && histogram.samples > 0 && finite(histogram.p99) ? histogram.p99 : null;
const latency = (value) => value === null ? "—" : `${number(value, 1)} <small>ms</small>`;
const json = (value) => `${JSON.stringify(value)}\n`;

export function childPath(source, path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || /[\\\x00-\x1f\x7f?#]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error("A child report must be a relative JSON file inside the report directory");
  }
  const directory = dirname(resolve(source));
  const target = resolve(directory, path);
  const local = relative(directory, target);
  if (!local || local.startsWith(`..${sep}`) || local === ".." || !local.endsWith(".json")) {
    throw new Error("A child report must be a relative JSON file inside the report directory");
  }
  return target;
}

export function summarizePublishedRun(report) {
  if (report.kind !== "multi-group" || report.schemaVersion !== 1 ||
      !Number.isSafeInteger(report.options?.groups) || report.options.groups < 1 ||
      !Array.isArray(report.groups) || report.groups.length !== report.options.groups ||
      !Number.isSafeInteger(report.options.nodes) || report.options.nodes < 1 ||
      !finite(report.goodputRps) || !finite(report.latencyMs?.all?.p99) ||
      !finite(report.durationMs) || report.durationMs === 0 ||
      !finite(report.totals?.completed) || report.totals.completed === 0 ||
      !finite(report.totals?.reads) || !finite(report.totals?.mutations) ||
      report.totals.reads + report.totals.mutations !== report.totals.completed ||
      !["fresh", "replica-local"].includes(report.options.readConsistency) ||
      !Number.isFinite(Date.parse(report.loadStartedAt)) || !Number.isFinite(Date.parse(report.loadEndedAt)) ||
      typeof report.passed !== "boolean" || typeof report.correctnessPassed !== "boolean" ||
      (report.passed && !report.correctnessPassed) ||
      typeof report.binary?.sha256 !== "string" || !report.binary.sha256 ||
      typeof report.bundleHash !== "string" || !report.bundleHash) {
    throw new Error("Cannot publish an incomplete or invalid multi-group measurement");
  }
  if (report.durationMs !== Date.parse(report.loadEndedAt) - Date.parse(report.loadStartedAt) ||
      report.goodputRps !== report.totals.completed / (report.durationMs / 1000)) {
    throw new Error("Published throughput must match completed work and its measured interval");
  }
  const crashes = report.groups.flatMap((group) => group.chaos ?? []);
  const recoveries = crashes.map((event) => event.quorumRecoveryMs).filter(finite);
  return {
    goodputRps: report.goodputRps,
    readP99Ms: measuredP99(report.latencyMs.read),
    writeP99Ms: measuredP99(report.latencyMs.mutation),
    groups: report.options.groups,
    replicas: report.options.nodes,
    durationSeconds: report.durationMs / 1000,
    readConsistency: report.options.readConsistency,
    readPercent: report.totals.reads / report.totals.completed * 100,
    mutationPercent: report.totals.mutations / report.totals.completed * 100,
    passed: report.passed,
    correctnessPassed: report.correctnessPassed,
    auditedGroups: report.groups.filter((group) => group.audit?.passed === true).length,
    crashes: crashes.length,
    recoveredCrashes: recoveries.length,
    recoveryMinMs: recoveries.length ? Math.min(...recoveries) : null,
    recoveryMaxMs: recoveries.length ? Math.max(...recoveries) : null,
    measuredAt: report.loadEndedAt,
    cpu: report.environment?.cpu ?? "CPU not recorded",
    transport: report.options.http2 ? "HTTP/2" : "HTTP/1.1",
  };
}

// `root` leads from the embedding page to the site root. The benchmark page
// itself omits the link back to its own workload description.
export function renderPublishedSummary(report, { root = "", workload = true } = {}) {
  const run = summarizePublishedRun(report);
  const local = run.readConsistency === "replica-local";
  const recovery = run.crashes === 0 ? "No injected failure in this run."
    : run.recoveredCrashes !== run.crashes ? `${run.recoveredCrashes}/${run.crashes} injected failures have a recorded quorum recovery.`
    : `${run.crashes} injected leader failures; quorum recovery ${number(run.recoveryMinMs)}–${number(run.recoveryMaxMs)} ms.`;
  return `<section class="benchmark-latest" id="latest-benchmark" aria-labelledby="latest-benchmark-title">
<div class="benchmark-heading"><div><p class="eyebrow">LATEST MEASURED RUN · <time datetime="${escape(run.measuredAt)}">${escape(run.measuredAt.slice(0, 10))}</time></p><h2 id="latest-benchmark-title">A busy day in the garden.</h2></div><img src="${root}assets/flower.svg" width="36" height="36" alt="" aria-hidden="true"></div>
<dl class="benchmark-stats"><div><dt>Global customer calls&nbsp;/&nbsp;s</dt><dd>${number(run.goodputRps)}</dd></div><div><dt>Read p99</dt><dd>${latency(run.readP99Ms)}</dd></div><div><dt>Write p99</dt><dd>${latency(run.writeP99Ms)}</dd></div><div><dt>Independent Raft groups</dt><dd>${run.groups} <small>× ${run.replicas} replicas</small></dd></div></dl>
<p class="benchmark-policy"><strong>${local ? "Replica-local reads: lag is allowed." : "Fresh reads: quorum-confirmed per group."}</strong> ${number(run.readPercent, 1)}% reads / ${number(run.mutationPercent, 1)}% mutations · ${run.transport} · ${number(run.durationSeconds, 1)} measured seconds.</p>
<p><strong>${run.passed ? "Run passed." : "Run failed."} ${run.auditedGroups}/${run.groups} group audits passed.</strong> ${escape(recovery)}</p>
<p class="benchmark-context">${escape(run.cpu)}; all replicas and load generators share one machine. Completed customer calls use the union measurement window; retries, worker traffic, and explicit replays do not inflate throughput. ${local ? "Reads may be stale; mutations and audits retain fresh checks." : "Each group has its own fresh-read boundary."}</p>
<p class="benchmark-links"><a href="${root}bench/latest.html">Charts &amp; every group →</a><a href="${root}bench/latest.json">Raw measurements ↓</a>${workload ? `<a href="${root}operate/benchmarks.html">Workload &amp; reproduction →</a>` : ""}</p>
</section>`;
}

export function replaceSummary(source, summary) {
  const start = source.indexOf(markerStart);
  const end = source.indexOf(markerEnd);
  if (start < 0 || end < start || source.indexOf(markerStart, start + markerStart.length) >= 0 || source.indexOf(markerEnd, end + markerEnd.length) >= 0) {
    throw new Error("Expected exactly one latest-benchmark marker pair");
  }
  return `${source.slice(0, start + markerStart.length)}\n${summary}\n${source.slice(end)}`;
}

// Give generated reports the site's header and footer, plus report-level links.
export function siteNavigation(html, child) {
  const up = child ? "../../" : "../";
  const chrome = `<link rel="stylesheet" href="${up}chrome.css">`;
  const links = `${child ? '<a href="../latest.html">All groups</a>' : '<a href="latest.json">Raw JSON</a>'}<a href="https://github.com/flower-js-org/runtime/blob/main/bench/CPU.md">CPU investigation</a>`;
  const withHead = html.replace("</head>", `${chrome}</head>`);
  const withHeader = withHead.replace(/(<body[^>]*>(?:<a class="skip"[^>]*>[^<]*<\/a>)?)/, `$1${siteHeader(up, "operate")}`);
  const withLinks = withHeader.replace(/(<nav\b[^>]*>)/, `$1${links}`);
  const result = withLinks.replace("</body>", `${siteFooter(up)}</body>`);
  if (result === withLinks || withLinks === withHeader || withHeader === withHead || withHead === html) throw new Error("A benchmark report is missing its head, body or section navigation");
  return result;
}

export async function publishBenchResults({ source = resolve(root, "bench/results/latest.json"), site = resolve(root, "docs"), check = false } = {}) {
  const report = JSON.parse(await readFile(source, "utf8"));
  const summary = renderPublishedSummary(report);
  const output = new Map();
  const published = structuredClone(report);
  const children = [];
  for (let i = 0; i < report.groups.length; i++) {
    const group = report.groups[i];
    const child = JSON.parse(await readFile(childPath(source, group.json), "utf8"));
    children.push(child);
    if (child.binary?.sha256 !== report.binary?.sha256 || child.bundleHash !== report.bundleHash ||
        child.loadStartedAt !== group.loadStartedAt || child.loadEndedAt !== group.loadEndedAt ||
        child.options?.readConsistency !== report.options.readConsistency || child.audit?.passed !== group.audit?.passed) {
      throw new Error(`Group ${i} does not match its aggregate report`);
    }
    const stem = `latest-groups/group-${i}`;
    published.groups[i].html = `${stem}.html`;
    published.groups[i].json = `${stem}.json`;
    output.set(`bench/${stem}.json`, json(child));
    const display = child.cpuProfile ? { ...child, cpuProfile: { ...child.cpuProfile,
      relativePath: null, outputPath: "Raw sample retained with the local benchmark artifacts" } } : child;
    output.set(`bench/${stem}.html`, siteNavigation(renderReport(display), true));
  }
  const reconstructed = summarizeGroups(children, report.options);
  for (const key of ["durationMs", "synchronizedOverlapMs", "startSkewMs", "loadStartedAt", "loadEndedAt",
    "goodputRps", "totals", "latencyMs", "runtime", "binary", "driver", "bundleHash"]) {
    if (!isDeepStrictEqual(report[key], reconstructed[key])) throw new Error(`Aggregate ${key} does not match child measurements`);
  }
  const derivedGroupFields = new Set(["customerReadLatencyMs", "customerMutationLatencyMs"]);
  for (let i = 0; i < reconstructed.groups.length; i++) {
    for (const [key, value] of Object.entries(reconstructed.groups[i])) {
      // Older reports retain the per-method buckets in their children. Derive
      // newly exposed splits from those measurements, never aggregate p99s.
      if (derivedGroupFields.has(key) && !Object.hasOwn(report.groups[i], key)) {
        published.groups[i][key] = value;
        continue;
      }
      if (!isDeepStrictEqual(report.groups[i][key], value)) throw new Error(`Group ${i} ${key} does not match child measurements`);
    }
  }
  if ((report.correctnessPassed && !reconstructed.correctnessPassed) ||
      (report.passed && children.some((child) => child.passed !== true))) {
    throw new Error("Aggregate passing verdict does not match child correctness or profiling");
  }
  output.set("bench/latest.json", json(published));
  output.set("bench/latest.html", siteNavigation(renderGroupsReport(published), false));
  const embeds = [["index.html", summary], ["operate/benchmarks.html", renderPublishedSummary(report, { root: "../", workload: false })]];
  for (const [file, html] of embeds) {
    output.set(file, replaceSummary(await readFile(resolve(site, file), "utf8"), html));
  }
  if (check) {
    for (const [file, content] of output) {
      if (await readFile(resolve(site, file), "utf8") !== content) throw new Error(`Published benchmark file is stale: ${file}`);
    }
  } else {
    for (const [file, content] of output) {
      await mkdir(dirname(resolve(site, file)), { recursive: true });
      await writeFile(resolve(site, file), content);
    }
    // This directory belongs to this publisher. Remove only its numbered child
    // outputs after a run with fewer groups; never walk or copy arbitrary files.
    const directory = resolve(site, "bench/latest-groups");
    for (const file of await readdir(directory)) {
      if (/^group-\d+\.(?:html|json)$/.test(file) && !output.has(`bench/latest-groups/${file}`)) await unlink(resolve(directory, file));
    }
  }
  return { files: output.size, bytes: [...output.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const paths = args.filter((arg) => arg !== "--check");
  if (paths.length > 1 || paths.some((arg) => arg.startsWith("-"))) throw new Error("Usage: node scripts/publish-bench-results.mjs [report.json] [--check]");
  const source = paths[0] ? resolve(paths[0]) : resolve(root, check ? "docs/bench/latest.json" : "bench/results/latest.json");
  const result = await publishBenchResults({ source, check });
  console.log(`${check ? "Verified" : "Published"} ${result.files} benchmark files and page sections (${number(result.bytes / 1024)} KiB)`);
}
