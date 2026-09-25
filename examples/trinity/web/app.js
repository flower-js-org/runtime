// Sign-in, organization choice, the app shell and hash routing.
//   #/                 new session
//   #/sessions/<id>    a session (deep links from Slack and GitHub land here)
//   #/computers  #/automations  #/memory  #/usage  #/settings
//   #/connect/slack?grant=…   link a Slack account (the Slack worker sends people here)
import { client, currentAuth, devLogin, HttpError, lastSubject, setToken, switchOrg } from "./api.js";
import { AutomationsPage, ComputersPage, MemoryPage, SettingsPage, SlackConnectPage, UsagePage } from "./pages.js";
import { html, raw, relativeTime, STATUS_LABELS } from "./render.js";
import { NewSessionView, SessionView } from "./session.js";
import { busy, ICONS, openDialog, report, setAuthLostHandler, slug, toast } from "./ui.js";

const PAGES = { computers: ComputersPage, automations: AutomationsPage, memory: MemoryPage, usage: UsagePage, settings: SettingsPage };

const root = document.getElementById("root");
/** Aborted on sign-out and organization switches, which rebuild everything. */
let scope = new AbortController();
let view = null;
let expiry = 0;
/** The session list, null until its first value arrives. */
let sessions = null;

const app = {
  me: null,
  /** Text to restore in a session's composer after its first message failed to send. */
  drafts: new Map(),
  toggleDrawer(open) {
    const shell = root.querySelector(".shell");
    if (!shell) return;
    const next = open ?? !shell.classList.contains("drawer-open");
    shell.classList.toggle("drawer-open", next);
    shell.querySelector(".scrim").hidden = !next;
    if (next) shell.querySelector(".sidebar a, .sidebar button")?.focus();
  },
  refreshOrgs,
};

setAuthLostHandler((message) => boot(message, true));
window.addEventListener("hashchange", () => {
  if (root.querySelector(".shell")) route();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && root.querySelector(".shell.drawer-open")) app.toggleDrawer(false);
});
boot();

/** Start over from the stored token. The hash is kept, so a deep link survives signing in. */
function boot(message = "", expired = false) {
  scope.abort();
  scope = new AbortController();
  view?.destroy();
  view = null;
  clearTimeout(expiry);
  if (expired) setToken(null);
  const auth = currentAuth();
  if (auth === null || auth.expiresAt <= Date.now() || auth.claims.role !== "user") {
    app.me = null;
    return signIn(message);
  }
  app.me = auth.claims.sub;
  expiry = setTimeout(() => boot("Your sign-in expired. Please sign in again.", true), Math.min(auth.expiresAt - Date.now(), 2 ** 31 - 1));
  if (!auth.claims.org) return chooseOrg();
  shell();
}

function signIn(message) {
  document.title = "Sign in · Trinity";
  root.innerHTML = html`<main class="auth"><div class="auth-card">
<div class="brand"><span class="brand-mark" aria-hidden="true"></span>Trinity</div>
<h1>Sign in</h1>
${message ? html`<p class="notice" role="status">${message}</p>` : ""}
<form class="stack">
<label>User name<input name="subject" required maxlength="128" pattern="[A-Za-z0-9_.@+\\-]+" autocomplete="username" value="${lastSubject()}"></label>
<label><span>Display name <span class="muted">(optional)</span></span><input name="name" maxlength="200" autocomplete="name"></label>
<button type="submit" class="primary">Continue</button>
</form>
<p class="muted small">Development sign-in: this gateway lets anyone sign in under any user name.</p>
</div></main>`.html;
  const form = root.querySelector("form");
  form.elements.subject.focus();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const signedIn = await busy(form.querySelector("button"), async () => {
      try {
        await devLogin(form.elements.subject.value.trim(), form.elements.name.value.trim());
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) throw new Error("Development sign-in is off on this gateway (set TRINITY_DEV_LOGIN=1)");
        throw error;
      }
      return true;
    }, "Signing in");
    if (signedIn) boot();
  });
}

