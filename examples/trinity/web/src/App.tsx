// Sign-in, organization choice and the app shell. Deep links (#/sessions/<id> from Slack and GitHub)
// survive signing in, since the hash is kept.
import { createEffect, createSignal, Errored, For, Match, onSettled, Show, Switch } from "solid-js";
import { auth, client, currentAuth, devLogin, HttpError, lastSubject, switchOrg, type Auth } from "./api.ts";
import { relativeTime, STATUS_LABELS, isoTime } from "./format.ts";
import { AutomationsPage } from "./pages/Automations.tsx";
import { ComputersPage } from "./pages/Computers.tsx";
import { MemoryPage } from "./pages/Memory.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { SlackConnectPage } from "./pages/SlackConnect.tsx";
import { UsagePage } from "./pages/Usage.tsx";
import { NewSessionView } from "./session/NewSession.tsx";
import { SessionView, unavailableSession } from "./session/Session.tsx";
import {
  Brand, busy, drawerOpen, field, live, load, LockIcon, navigate, now, openDialog, orgsVersion, report, route, sessionHref, signInNotice, signOut, slug, submitter, toggleDrawer, Toasts,
} from "./ui.tsx";

const PAGES = ["computers", "automations", "memory", "usage", "settings"] as const;

/** Someone signed in as a user whose token has not expired. */
function signedIn(value: Auth | null): Auth | null {
  return value !== null && value.expiresAt > Date.now() && value.claims.role === "user" ? value : null;
}

export function App() {
  createEffect(() => auth(), (value) => {
    if (value === null || value.expiresAt === Infinity) return;
    const timer = setTimeout(() => signOut("Your sign-in expired. Please sign in again."), Math.min(value.expiresAt - Date.now(), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  });
  return (
    <>
      {/* Keyed: a new token (signing in, switching organizations) rebuilds everything under it. */}
      <Show when={signedIn(auth())} keyed fallback={<SignIn />}>
        {(value) => (value.claims.org ? <Shell /> : <ChooseOrg />)}
      </Show>
      <Toasts />
    </>
  );
}

function SignIn() {
  document.title = "Sign in · Trinity";
  let form!: HTMLFormElement;
  onSettled(() => field(form, "subject").focus());
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    void busy(submitter(event), async () => {
      try {
        await devLogin(field(form, "subject").value.trim(), field(form, "name").value.trim());
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) throw new Error("Development sign-in is off on this gateway (set TRINITY_DEV_LOGIN=1)");
        throw error;
      }
    }, "Signing in");
  };
  return (
    <main class="auth">
      <div class="auth-card">
        <div class="brand"><Brand /></div>
        <h1>Sign in</h1>
        <Show when={signInNotice()}><p class="notice" role="status">{signInNotice()}</p></Show>
        <form ref={form} class="stack" onSubmit={submit}>
          <label>User name<input name="subject" required maxlength="128" pattern="[A-Za-z0-9_.@+\-]+" autocomplete="username" value={lastSubject()} /></label>
          <label><span>Display name <span class="muted">(optional)</span></span><input name="name" maxlength="200" autocomplete="name" /></label>
          <button type="submit" class="primary">Continue</button>
        </form>
        <p class="muted small">Development sign-in: this gateway lets anyone sign in under any user name.</p>
      </div>
    </main>
  );
}

type MyOrg = { id: string; name: string; role: string };