async function chooseOrg() {
  document.title = "Choose an organization · Trinity";
  const auth = currentAuth();
  root.innerHTML = html`<main class="auth"><div class="auth-card wide">
<div class="brand"><span class="brand-mark" aria-hidden="true"></span>Trinity</div>
<h1>Choose an organization</h1>
<p class="muted">Signed in as ${auth.claims.name ?? auth.claims.sub}. <button type="button" class="link" data-action="sign-out">Use another name</button></p>
<div class="org-list"><p class="muted">Loading…</p></div>
<form class="stack create-org"><h2>New organization</h2>
<label>Name<input name="name" required maxlength="200" placeholder="Acme"></label>
<label>ID<input name="id" required maxlength="128" pattern="[A-Za-z0-9_.\\-]+" placeholder="acme"><span class="hint">Permanent; used in links and settings.</span></label>
<button type="submit" class="primary">Create organization</button></form>
</div></main>`.html;
  const form = root.querySelector(".create-org");
  let idEdited = false;
  form.elements.id.addEventListener("input", () => { idEdited = true; });
  form.elements.name.addEventListener("input", () => {
    if (!idEdited) form.elements.id.value = slug(form.elements.name.value, false);
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const created = await busy(form.querySelector("button"), async () => {
      const id = form.elements.id.value.trim();
      await client.mutate("org.create", { id, name: form.elements.name.value.trim() }, { requestId: `org:${id}:${app.me}`, retry: true });
      await switchOrg(id);
      return true;
    }, "Creating the organization");
    if (created) boot();
  });
  root.querySelector("[data-action=sign-out]").addEventListener("click", () => signOut());
  const list = root.querySelector(".org-list");
  try {
    const { value: orgs } = await client.query("org.mine", null, { signal: scope.signal, retry: true });
    if (orgs.length === 1) return pick(orgs[0].id, null);
    list.innerHTML = orgs.length === 0
      ? html`<p class="muted">You are not a member of any organization yet. Create one, or ask an admin to add <strong>${auth.claims.sub}</strong>.</p>`.html
      : orgs.map((org) => html`<button type="button" class="org-choice" data-org="${org.id}"><span class="org-name">${org.name}</span><span class="muted small">${org.id} · ${org.role}</span></button>`.html).join("");
    list.addEventListener("click", (event) => {
      const button = event.target.closest("[data-org]");
      if (button) pick(button.dataset.org, button);
    });
  } catch (error) {
    if (scope.signal.aborted) return;
    report(error, "Listing organizations");
    list.innerHTML = html`<p class="muted">Could not list your organizations.</p>`.html;
  }
}

async function pick(org, button) {
  if (await busy(button, async () => { await switchOrg(org); return true; }, "Switching organization")) boot();
}

function signOut() {
  setToken(null);
  history.replaceState(null, "", "#/");
  boot();
}

function shell() {
  const { claims } = currentAuth();
  sessions = null;
  root.innerHTML = html`<div class="shell">
<aside class="sidebar" id="sidebar" aria-label="Navigation">
<div class="sidebar-head"><a class="brand" href="#/"><span class="brand-mark" aria-hidden="true"></span>Trinity</a>
<button type="button" class="icon-button close-drawer" data-action="close-drawer" aria-label="Close menu">×</button></div>
<label class="sr-only" for="org-select">Organization</label>
<select id="org-select" class="org-select"><option value="${claims.org}">${claims.org}</option></select>
<a class="button primary new-session" href="#/">New session</a>
<div class="list-head"><h2>Sessions</h2><label class="toggle"><input type="checkbox" id="show-archived"> Archived</label></div>
<nav class="session-list" aria-label="Sessions"><p class="muted small pad">Loading…</p></nav>
<nav class="sidebar-nav" aria-label="Organization">${Object.keys(PAGES).map((page) => html`<a href="#/${page}" data-page="${page}">${page[0].toUpperCase() + page.slice(1)}</a>`)}</nav>
<div class="sidebar-foot"><span class="me" title="${claims.sub}">${claims.name ?? claims.sub}</span><button type="button" class="ghost" data-action="sign-out">Sign out</button></div>
</aside>
<div class="scrim" data-action="close-drawer" hidden></div>
<main class="main" id="main"></main>
</div>`.html;
  const shellEl = root.querySelector(".shell");
  shellEl.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (target?.dataset.action === "close-drawer") app.toggleDrawer(false);
    else if (target?.dataset.action === "sign-out" && target.closest(".sidebar")) signOut();
  });
  shellEl.querySelector("#org-select").addEventListener("change", (event) => changeOrg(event.target));
  shellEl.querySelector("#show-archived").addEventListener("change", watchSessions);
  const ticker = setInterval(renderSessions, 30_000);
  scope.signal.addEventListener("abort", () => clearInterval(ticker));
  refreshOrgs();
  watchSessions();
  route();
}

async function refreshOrgs() {
  const select = document.getElementById("org-select");
  if (!select) return;
  try {
    const { value: orgs } = await client.query("org.mine", null, { signal: scope.signal, retry: true });
    const current = currentAuth()?.claims.org;
    select.innerHTML = html`${orgs.map((org) => html`<option value="${org.id}" ${org.id === current ? raw("selected") : ""}>${org.name}</option>`)}
<option value="" disabled>──────────</option><option value="__new">New organization…</option>`.html;
  } catch (error) {
    if (!scope.signal.aborted) report(error, "Listing organizations");
  }
}

async function changeOrg(select) {
  const current = currentAuth().claims.org;
  const chosen = select.value;
  select.value = current;
  // A session that failed to open may belong to the organization being switched to; keep its link.
  const keep = view instanceof SessionView && view.unavailable;
  const done = () => {
    if (!keep) history.replaceState(null, "", "#/");
    boot();
  };
  if (chosen === "__new") {
    return openDialog({
      title: "New organization",
      body: html`<label>Name<input name="name" required maxlength="200"></label>
<label>ID<input name="id" required maxlength="128" pattern="[A-Za-z0-9_.\\-]+"><span class="hint">Permanent; leave empty to derive it from the name.</span></label>`,
      submitLabel: "Create",
      submit: async (form) => {
        const name = form.elements.name.value.trim();
        const id = form.elements.id.value.trim() || slug(name, false);
        await client.mutate("org.create", { id, name }, { requestId: `org:${id}:${app.me}`, retry: true });
        await switchOrg(id);
        setTimeout(done);
      },
    });
  }
  if (chosen && chosen !== current && await busy(select, async () => { await switchOrg(chosen); return true; }, "Switching organization")) done();
}

async function watchSessions() {
  const toggle = document.getElementById("show-archived");
  const nav = root.querySelector(".session-list");
  if (!toggle || !nav) return;
  watchSessions.abort?.abort();
  const local = new AbortController();
  watchSessions.abort = local;
  sessions = null;
  const signal = AbortSignal.any([scope.signal, local.signal]);
  try {
    for await (const { value } of client.subscribe("session.list", { limit: 100, archived: toggle.checked }, { signal })) {
      sessions = value;
      renderSessions();
    }
  } catch (error) {
    if (signal.aborted) return;
    report(error, "Session list");
    nav.innerHTML = html`<p class="muted small pad">The session list stopped updating. <button type="button" class="link" data-retry>Retry</button></p>`.html;
    nav.querySelector("[data-retry]").addEventListener("click", watchSessions);
  }
}

function currentSession() {
  const match = /^#\/sessions\/([^/]+)/.exec(location.hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function renderSessions() {
  const nav = root.querySelector(".session-list");
  if (!nav) return;
  const current = currentSession();
  if (sessions === null) return;
  if (sessions.length === 0) {
    nav.innerHTML = html`<p class="muted small pad">${document.getElementById("show-archived")?.checked ? "No archived sessions." : "No sessions yet."}</p>`.html;
    return;
  }
  nav.innerHTML = sessions.map((s) => html`<a class="session-item" href="#/sessions/${encodeURIComponent(s.id)}" ${s.id === current ? raw('aria-current="page"') : ""}>
<span class="session-title">${s.private ? raw(ICONS.lock) : ""}${s.title ?? "Untitled session"}</span>
<span class="session-meta">${s.status === "idle" ? "" : html`<span class="badge status-${s.status}">${STATUS_LABELS[s.status] ?? s.status}</span>`}${s.source ? html`<span class="tag">${s.source.surface}</span>` : ""}<time datetime="${new Date(s.updatedAt).toISOString()}">${relativeTime(s.updatedAt)}</time></span></a>`.html).join("");
}

function route() {
  const main = document.getElementById("main");
  if (!main) return;
  view?.destroy();
  const [section] = location.hash.replace(/^#\/?/, "").split("/");
  const session = currentSession();
  if (session !== null) view = new SessionView(main, session, app);
  else if (section === "connect") view = new SlackConnectPage(main, app);
  else if (Object.hasOwn(PAGES, section)) view = new PAGES[section](main, app);
  else view = new NewSessionView(main, app);
  view.mount();
  for (const link of root.querySelectorAll(".sidebar-nav a")) {
    if (link.dataset.page === section) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  renderSessions();
  app.toggleDrawer(false);
}

window.addEventListener("unhandledrejection", (event) => {
  if (event.reason?.name === "AbortError") return event.preventDefault();
  toast(event.reason?.message ?? String(event.reason));
});