function ChooseOrg() {
  document.title = "Choose an organization · Trinity";
  const { claims } = currentAuth()!;
  const [orgs, setOrgs] = createSignal<MyOrg[] | null | "failed">(null);
  onSettled(() => {
    client().query("org.mine", null, { retry: true }).then(async ({ value }) => {
      if (value.length === 1) return pick(value[0]!.id, null);
      setOrgs(value);
    }, (error) => {
      report(error, "Listing organizations");
      setOrgs("failed");
    });
  });
  let idEdited = false;
  let form!: HTMLFormElement;
  const create = (event: SubmitEvent) => {
    event.preventDefault();
    void busy(submitter(event), async () => {
      const id = field(form, "id").value.trim();
      await client().mutate("org.create", { id, name: field(form, "name").value.trim() }, { requestId: `org:${id}:${claims.sub}`, retry: true });
      await switchOrg(id);
    }, "Creating the organization");
  };
  return (
    <main class="auth">
      <div class="auth-card wide">
        <div class="brand"><Brand /></div>
        <h1>Choose an organization</h1>
        <p class="muted">Signed in as {claims.name ?? claims.sub}. <button type="button" class="link" onClick={() => signOut()}>Use another name</button></p>
        <div class="org-list">
          <Switch>
            <Match when={orgs() === null}><p class="muted">Loading…</p></Match>
            <Match when={orgs() === "failed"}><p class="muted">Could not list your organizations.</p></Match>
            <Match when={Array.isArray(orgs()) && (orgs() as MyOrg[]).length === 0}>
              <p class="muted">You are not a member of any organization yet. Create one, or ask an admin to add <strong>{claims.sub}</strong>.</p>
            </Match>
            <Match when={Array.isArray(orgs())}>
              <For each={orgs() as MyOrg[]}>
                {(org) => (
                  <button type="button" class="org-choice" onClick={(event) => void pick(org.id, event.currentTarget)}>
                    <span class="org-name">{org.name}</span><span class="muted small">{org.id} · {org.role}</span>
                  </button>
                )}
              </For>
            </Match>
          </Switch>
        </div>
        <form ref={form} class="stack create-org" onSubmit={create}>
          <h2>New organization</h2>
          <label>Name<input name="name" required maxlength="200" placeholder="Acme" onInput={(event) => { if (!idEdited) field(form, "id").value = slug(event.currentTarget.value, false); }} /></label>
          <label>ID<input name="id" required maxlength="128" pattern="[A-Za-z0-9_.\-]+" placeholder="acme" onInput={() => { idEdited = true; }} /><span class="hint">Permanent; used in links and settings.</span></label>
          <button type="submit" class="primary">Create organization</button>
        </form>
      </div>
    </main>
  );
}

const pick = (org: string, button: HTMLButtonElement | null) => busy(button, () => switchOrg(org), "Switching organization");

/**
 * The token's organization, once the user's organizations confirm they still belong to it. Someone
 * removed from it (or whose organization is gone) chooses another instead of failing every query.
 */
function Shell() {
  const { claims } = currentAuth()!;
  const orgs = load(() => (orgsVersion(), client().query("org.mine", null, { retry: true })), "Listing organizations");
  return (
    <Errored fallback={(_, retry) => (
      <main class="auth"><div class="auth-card"><p class="muted">Could not list your organizations.</p><button type="button" class="primary" onClick={retry}>Retry</button></div></main>
    )}>
      <Switch fallback={<Workspace orgs={orgs() ?? []} />}>
        <Match when={orgs() === null}>{null}</Match>
        <Match when={!orgs()!.some((org) => org.id === claims.org)}><ChooseOrg /></Match>
      </Switch>
    </Errored>
  );
}

function Workspace(props: { orgs: MyOrg[] }) {
  const { claims } = currentAuth()!;
  const [archived, setArchived] = createSignal(false);

  // Navigating closes the drawer; opening it moves focus into it.
  createEffect(() => route().section + (route().session ?? ""), () => { toggleDrawer(false); }, { defer: true });
  let sidebar!: HTMLElement;
  createEffect(() => drawerOpen(), (open) => { if (open) sidebar.querySelector<HTMLElement>("a, button")?.focus(); }, { defer: true });
  onSettled(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && drawerOpen()) toggleDrawer(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });

  const changeOrg = (select: HTMLSelectElement) => {
    const chosen = select.value;
    select.value = claims.org!;
    // A session that failed to open may belong to the organization being switched to; keep its link.
    const session = route().session;
    const leave = () => { if (session === null || unavailableSession() !== session) navigate("#/", true); };
    if (chosen === "__new") {
      return openDialog({
        title: "New organization",
        body: () => (
          <>
            <label>Name<input name="name" required maxlength="200" /></label>
            <label>ID<input name="id" maxlength="128" pattern="[A-Za-z0-9_.\-]+" /><span class="hint">Permanent; leave empty to derive it from the name.</span></label>
          </>
        ),
        submitLabel: "Create",
        submit: async (form) => {
          const name = field(form, "name").value.trim();
          const id = field(form, "id").value.trim() || slug(name, false);
          await client().mutate("org.create", { id, name }, { requestId: `org:${id}:${claims.sub}`, retry: true });
          leave();
          await switchOrg(id);
        },
      });
    }
    if (chosen && chosen !== claims.org) {
      leave();
      void busy(select, () => switchOrg(chosen), "Switching organization");
    }
  };

  return (
    <div class={["shell", { "drawer-open": drawerOpen() }]}>
      <aside ref={sidebar} class="sidebar" id="sidebar" aria-label="Navigation">
        <div class="sidebar-head">
          <a class="brand" href="#/"><Brand /></a>
          <button type="button" class="icon-button close-drawer" aria-label="Close menu" onClick={() => toggleDrawer(false)}>×</button>
        </div>
        <label class="sr-only" for="org-select">Organization</label>
        <select id="org-select" class="org-select" onChange={(event) => changeOrg(event.currentTarget)}>
          <For each={props.orgs}>{(org) => <option value={org.id} selected={org.id === claims.org}>{org.name}</option>}</For>
          <option value="" disabled>──────────</option>
          <option value="__new">New organization…</option>
        </select>
        <a class="button primary new-session" href="#/">New session</a>
        <div class="list-head">
          <h2>Sessions</h2>
          <label class="toggle"><input type="checkbox" checked={archived()} onChange={(event) => setArchived(event.currentTarget.checked)} /> Archived</label>
        </div>
        <nav class="session-list" aria-label="Sessions">
          <Errored fallback={(_, retry) => <p class="muted small pad">The session list stopped updating. <button type="button" class="link" onClick={retry}>Retry</button></p>}>
            <SessionList archived={archived()} />
          </Errored>
        </nav>
        <nav class="sidebar-nav" aria-label="Organization">
          <For each={PAGES}>
            {(page) => <a href={`#/${page}`} aria-current={route().section === page ? "page" : undefined}>{page[0]!.toUpperCase() + page.slice(1)}</a>}
          </For>
        </nav>
        <div class="sidebar-foot">
          <span class="me" title={claims.sub}>{claims.name ?? claims.sub}</span>
          <button type="button" class="ghost" onClick={() => { navigate("#/", true); signOut(); }}>Sign out</button>
        </div>
      </aside>
      <div class="scrim" hidden={!drawerOpen()} onClick={() => toggleDrawer(false)} />
      <main class="main" id="main">
        <Switch fallback={<NewSessionView />}>
          <Match when={route().session} keyed>{(id) => <SessionView id={id} />}</Match>
          <Match when={route().section === "connect"}><SlackConnectPage /></Match>
          <Match when={route().section === "computers"}><ComputersPage /></Match>
          <Match when={route().section === "automations"}><AutomationsPage /></Match>
          <Match when={route().section === "memory"}><MemoryPage /></Match>
          <Match when={route().section === "usage"}><UsagePage /></Match>
          <Match when={route().section === "settings"}><SettingsPage /></Match>
        </Switch>
      </main>
    </div>
  );
}

/** The organization's sessions, live. A failure reaches the Errored boundary around it, whose retry rebuilds it. */
function SessionList(props: { archived: boolean }) {
  const sessions = live(() => client().subscribe("session.list", { limit: 100, archived: props.archived }), "Session list");
  return (
    <Show when={sessions()} fallback={<p class="muted small pad">Loading…</p>}>
      {(list) => (
        <For each={list()} keyed={(each) => each.id} fallback={<p class="muted small pad">{props.archived ? "No archived sessions." : "No sessions yet."}</p>}>
          {(s) => (
            <a class="session-item" href={sessionHref(s().id)} aria-current={route().session === s().id ? "page" : undefined}>
              <span class="session-title"><Show when={s().private}><LockIcon /></Show>{s().title ?? "Untitled session"}</span>
              <span class="session-meta">
                <Show when={s().status !== "idle"}><span class={["badge", `status-${s().status}`]}>{STATUS_LABELS[s().status] ?? s().status}</span></Show>
                <Show when={s().source}>{(source) => <span class="tag">{source().surface}</span>}</Show>
                <time datetime={isoTime(s().updatedAt)}>{relativeTime(s().updatedAt, now())}</time>
              </span>
            </a>
          )}
        </For>
      )}
    </Show>
  );
}
